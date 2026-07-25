/* providers/index.js — the facade the rest of the app talks to. It AUTO-ROUTES
   each symbol to a provider that actually covers its asset class (equity / fx /
   crypto), honoring the user's global provider choice where that provider can
   serve the class and falling back by preference otherwise. Quotes are GROUPED
   by resolved provider, so each provider gets ONE batched call for all of its
   symbols. Profiles/series are cached through the store to conserve free-tier
   budget. Adding a provider is a new module behind base.js — never a UI change. */

import { get } from './base.js';
import { classify } from './assetclass.js';
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

  async marketStatus() {
    // Equity-market status from whichever equity provider is active.
    const id = this._route('AAAA', PREF);
    return get(id).marketStatus().catch(() => null);
  },

  async validate(id) { this.syncKeys(); const p = get(id); return p && p.validate ? p.validate() : false; },
};
