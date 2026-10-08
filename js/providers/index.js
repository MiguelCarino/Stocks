/* providers/index.js — the facade the rest of the app talks to. It AUTO-ROUTES
   each symbol to a provider that actually covers its asset class (equity / fx /
   crypto), honoring the user's global provider choice where that provider can
   serve the class and falling back by preference otherwise. Quotes are GROUPED
   by resolved provider, so each provider gets ONE batched call for all of its
   symbols. Adding a provider is a new module behind base.js — never a UI change.

   WHAT IT SERVES
     quotes(symbols)                    normalized quotes (base.js normQuote)
     candles(sym, {interval, range})    OHLCV bars + provenance (see below)
     series(sym, range?)                closes only, for sparklines (built on candles)
     fundamentals(sym)                  ratios / 52w range / shares — or null
     news(sym, {limit})                 headlines, newest first
     events(sym)                        earnings, dividends, splits
     calendar({from, to})               market-wide earnings (+ IPOs where free)
     profile(sym), search(q), marketStatus(), limits(), forecast(), errors()

   PROVENANCE. Live data is never silently replaced by sample data. A candles
   result names its source; when a live provider fails and the demo generator
   stands in, the result says isDemo: true and carries the live error, so the
   chart can show a "Demo data" chip. Sparklines, which cannot show a chip, get
   nothing instead. Fundamentals, news and events never fall back to samples in
   live mode at all — a fabricated P/E presented next to a real price is worse
   than a blank.

   CACHES. Bars in stk_candles (keyed sym|interval|range|source, TTL about one
   bar, 40 entries LRU). Fundamentals (6 h), news (10 min), events (12 h) and
   calendars (1 h) in stk_meta. Demo output is never written to either: it is
   free to regenerate, and caching it under a live key is how fake candles used
   to outlive the API key that should have replaced them. A failed refresh
   serves the last good bars marked stale before it considers anything else.

   marketStatus() was inverted here. It used to be the answer, fetched fresh from
   the provider on every render — an unbudgeted HTTP request every fifteen
   seconds to learn a fact that changes four times a day and is fully derivable
   from a clock. The local calendar in session.js is now the answer, and the
   provider is a corroborator polled at most once every fifteen minutes. That
   demotion is not just a saving: the two things it can still tell us are an
   unscheduled halt and a holiday the local table does not know about, and both
   only show up as a DISAGREEMENT. So the disagreement is reported rather than
   resolved — silently preferring either side would discard the signal. */

import { get, all, budget, pacer, LIMITS, normBars, errorKind, apiError } from './base.js';
import { classify, setClassOverrides, fxPair } from './assetclass.js';
import {
  RANGES, INTERVALS, rangeSpec, defaultInterval, isInterval, isIntraday, coarserIntervals,
  trimToRange, regularSessionOnly, candleCache, metaCache, candleTTL, createLRU,
} from './candles.js';
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

export { RANGES, INTERVALS, LIMITS };

const SERIES_TTL = 10 * 60 * 1000;
const STATUS_TTL = 15 * 60 * 1000;
const PROFILE_TTL = 7 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const META_TTL = { f: 6 * HOUR, n: 10 * 60 * 1000, e: 12 * HOUR, c: HOUR };

// Per-class provider preference, best first. Only AVAILABLE (key present or
// keyless) providers that declare support for the class are eligible.
const PREF = {
  equity: ['finnhub', 'polygon', 'alpaca', 'twelvedata', 'alphavantage', 'demo'],
  crypto: ['coingecko', 'twelvedata', 'alphavantage', 'demo'],
  fx: ['twelvedata', 'alphavantage', 'demo'],
};
// Candles: Finnhub has no free candles, so it is absent. Twelve Data first for
// equities because it serves every interval with real-time-ish US data on the
// free plan; Polygon's free data is delayed; Alpaca's is IEX-only; Alpha
// Vantage has no free intraday at all.
const CANDLES_PREF = {
  equity: ['twelvedata', 'polygon', 'alpaca', 'alphavantage'],
  crypto: ['coingecko', 'twelvedata', 'alphavantage'],
  fx: ['twelvedata', 'alphavantage'],
};
const FUND_PREF = {
  equity: ['finnhub', 'alphavantage', 'polygon', 'twelvedata'],
  crypto: ['coingecko'],
  fx: [],
};
const NEWS_PREF = {
  equity: ['finnhub', 'polygon', 'alpaca', 'alphavantage'],
  crypto: ['finnhub', 'alphavantage'],
  fx: ['alphavantage'],
};
// Which parts of events() each source can fill. Sources are consulted in order
// and only while a part they can fill is still empty, so Alpha Vantage's 25/day
// is spent only when Finnhub had no earnings.
const EVENT_SOURCES = [
  ['finnhub', ['earnings']],
  ['polygon', ['dividends', 'splits']],
  ['alphavantage', ['earnings']],
];
const CAL_PREF = ['finnhub', 'alphavantage'];
const PROFILE_PREF = { equity: ['finnhub', 'polygon'], crypto: ['coingecko'], fx: [] };
const SEARCH_PREF = ['finnhub', 'polygon', 'twelvedata', 'alphavantage'];

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
function has(id, method) { const p = get(id); return !!(p && typeof p[method] === 'function'); }

