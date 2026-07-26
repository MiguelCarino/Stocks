/* providers/index.js — the facade the rest of the app talks to. It AUTO-ROUTES
   each symbol to a provider that actually covers its asset class (equity / fx /
   crypto), honoring the user's global provider choice where that provider can
   serve the class and falling back by preference otherwise. Quotes are GROUPED
   by resolved provider, so each provider gets ONE batched call for all of its
   symbols. Profiles/series are cached through the store to conserve free-tier
   budget. Adding a provider is a new module behind base.js — never a UI change.

   marketStatus() was inverted here. It used to be the answer, fetched fresh from
   the provider on every render — an unbudgeted HTTP request every fifteen
   seconds to learn a fact that changes four times a day and is fully derivable
   from a clock. The local calendar in session.js is now the answer, and the
   provider is a corroborator polled at most once every fifteen minutes. That
   demotion is not just a saving: the two things it can still tell us are an
   unscheduled halt and a holiday the local table does not know about, and both
   only show up as a DISAGREEMENT. So the disagreement is reported rather than
   resolved — silently preferring either side would discard the signal. */

import { get, budget } from './base.js';
import { classify } from './assetclass.js';
import { sessionAt } from '../session.js';
import './demo.js';
import { setFinnhubKey } from './finnhub.js';
import './finnhub.js';
import { setTwelveDataKey } from './twelvedata.js';
import './twelvedata.js';
import './coingecko.js';
import { setPolygonKey } from './polygon.js';
import './polygon.js';
import { setAlpacaKeys } from './alpaca.js';
import './alpaca.js';
import { setAlphaVantageKey } from './alphavantage.js';
import './alphavantage.js';
import { store } from '../store.js';

const SERIES_TTL = 10 * 60 * 1000;
const STATUS_TTL = 15 * 60 * 1000;

// Per-class provider preference, best first. Only AVAILABLE (key present or
// keyless) providers that declare support for the class are eligible.
const PREF = {
  equity: ['finnhub', 'polygon', 'alpaca', 'twelvedata', 'alphavantage', 'demo'],
  crypto: ['coingecko', 'twelvedata', 'alphavantage', 'demo'],
  fx: ['twelvedata', 'alphavantage', 'demo'],
};
// Series/candles: Finnhub has no free candles, so it's absent here.
const SERIES_PREF = {
  equity: ['twelvedata', 'polygon', 'alpaca', 'alphavantage', 'demo'],
  crypto: ['coingecko', 'twelvedata', 'demo'],
  fx: ['twelvedata', 'alphavantage', 'demo'],
};

function available(id) {
  const s = store.settings;
  switch (id) {
    case 'finnhub': return !!s.finnhubKey;
    case 'twelvedata': return !!s.twelvedataKey;
    case 'polygon': return !!s.polygonKey;
    case 'alpaca': return !!(s.alpacaKeyId && s.alpacaSecret);
    case 'alphavantage': return !!s.alphaVantageKey;
    case 'coingecko': return true;   // keyless
    case 'demo': return true;
    default: return false;
  }
}
function supports(id, cls) { const p = get(id); return !!(p && p.classes && p.classes.includes(cls)); }

/* ---- Market status: local truth, provider corroboration -------------------- */

// One cached provider report, keyed by the provider that produced it so a
// settings change invalidates it instead of attributing a stale answer.
let statusCache = null;     // { id, at, report: {...}|null }
let statusInflight = null;

function refreshStatus(id) {
  const fresh = statusCache && statusCache.id === id && (Date.now() - statusCache.at) < STATUS_TTL;
  if (fresh || statusInflight) return;
  const p = get(id);
  if (!p || typeof p.marketStatus !== 'function') { statusCache = { id, at: Date.now(), report: null }; return; }
  // Deliberately not awaited by the caller: marketStatus() sits on the render
  // path, and blocking a repaint on a provider round-trip is what made this a
  // per-tick request in the first place. The first call after a cold start
  // therefore returns local-only; the corroboration lands on a later render.
  statusInflight = Promise.resolve()
    .then(() => p.marketStatus())
    .catch(() => null)
    .then((report) => { statusCache = { id, at: Date.now(), report: report || null }; })
    .finally(() => { statusInflight = null; });
}

// Provider vocabulary is already normalized to 'pre'|'open'|'post'|'closed' by
// each adapter; this only has to reconcile it with the local session states.
function reconcile(local, provider) {
  let conflict = null, disagreement = null;
  if (provider) {
    const name = provider.label || provider.id;
    // A holiday name is only news on a day the local calendar expected trading.
    // On a Saturday it is agreement stated twice. An early close is the same
    // agreement in a different shape: the local calendar does list the day, it
    // simply reports it as a shortened session rather than a closure, and the
    // state on such a day is never 'holiday' — it walks open -> post -> closed.
    if (provider.holiday && !local.earlyClose && local.state !== 'holiday' && local.state !== 'weekend') {
      conflict = 'holiday-drift';
      disagreement = `${name} reports a market holiday (${provider.holiday}) that the local calendar does not list.`;
    } else if (provider.isOpen && !local.isOpen) {
      conflict = 'provider-open';
      disagreement = `${name} reports the market open; the local calendar says ${local.label.toLowerCase()}.`;
    } else if (!provider.isOpen && local.isOpen) {
      // The interesting direction: an unscheduled halt, or a closure the
      // holiday table has never heard of.
      conflict = 'provider-closed';
      disagreement = `${name} reports the market closed during scheduled regular hours — possible halt or unlisted closure.`;
    } else if (provider.session && provider.session !== local.state && local.isTradeable) {
      conflict = 'session-drift';
      disagreement = `${name} reports the ${provider.session} session; the local calendar says ${local.state}.`;
    }
  }
  return {
    // Local truth. app.js and the popouts read these directly.
    isOpen: local.isOpen, session: local.state, label: local.label, detail: local.detail,
    approx: local.approx, nextChange: local.nextChange, nextLabel: local.nextLabel, tz: local.tz,
    local,
    provider,                                     // null until a corroborator answers
    agrees: provider ? conflict === null : null,  // null means "nobody asked" — not "agrees"
    conflict, disagreement,
    checkedAt: provider ? provider.at : null,
  };
}

