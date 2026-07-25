/* providers/index.js — the facade the rest of the app talks to. Picks the active
   provider(s) from whichever keys exist, routes quotes/series/profile/search to
   the right adapter, and caches profiles (~forever) and series (~10 min) through
   the store to conserve free-tier budget. */

import { get } from './base.js';
import './demo.js';
import { setFinnhubKey } from './finnhub.js';
import { setTwelveDataKey } from './twelvedata.js';
import './twelvedata.js';
import { store } from '../store.js';

const SERIES_TTL = 10 * 60 * 1000;

export const market = {
  // Which adapters are live, given keys + the user's explicit provider choice.
  resolve() {
    const s = store.settings;
    const hasF = !!s.finnhubKey, hasT = !!s.twelvedataKey;
    setFinnhubKey(s.finnhubKey); setTwelveDataKey(s.twelvedataKey);

    if (s.provider === 'demo' || (!hasF && !hasT)) return { quoteId: 'demo', seriesId: 'demo', mode: 'demo' };
    if (s.provider === 'finnhub' && hasF) return { quoteId: 'finnhub', seriesId: hasT ? 'twelvedata' : 'demo', mode: 'finnhub' };
    if (s.provider === 'twelvedata' && hasT) return { quoteId: 'twelvedata', seriesId: 'twelvedata', mode: 'twelvedata' };
    // auto
    if (hasF) return { quoteId: 'finnhub', seriesId: hasT ? 'twelvedata' : 'demo', mode: 'live' };
    return { quoteId: 'twelvedata', seriesId: 'twelvedata', mode: 'live' };
  },

  modeLabel() {
    const r = this.resolve();
    if (r.mode === 'demo') return { text: 'DEMO', live: false };
    const q = get(r.quoteId);
    return { text: 'LIVE · ' + (q ? q.label : r.quoteId), live: true };
  },

  async quotes(symbols) {
    if (!symbols.length) return {};
    const { quoteId } = this.resolve();
    return get(quoteId).quote(symbols);
  },

  async profile(sym) {
    if (store.profiles[sym]) return store.profiles[sym];
    const { quoteId } = this.resolve();
    const p = await get(quoteId).profile(sym).catch(() => null)
      || await get('demo').profile(sym).catch(() => null);
    if (p) store.cacheProfile(sym, p);
    return p;
  },

  async series(sym, range) {
    // The card sparkline (no range) is cached; detail-drawer ranges are fetched fresh.
    if (!range) {
      const c = store.series[sym];
      if (c && Date.now() - c.ts < SERIES_TTL && c.points?.length) return c.points;
    }
    const { seriesId } = this.resolve();
    let pts = await get(seriesId).series(sym, range).catch(() => []);
    if (!pts.length) pts = await get('demo').series(sym, range).catch(() => []);
    if (!range && pts.length) store.cacheSeries(sym, pts);
    return pts;
  },

  async search(q) {
    const { quoteId } = this.resolve();
    return get(quoteId).search(q).catch(() => get('demo').search(q));
  },

  async marketStatus() {
    const { quoteId } = this.resolve();
    return get(quoteId).marketStatus().catch(() => null);
  },

  async validate(id) {
    const p = get(id);
    return p && p.validate ? p.validate() : false;
  },
};