// Live error ledger per provider, for a settings/status panel: the newest
// failure of each kind, so "key rejected" is not lost under a later timeout.
const lastErrors = {};
function noteError(id, e) {
  if (!id || !e) return;
  const kind = errorKind(e);
  lastErrors[id] = { kind, message: String(e.message || kind), at: Date.now(), daily: !!e.daily };
}
function noteOk(id) { if (lastErrors[id] && lastErrors[id].kind !== 'authError') delete lastErrors[id]; }

/* ---- Class overrides --------------------------------------------------------
   A bare ticker the user picked from CoinGecko search before the collision rule
   (assetclass.js) existed — LINK, GRT — is a coin to them. Its cached profile
   says so (exchange 'Crypto'), so that is turned into an override and the entry
   keeps routing to CoinGecko with no migration. settings.classOverrides, when
   the app adds one, wins over both. */

let overrideSig = '';
function syncOverrides() {
  const profiles = store.profiles || {};
  const explicit = (store.settings && store.settings.classOverrides) || {};
  const sig = Object.keys(profiles).length + '|' + JSON.stringify(explicit);
  if (sig === overrideSig) return;
  overrideSig = sig;
  const map = {};
  for (const sym of Object.keys(profiles)) { const p = profiles[sym]; if (p && p.exchange === 'Crypto') map[sym] = 'crypto'; }
  Object.assign(map, explicit);
  setClassOverrides(map);
}

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

/* ---- Candle planning --------------------------------------------------------
   An ordered list of (provider, interval) attempts. The requested interval on
   every capable provider comes first; only if none can serve it do coarser
   intervals from the range's own list get a turn (1M of hourly bars on an
   Alpha-Vantage-only setup becomes 1M of daily bars, and says so). */

function intervalsOf(id, cls, range) {
  const p = get(id);
  if (!p || typeof p.candles !== 'function') return [];
  const iv = typeof p.candleIntervals === 'function' ? p.candleIntervals(cls, range) : p.candleIntervals;
  return Array.isArray(iv) ? iv : [];
}

function candleProviders(cls, prefer) {
  const ids = (CANDLES_PREF[cls] || CANDLES_PREF.equity).filter((id) => available(id) && supports(id, cls) && has(id, 'candles'));
  // An explicit global provider choice goes first when it can serve the class.
  if (prefer && prefer !== 'auto' && ids.includes(prefer)) return [prefer, ...ids.filter((x) => x !== prefer)];
  return ids;
}

function planCandles(cls, interval, range) {
  const ids = candleProviders(cls, store.settings.provider);
  const spec = rangeSpec(range);
  const order = [interval, ...(spec && spec.fallback ? [spec.fallback] : []), ...coarserIntervals(interval).filter((x) => !spec || spec.intervals.includes(x))];
  const plan = [];
  const seen = new Set();
  for (const iv of order) for (const id of ids) {
    if (!intervalsOf(id, cls, range).includes(iv)) continue;
    const k = id + '|' + iv;
    if (!seen.has(k)) { seen.add(k); plan.push({ id, interval: iv }); }
  }
  return plan;
}

function unwrapBars(raw) {
  if (Array.isArray(raw)) return { bars: raw, partial: false, note: null };
  if (raw && Array.isArray(raw.bars)) return { bars: raw.bars, partial: !!raw.partial, note: raw.note || null };
  return { bars: [], partial: false, note: null };
}

