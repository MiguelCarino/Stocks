/* providers/polygon.js — Polygon.io adapter (US equities). One batched snapshot
   call covers the whole equity group; the free tier is rate-limited (~5 req/min)
   so getJSON surfaces HTTP 429 as rate-limited and the scheduler backs off. */

import { register, normQuote, getJSON, num } from './base.js';

const BASE = 'https://api.polygon.io';
let KEY = '';
export function setPolygonKey(k) { KEY = (k || '').trim(); }

function ymd(d) { return d.toISOString().slice(0, 10); }

register({
  id: 'polygon',
  label: 'Polygon',
  needsKey: true,
  classes: ['equity'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(symbols.join(','))}&apiKey=${KEY}`;
    const r = await getJSON(url);
    for (const t of (r.tickers || [])) {
      const sym = t.ticker;
      const day = t.day || {}, prev = t.prevDay || {}, last = t.lastTrade || {};
      const price = num(last.p) ?? num(day.c) ?? num(prev.c);
      out[sym] = normQuote(sym, {
        price, prevClose: num(prev.c), open: num(day.o), high: num(day.h), low: num(day.l),
        volume: num(day.v), change: num(t.todaysChange), changePct: num(t.todaysChangePerc), currency: 'USD',
      }, 'polygon');
    }
    return out;
  },

  async series(sym, range = '1D') {
    const to = new Date(), from = new Date();
    let mult = 5, span = 'minute';
    if (range === '1M') { mult = 1; span = 'day'; from.setDate(to.getDate() - 31); }
    else if (range === '1Y') { mult = 1; span = 'week'; from.setFullYear(to.getFullYear() - 1); }
    else { from.setDate(to.getDate() - 4); }   // 1D: last few sessions of 5-min bars
    const url = `${BASE}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${span}/${ymd(from)}/${ymd(to)}?adjusted=true&sort=asc&limit=5000&apiKey=${KEY}`;
    const r = await getJSON(url);
    if (!r || !Array.isArray(r.results)) return [];
    let pts = r.results.map((b) => num(b.c)).filter((n) => n != null);
    if (range === '1D' && pts.length > 90) pts = pts.slice(-78);
    return pts;
  },

  async profile(sym) {
    const r = await getJSON(`${BASE}/v3/reference/tickers/${encodeURIComponent(sym)}?apiKey=${KEY}`).catch(() => null);
    const d = r && r.results;
    if (!d) return null;
    return { symbol: sym, name: d.name || sym, exchange: d.primary_exchange || '', sector: d.sic_description || '',
             currency: d.currency_name ? d.currency_name.toUpperCase() : 'USD', marketCap: num(d.market_cap) || 0, logo: '' };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&limit=12&apiKey=${KEY}`).catch(() => null);
    return ((r && r.results) || []).map((x) => ({ symbol: x.ticker, description: x.name || '' }));
  },

  async marketStatus() {
    const r = await getJSON(`${BASE}/v1/marketstatus/now?apiKey=${KEY}`).catch(() => null);
    if (!r) return null;
    return { isOpen: r.market === 'open', session: r.market || 'closed' };
  },

  async validate() {
    const r = await getJSON(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL&apiKey=${KEY}`).catch(() => null);
    return !!(r && Array.isArray(r.tickers) && r.tickers.length);
  },
});