export const market = {
  // Push the current keys into each adapter module. Cheap; called before routing.
  syncKeys() {
    const s = store.settings;
    setFinnhubKey(s.finnhubKey); setTwelveDataKey(s.twelvedataKey);
    setPolygonKey(s.polygonKey); setAlpacaKeys(s.alpacaKeyId, s.alpacaSecret);
    setAlphaVantageKey(s.alphaVantageKey);
  },

  hasAnyKey() {
    const s = store.settings;
    return !!(s.finnhubKey || s.twelvedataKey || s.polygonKey || s.alphaVantageKey || (s.alpacaKeyId && s.alpacaSecret));
  },

  routeQuote(sym) { return this._route(sym, PREF); },
  routeSeries(sym) { return this._route(sym, SERIES_PREF); },

  _route(sym, prefTable) {
    this.syncKeys();
    const s = store.settings;
    const cls = classify(sym);
    if (s.provider === 'demo' || !this.hasAnyKey()) return 'demo';
    // Honor an explicit global choice when it can serve this class and is available.
    if (s.provider !== 'auto' && supports(s.provider, cls) && available(s.provider)) return s.provider;
    // Otherwise auto-pick by preference among available + supporting providers.
    for (const id of (prefTable[cls] || prefTable.equity)) {
      if (available(id) && supports(id, cls)) return id;
    }
    return 'demo';
  },

  modeLabel() {
    this.syncKeys();
    const s = store.settings;
    if (s.provider === 'demo' || !this.hasAnyKey()) return { text: 'DEMO', live: false };
    if (s.provider !== 'auto' && available(s.provider)) {
      const p = get(s.provider);
      return { text: 'LIVE · ' + (p ? p.label : s.provider), live: true };
    }
    return { text: 'LIVE · Auto', live: true };
  },

  async quotes(symbols) {
    if (!symbols.length) return {};
    // Group by resolved provider → one batched call per provider for its symbols.
    const groups = new Map();
    for (const sym of symbols) {
      const id = this.routeQuote(sym);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(sym);
    }
    const out = {};
    let rateLimited = false;
    const settled = await Promise.allSettled([...groups.entries()].map(([id, syms]) => get(id).quote(syms)));
    for (const r of settled) {
      if (r.status === 'fulfilled') Object.assign(out, r.value || {});
      else if (r.reason && r.reason.rateLimited) rateLimited = true;
    }
    // Only bubble a 429 (for scheduler backoff) if it left us with nothing; a
    // partial result from the other provider groups is still worth rendering.
    if (rateLimited && !Object.keys(out).length) { const e = new Error('rate-limited'); e.rateLimited = true; throw e; }
    return out;
  },

  async profile(sym) {
    if (store.profiles[sym]) return store.profiles[sym];
    const id = this.routeQuote(sym);
    const p = await get(id).profile(sym).catch(() => null) || await get('demo').profile(sym).catch(() => null);
    if (p) store.cacheProfile(sym, p);
    return p;
  },

  async series(sym, range) {
    // The card sparkline (no range) is cached; detail-drawer ranges fetch fresh.
    if (!range) {
      const c = store.series[sym];
      if (c && Date.now() - c.ts < SERIES_TTL && c.points?.length) return c.points;
    }
    const id = this.routeSeries(sym);
    let pts = await get(id).series(sym, range).catch(() => []);
    if (!pts.length) pts = await get('demo').series(sym, range).catch(() => []);
    if (!range && pts.length) store.cacheSeries(sym, pts);
    return pts;
  },

  async search(q) {
    // Search the active equity source plus CoinGecko (crypto), merged + de-duped.
    const eqId = this._route('AAAA', PREF);   // 'AAAA' classifies as equity
    const results = [], seen = new Set();
    const push = (arr) => { for (const r of (arr || [])) { if (r && r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); results.push(r); } } };
    const [eq, cg] = await Promise.all([
      get(eqId).search(q).catch(() => []),
      get('coingecko').search(q).catch(() => []),
    ]);
    push(eq); push(cg);
    if (!results.length) push(await get('demo').search(q).catch(() => []));
    return results.slice(0, 14);
  },

  // Async only for source compatibility with its callers — it resolves without
  // touching the network. Everything it returns is either local or already
  // cached; the refresh it may kick off lands on a later call.
  async marketStatus() {
    const id = this._route('AAAA', PREF);
    refreshStatus(id);
    const local = sessionAt(Date.now(), 'US_EQUITY');
    const snap = (statusCache && statusCache.id === id) ? statusCache : null;
    const p = get(id);
    const provider = snap && snap.report
      ? { id, label: (p && p.label) || id, isOpen: !!snap.report.isOpen, session: snap.report.session || null,
          holiday: snap.report.holiday || null, at: snap.at }
      : null;
    return reconcile(local, provider);
  },

  // For a "check now" control: drops the TTL so the next marketStatus() picks
  // up a fresh corroboration. Still costs exactly one request.
  refreshMarketStatus() { statusCache = null; refreshStatus(this._route('AAAA', PREF)); },

  async validate(id) { this.syncKeys(); const p = get(id); return p && p.validate ? p.validate() : false; },
};

// Re-exported so the settings UI can read the call budget without reaching past
// the facade into base.js.
export { budget };