function provMeta(id) {
  const p = get(id);
  const m = (p && p.meta) || {};
  return { adjusted: m.adjusted || null, feed: m.feed || null, delayed: m.delayed || null };
}

// Demo bars are regenerated, not persisted; this keeps a minute's worth in
// memory so a chart, its compare overlay and a screener share one generation.
const demoMemo = createLRU(null, { max: 40 });
const pendingCandles = new Map();
const pendingMeta = new Map();
const searchMemo = new Map();   // q -> { at, results } (CoinGecko half only)
const profileTried = new Map(); // sym -> ms of the last background refresh attempt

function dedupe(map, key, fn) {
  if (map.has(key)) return map.get(key);
  const p = Promise.resolve().then(fn);
  map.set(key, p);
  p.then(() => map.delete(key), () => map.delete(key));
  return p;
}

let keySig = null;

export const market = {
  // Push the current keys into each adapter module. Cheap when nothing changed
  // (one string compare), so routing can call it freely.
  syncKeys() {
    const s = store.settings;
    const sig = [s.finnhubKey, s.twelvedataKey, s.polygonKey, s.alpacaKeyId, s.alpacaSecret, s.alphaVantageKey].join('\u0000');
    syncOverrides();
    if (sig === keySig) return;
    keySig = sig;
    setFinnhubKey(s.finnhubKey); setTwelveDataKey(s.twelvedataKey);
    setPolygonKey(s.polygonKey); setAlpacaKeys(s.alpacaKeyId, s.alpacaSecret);
    setAlphaVantageKey(s.alphaVantageKey);
  },

  hasAnyKey() {
    const s = store.settings;
    return !!(s.finnhubKey || s.twelvedataKey || s.polygonKey || s.alphaVantageKey || (s.alpacaKeyId && s.alpacaSecret));
  },

  // True when everything is served by the sample generator.
  isDemoMode() { return store.settings.provider === 'demo' || !this.hasAnyKey(); },

  routeQuote(sym) { return this._route(sym, PREF); },
  // The provider a default candles request would try first (the drawer shows it).
  routeSeries(sym) {
    this.syncKeys();
    if (this.isDemoMode()) return 'demo';
    const plan = planCandles(classify(sym), '5m', '1D');
    return plan.length ? plan[0].id : 'demo';
  },

  _route(sym, prefTable) {
    this.syncKeys();
    const s = store.settings;
    const cls = classify(sym);
    if (this.isDemoMode()) return 'demo';
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
    if (this.isDemoMode()) return { text: 'DEMO', live: false };
    if (s.provider !== 'auto' && available(s.provider)) {
      const p = get(s.provider);
      return { text: 'LIVE · ' + (p ? p.label : s.provider), live: true };
    }
    return { text: 'LIVE · Auto', live: true };
  },

  async quotes(symbols) {
    if (!symbols.length) return {};
    this.syncKeys();
    // Group by resolved provider → one batched call per provider for its symbols.
    const groups = new Map();
    for (const sym of symbols) {
      const id = this.routeQuote(sym);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(sym);
    }
    const out = {};
    const entries = [...groups.entries()];
    const settled = await Promise.allSettled(entries.map(([id, syms]) => get(id).quote(syms)));
    const failures = [];
    settled.forEach((r, i) => {
      const id = entries[i][0];
      if (r.status === 'fulfilled') { Object.assign(out, r.value || {}); noteOk(id); }
      else { noteError(id, r.reason); failures.push(r.reason); }
    });
    // Only bubble a failure if it left us with nothing; a partial result from
    // the other provider groups is still worth rendering. A 429 wins so the
    // scheduler backs off; otherwise the first typed error (bad key, network)
    // so the app can say which.
    if (!Object.keys(out).length && failures.length) {
      const rl = failures.find((e) => e && e.rateLimited);
      if (rl) { const e = new Error('rate-limited'); e.rateLimited = true; e.kind = 'rateLimited'; e.daily = !!rl.daily; throw e; }
      throw failures[0] instanceof Error ? failures[0] : apiError('error', 'Quote fetch failed');
    }
    return out;
  },

  /* ---- Bars ------------------------------------------------------------------
     -> { bars, source, interval, range, isDemo, partial, stale, note, error,
          requestedInterval, adjusted, feed, delayed }
     opts: interval, range, extended (keep pre/post-market bars), priority
     (0 background · 1 normal · 2 visible chart, the default), maxWait (ms in the
     pacer queue), force (skip the fresh-cache check), allowDemo (default true:
     fall back to the generator, flagged isDemo). */
  async candles(sym, opts = {}) {
    let { interval, range = '1D', extended = false, priority = 2, maxWait, force = false, allowDemo = true, cacheOnly = false } = opts;
    if (!rangeSpec(range)) range = '1D';
    if (!isInterval(interval)) interval = defaultInterval(range);
    this.syncKeys();
    const cls = classify(sym);
    const base = { range, requestedInterval: interval };

    if (this.isDemoMode()) return this._demoCandles(sym, interval, range, base, null);

    const plan = planCandles(cls, interval, range);
    let lastErr = null;
    // A provider that THREW (bad key, offline, throttled) is not asked again at
    // a coarser interval — that would only spend more of its quota on the same
    // failure. One that merely returned no bars still gets its coarser turn.
    const failed = new Set();
    for (const step of plan) {
      if (failed.has(step.id)) continue;
      const key = [sym, step.interval, range, step.id, extended ? 'x' : ''].join('|');
      const cached = candleCache.get(key);
      // cacheOnly: a window that must not spend credits (a popout) takes any
      // cached copy, marked stale when it is past its TTL, and never fetches.
      if (cacheOnly) {
        if (cached && cached.bars.length) {
          const old = Date.now() - cached.at >= candleTTL(step.interval);
          return { ...base, bars: cached.bars, source: step.id, interval: step.interval, isDemo: false, partial: cached.partial, note: cached.note, stale: old, error: null, cachedAt: cached.at, ...provMeta(step.id) };
        }
        continue;
      }
      if (cached && !force && Date.now() - cached.at < candleTTL(step.interval) && cached.bars.length) {
        return { ...base, bars: cached.bars, source: step.id, interval: step.interval, isDemo: false, partial: cached.partial, note: cached.note, stale: false, error: null, cachedAt: cached.at, ...provMeta(step.id) };
      }
      try {
        const res = await dedupe(pendingCandles, key, async () => {
          const raw = await get(step.id).candles(sym, { interval: step.interval, range, extended, priority, maxWait });
          let { bars, partial, note } = unwrapBars(raw);
          bars = normBars(bars);
          // Polygon and Alpaca include extended hours in intraday aggregates.
          if (!extended && cls === 'equity' && isIntraday(step.interval) && (step.id === 'polygon' || step.id === 'alpaca')) bars = regularSessionOnly(bars);
          bars = trimToRange(bars, range, cls, step.interval);
          if (bars.length) candleCache.set(key, { at: Date.now(), src: step.id, interval: step.interval, partial, note, bars });
          return { bars, partial, note };
        });
        noteOk(step.id);
        if (!res.bars.length) { lastErr = lastErr || apiError('error', 'No bars returned by ' + step.id); continue; }
        return { ...base, bars: res.bars, source: step.id, interval: step.interval, isDemo: false, partial: res.partial, note: res.note, stale: false, error: null, ...provMeta(step.id) };
      } catch (e) {
        noteError(step.id, e);
        failed.add(step.id);
        lastErr = e;
        // The last good bars from this provider beat both another provider's
        // credit and sample data. Marked stale so the chart can say so.
        if (cached && cached.bars.length) {
          return { ...base, bars: cached.bars, source: step.id, interval: step.interval, isDemo: false, partial: cached.partial, note: cached.note, stale: true, error: String(e.message || errorKind(e)), errorKind: errorKind(e), cachedAt: cached.at, ...provMeta(step.id) };
        }
      }
    }
    if (cacheOnly) return { ...base, bars: [], source: null, interval, isDemo: false, partial: false, stale: false, note: null, error: 'Not cached in this browser yet', errorKind: 'notCached' };
    const why = lastErr ? String(lastErr.message || errorKind(lastErr)) : (plan.length ? 'No data' : 'No connected provider serves bars for this symbol');
    if (allowDemo) return this._demoCandles(sym, interval, range, base, why, lastErr ? errorKind(lastErr) : 'unsupported');
    return { ...base, bars: [], source: null, interval, isDemo: false, partial: false, stale: false, note: null, error: why, errorKind: lastErr ? errorKind(lastErr) : 'unsupported' };
  },

  async _demoCandles(sym, interval, range, base, error, kind) {
    const key = [sym, interval, range, Math.floor(Date.now() / 30000)].join('|');
    let bars = demoMemo.get(key);
    if (!bars) { bars = normBars(await get('demo').candles(sym, { interval, range }).catch(() => [])); demoMemo.set(key, bars); }
    return { ...base, bars, source: 'demo', interval, isDemo: true, partial: false, stale: false, note: null, error: error || null, errorKind: error ? (kind || 'error') : null, adjusted: null, feed: null, delayed: null };
  },

  // Closes only, for sparklines and the legacy drawer. No range = the card
  // sparkline: served from store.series when fresh, and when stale the old
  // points are returned at once while a background refresh runs — a tick must
  // never wait in a free-tier queue for a 40-pixel line. Legacy ranges keep
  // their old meaning (1D = 5-minute, 1M = daily, 1Y = weekly).
  async series(sym, range) {
    const demo = this.isDemoMode();
    const legacy = { '1D': { range: '1D' }, '1M': { range: '1M', interval: '1d' }, '1Y': { range: '1Y', interval: '1w' } };
    const req = legacy[range || '1D'] || { range };
    if (!range) {
      const c = store.series[sym];
      const fresh = c && Date.now() - c.ts < SERIES_TTL && c.points?.length;
      if (fresh) return c.points;
      const refresh = () => this.candles(sym, { ...req, priority: 0, maxWait: c && c.points?.length ? 60000 : 8000, allowDemo: demo }).then((r) => {
        const pts = r.bars.map((b) => b.c);
        // Sample points are cached only in demo mode — never as a live sparkline.
        if (pts.length && (!r.isDemo || demo) && !r.stale) store.cacheSeries(sym, pts);
        return pts;
      });
      if (c && c.points?.length) { dedupe(pendingMeta, 'spark|' + sym, refresh).catch(() => {}); return c.points; }
      return dedupe(pendingMeta, 'spark|' + sym, refresh).catch(() => []);
    }
    const r = await this.candles(sym, { ...req, priority: 2, allowDemo: demo });
    return r.bars.map((b) => b.c);
  },

  /* ---- Fundamentals / news / events / calendar ---------------------------- */

  // Shared cache-then-providers walk for the meta endpoints.
  async _meta(kind, key, ids, call, isEmpty, { force = false, cacheOnly = false } = {}) {
    this.syncKeys();
    const demo = this.isDemoMode();
    if (demo) return call('demo');
    const ck = kind + '|' + key;
    const hit = metaCache.get(ck);
    if (cacheOnly) return hit ? hit.v : null;
    if (hit && !force && Date.now() - hit.at < META_TTL[kind]) return hit.v;
    return dedupe(pendingMeta, ck, async () => {
      let lastErr = null;
      for (const id of ids) {
        if (!available(id)) continue;
        try {
          const v = await call(id);
          noteOk(id);
          if (!isEmpty(v)) { metaCache.set(ck, { at: Date.now(), src: id, v }); return v; }
        } catch (e) { noteError(id, e); lastErr = e; }
      }
      // Everyone failed: an older answer is still the best answer.
      if (hit) return hit.v;
      return null;
    });
  },

  async fundamentals(sym, opts = {}) {
    const cls = classify(sym);
    const ids = (FUND_PREF[cls] || []).filter((id) => has(id, 'fundamentals'));
    const f = await this._meta('f', sym, ids, (id) => get(id).fundamentals(sym), (v) => !v, opts).catch(() => null);
    return f ? fillFromBars(sym, { ...f }) : null;
  },

  async news(sym, { limit = 10, force = false, cacheOnly = false } = {}) {
    const cls = classify(sym);
    const ids = (NEWS_PREF[cls] || []).filter((id) => has(id, 'news'));
    const v = await this._meta('n', sym + '|' + limit, ids, (id) => get(id).news(sym, { limit }), (x) => !Array.isArray(x) || !x.length, { force, cacheOnly }).catch(() => null);
    return Array.isArray(v) ? v.slice().sort((a, b) => b.t - a.t).slice(0, limit) : [];
  },

  async events(sym, { force = false, cacheOnly = false } = {}) {
    const empty = () => ({ earnings: [], dividends: [], splits: [] });
    this.syncKeys();
    if (this.isDemoMode()) return (await get('demo').events(sym).catch(() => null)) || empty();
    if (classify(sym) !== 'equity') return empty();
    const ck = 'e|' + sym;
    const hit = metaCache.get(ck);
    if (cacheOnly) return hit ? hit.v : empty();
    if (hit && !force && Date.now() - hit.at < META_TTL.e) return hit.v;
    return dedupe(pendingMeta, ck, async () => {
      const out = empty();
      let anyOk = false;
      for (const [id, parts] of EVENT_SOURCES) {
        if (!available(id) || !has(id, 'events')) continue;
        if (!parts.some((k) => !out[k].length)) continue;
        try {
          const r = await get(id).events(sym);
          anyOk = true; noteOk(id);
          for (const k of parts) if (!out[k].length && r && Array.isArray(r[k])) out[k] = r[k];
        } catch (e) { noteError(id, e); }
      }
      if (anyOk) metaCache.set(ck, { at: Date.now(), v: out });
      else if (hit) return hit.v;
      return out;
    });
  },

  async calendar({ from, to, force = false, cacheOnly = false } = {}) {
    const ids = CAL_PREF.filter((id) => has(id, 'calendar'));
    const v = await this._meta('c', (from || '') + '|' + (to || ''), ids, (id) => get(id).calendar({ from, to }), (x) => !x || !Array.isArray(x.earnings), { force, cacheOnly }).catch(() => null);
    return v || { earnings: [], ipos: [] };
  },

  /* ---- Profile / search ------------------------------------------------------ */

  // Cached profile, refreshed in the background after a week, and replaced as
  // soon as possible when it came from the demo bundle and a key is now set.
  async profile(sym) {
    this.syncKeys();
    const cached = store.profiles[sym];
    const demo = this.isDemoMode();
    const stale = !cached || !cached._at || Date.now() - cached._at > PROFILE_TTL || (!demo && cached._src === 'demo');
    if (cached && !stale) return cached;
    if (cached) {
      // Stale-while-revalidate, at most one attempt per symbol per six hours so
      // a profile nobody live can supply does not cost a call per render.
      const last = profileTried.get(sym) || 0;
      if (Date.now() - last > 6 * HOUR) { profileTried.set(sym, Date.now()); dedupe(pendingMeta, 'p|' + sym, () => this._fetchProfile(sym, demo)).catch(() => {}); }
      return cached;
    }
    return dedupe(pendingMeta, 'p|' + sym, () => this._fetchProfile(sym, demo)).catch(() => null);
  },

  async _fetchProfile(sym, demo) {
    const cls = classify(sym);
    if (cls === 'fx') {
      const [a, b] = fxPair(sym);
      const p = { symbol: sym, name: `${a} / ${b}`, exchange: 'FX', sector: 'Currency', currency: b, marketCap: 0, logo: '', _at: Date.now(), _src: 'local' };
      store.cacheProfile(sym, p);
      return p;
    }
    const ids = demo ? ['demo'] : [...(PROFILE_PREF[cls] || []).filter((id) => available(id)), 'demo'];
    for (const id of ids) {
      if (!has(id, 'profile')) continue;   // Twelve Data / Alpha Vantage have none; this used to throw past the fallback
      try {
        const p = await get(id).profile(sym);
        if (p) { const rec = { ...p, _at: Date.now(), _src: id }; store.cacheProfile(sym, rec); return rec; }
      } catch (e) { noteError(id, e); }
    }
    return store.profiles[sym] || null;
  },

  async search(q) {
    this.syncKeys();
    q = String(q || '').trim();
    if (!q) return [];
    const demo = this.isDemoMode();
    // The equity search goes to a provider that HAS one — routing it through the
    // quote provider left Alpaca users (search returns []) with no search at all.
    const eqId = demo ? 'demo' : (SEARCH_PREF.find((id) => available(id) && has(id, 'search')) || 'demo');
    const results = [], seen = new Set();
    const push = (arr) => { for (const r of (arr || [])) { if (r && r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); results.push(r); } } };
    const eq = await get(eqId).search(q).catch(() => []);
    push(eq);
    // CoinGecko only when the equity side came back thin or the query looks
    // like a coin — not on every keystroke — and memoized per query. Never in
    // Demo mode: demo makes no network calls at all, and a coin found live could
    // not be quoted there anyway.
    const Q = q.toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    if (!demo && q.length >= 2 && ((eq || []).length < 6 || classify(Q) === 'crypto')) {
      let cg;
      const m = searchMemo.get(Q);
      if (m && Date.now() - m.at < 10 * 60 * 1000) cg = m.results;
      else {
        cg = await get('coingecko').search(q).catch(() => []);
        searchMemo.set(Q, { at: Date.now(), results: cg });
        if (searchMemo.size > 100) searchMemo.delete(searchMemo.keys().next().value);
      }
      // A coin ticker the router would read as a stock (LINK, DASH, or any coin
      // outside the short bare-ticker list) is offered in its explicit form.
      push((cg || []).map((r) => {
        const S = String(r.symbol || '').toUpperCase();
        const sym = classify(S) === 'crypto' ? S : S + '-USD';
        return { symbol: sym, description: r.description };
      }));
    }
    if (!results.length && eqId !== 'demo') push(await get('demo').search(q).catch(() => []));
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

  /* ---- Quota ---------------------------------------------------------------- */

  // Published free-tier limits and current usage per provider, for a quota
  // meter. usedMin/usedDay count CREDITS as the pacer charges them (a Twelve
  // Data batch of 6 symbols is 6); usedHour is HTTP requests from the budget.
  limits() {
    this.syncKeys();
    const stats = budget.stats();
    return all().map((p) => {
      const L = LIMITS[p.id] || {};
      const u = pacer.usage(p.id);
      const b = stats.byProvider[p.id] || { lastMin: 0, lastHour: 0 };
      return {
        id: p.id, label: p.label, available: available(p.id), needsKey: !!p.needsKey,
        perMin: L.perMin ?? null, perDay: L.perDay ?? null, perSec: L.perSec ?? null, note: L.note || '',
        usedMin: u.usedMin, usedDay: u.usedDay, usedHour: b.lastHour,
        remainingDay: L.perDay ? Math.max(0, L.perDay - u.usedDay) : null,
        queued: u.queued, cooldownUntil: u.cooldownUntil,
        lastError: lastErrors[p.id] || null,
      };
    });
  },

  // ms before `n` more calls could complete on a provider (Infinity = not
  // today). For "this scan needs ~38 calls, about 8 minutes" estimates.
  forecast(providerId, n = 1) { return pacer.forecast(providerId, n); },

  // The candle provider a symbol would use — so a screener can forecast against it.
  routeCandles(sym, interval = '1d', range = '1Y') {
    this.syncKeys();
    if (this.isDemoMode()) return 'demo';
    const plan = planCandles(classify(sym), interval, range);
    return plan.length ? plan[0].id : null;
  },

  // { providerId: { kind, message, at, daily } } — newest failure per provider.
  errors() { return { ...lastErrors }; },

  // Drop every provider cache (bars + meta). For a "clear cached market data" button.
  clearCaches() { candleCache.clear(); metaCache.clear(); },
  // Re-read both caches from storage on next access (another window wrote them).
  reloadCaches() { candleCache.reload(); metaCache.reload(); },
};

