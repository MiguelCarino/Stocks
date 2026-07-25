/* providers/alpaca.js — Alpaca Market Data adapter (US equities), batched
   snapshots for the whole equity group in one call. Needs BOTH a key id and a
   secret. NOTE: Alpaca keys grant account access (incl. trading) and browser
   CORS support varies — use a PAPER / data-only key; failures fall back to
   other providers via the facade. */

import { register, normQuote, getJSON, num } from './base.js';

const DATA = 'https://data.alpaca.markets/v2';
const TRADE = 'https://api.alpaca.markets/v2';
let KEY = '', SECRET = '';
export function setAlpacaKeys(k, s) { KEY = (k || '').trim(); SECRET = (s || '').trim(); }
function headers() { return { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET }; }

register({
  id: 'alpaca',
  label: 'Alpaca',
  needsKey: true,
  needsSecret: true,
  classes: ['equity'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}`, { headers: headers() });
    const snaps = r || {};
    for (const sym of symbols) {
      const s = snaps[sym]; if (!s) continue;
      const bar = s.dailyBar || {}, prev = s.prevDailyBar || {}, trade = s.latestTrade || {};
      const price = num(trade.p) ?? num(bar.c);
      const prevClose = num(prev.c);
      out[sym] = normQuote(sym, {
        price, prevClose, open: num(bar.o), high: num(bar.h), low: num(bar.l), volume: num(bar.v),
        change: (price != null && prevClose != null) ? price - prevClose : null, currency: 'USD',
      }, 'alpaca');
    }
    return out;
  },

  async series(sym, range = '1D') {
    let tf = '5Min', limit = 78;
    if (range === '1M') { tf = '1Day'; limit = 22; }
    else if (range === '1Y') { tf = '1Week'; limit = 52; }
    const r = await getJSON(`${DATA}/stocks/${encodeURIComponent(sym)}/bars?timeframe=${tf}&limit=${limit}`, { headers: headers() }).catch(() => null);
    if (!r || !Array.isArray(r.bars)) return [];
    return r.bars.map((b) => num(b.c)).filter((n) => n != null);
  },

  async profile() { return null; },
  async search() { return []; },

  async marketStatus() {
    const r = await getJSON(`${TRADE}/clock`, { headers: headers() }).catch(() => null);
    if (!r) return null;
    return { isOpen: !!r.is_open, session: r.is_open ? 'open' : 'closed' };
  },

  async validate() {
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=AAPL`, { headers: headers() }).catch(() => null);
    return !!(r && r.AAPL);
  },
});
