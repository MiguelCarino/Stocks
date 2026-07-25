/* providers/twelvedata.js — Twelve Data adapter (free ~800 req/day, CORS-enabled).
   Primary source for sparklines + the detail-drawer line chart, and the batched
   fallback quote source when no Finnhub key is present. */

import { register, normQuote, getJSON, num } from './base.js';

const BASE = 'https://api.twelvedata.com';
let KEY = '';
export function setTwelveDataKey(k) { KEY = (k || '').trim(); }

const RANGE = {
  '1D': { interval: '5min', outputsize: 78 },
  '1M': { interval: '1day', outputsize: 22 },
  '1Y': { interval: '1week', outputsize: 52 },
};

register({
  id: 'twelvedata',
  label: 'Twelve Data',
  needsKey: true,
  hasSeries: true,

  async quote(symbols) {
    // One batched call for the whole watchlist (comma-separated).
    const r = await getJSON(`${BASE}/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${KEY}`);
    const out = {};
    const rows = symbols.length === 1 ? { [symbols[0]]: r } : r;
    for (const sym of symbols) {
      const q = rows[sym];
      if (!q || q.status === 'error' || q.close == null) continue;
      out[sym] = normQuote(sym, {
        price: q.close, prevClose: q.previous_close, open: q.open, high: q.high, low: q.low,
        volume: q.volume, changePct: q.percent_change, change: q.change, currency: q.currency,
      }, 'twelvedata');
    }
    return out;
  },

  async series(sym, range = '1D') {
    const cfg = RANGE[range] || RANGE['1D'];
    const r = await getJSON(`${BASE}/time_series?symbol=${encodeURIComponent(sym)}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&apikey=${KEY}`);
    if (!r || r.status === 'error' || !Array.isArray(r.values)) return [];
    // Twelve Data returns newest-first; the app wants oldest-first closes.
    return r.values.map((v) => num(v.close)).filter((n) => n != null).reverse();
  },

  async search(q) {
    const r = await getJSON(`${BASE}/symbol_search?symbol=${encodeURIComponent(q)}&apikey=${KEY}`);
    return (r.data || []).slice(0, 12).map((x) => ({ symbol: x.symbol, description: `${x.instrument_name} · ${x.exchange}` }));
  },

  async marketStatus() { return null; },

  async validate() {
    const r = await getJSON(`${BASE}/quote?symbol=AAPL&apikey=${KEY}`);
    return num(r.close) != null;
  },
});