// Fill 52-week figures and average volumes a provider left null from daily
// bars ALREADY in the cache (any source). Never fetches.
function fillFromBars(sym, f) {
  if (f.high52 != null && f.low52 != null && f.avgVolume3m != null) return f;
  let bars = null;
  for (const id of ['twelvedata', 'polygon', 'alpaca', 'alphavantage', 'coingecko']) {
    const c = candleCache.peek([sym, '1d', '1Y', id, ''].join('|'));
    if (c && c.bars && c.bars.length > 150) { bars = c.bars; break; }
  }
  if (!bars) return f;
  if (f.high52 == null || f.low52 == null) {
    let hi = bars[0], lo = bars[0];
    for (const b of bars) { if (b.h > hi.h) hi = b; if (b.l < lo.l) lo = b; }
    if (f.high52 == null) { f.high52 = hi.h; f.high52Date = new Date(hi.t).toISOString().slice(0, 10); }
    if (f.low52 == null) { f.low52 = lo.l; f.low52Date = new Date(lo.t).toISOString().slice(0, 10); }
  }
  const avg = (n) => { const v = bars.slice(-n).map((b) => b.v).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  if (f.avgVolume10d == null) f.avgVolume10d = avg(10);
  if (f.avgVolume3m == null) f.avgVolume3m = avg(63);
  return f;
}

// Re-exported so the settings UI can read the call budget without reaching past
// the facade into base.js.
export { budget };
