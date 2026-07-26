/* providers/alpaca.js — Alpaca Market Data adapter (US equities), batched
   snapshots for the whole equity group in one call. Needs BOTH a key id and a
   secret. NOTE: Alpaca keys grant account access (incl. trading) and browser
   CORS support varies — use a PAPER / data-only key; failures fall back to
   other providers via the facade.

   The free data plan is the IEX feed, which is one exchange carrying on the
   order of two percent of consolidated volume. Prices track the consolidated
   tape closely in liquid names and visibly lag in thin ones, and prevDailyBar
   is an IEX-only close rather than the official one. That is stated on every
   quote rather than left for the user to discover from a mismatched percent. */

import { register, normQuote, getJSON, num } from './base.js';

const DATA = 'https://data.alpaca.markets/v2';
const TRADE = 'https://api.alpaca.markets/v2';
const ID = 'alpaca';
let KEY = '', SECRET = '';
export function setAlpacaKeys(k, s) { KEY = (k || '').trim(); SECRET = (s || '').trim(); }
function headers() { return { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET }; }

register({
  id: ID,
  label: 'Alpaca',
  needsKey: true,
  needsSecret: true,
  classes: ['equity'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}`, { headers: headers(), provider: ID });
    const snaps = r || {};
    for (const sym of symbols) {
      const s = snaps[sym]; if (!s) continue;
      const bar = s.dailyBar || {}, prev = s.prevDailyBar || {}, trade = s.latestTrade || {};
      const price = num(trade.p) ?? num(bar.c);
      const prevClose = num(prev.c);
      out[sym] = normQuote(sym, {
        price, prevClose, open: num(bar.o), high: num(bar.h), low: num(bar.l), volume: num(bar.v),
        change: (price != null && prevClose != null) ? price - prevClose : null,
        // Alpaca's US equity data is dollar-denominated by definition.
        currency: 'USD',
        baseline: 'prev_close',
        baselineNote: 'Previous IEX close (~2% of consolidated volume)',
        // See marketStatus: nothing in this payload distinguishes pre-market
        // from overnight, so nothing is asserted.
        session: null,
      }, ID);
    }
    return out;
  },

  async series(sym, range = '1D') {
    let tf = '5Min', limit = 78;
    if (range === '1M') { tf = '1Day'; limit = 22; }
    else if (range === '1Y') { tf = '1Week'; limit = 52; }
    const r = await getJSON(`${DATA}/stocks/${encodeURIComponent(sym)}/bars?timeframe=${tf}&limit=${limit}`, { headers: headers(), provider: ID }).catch(() => null);
    if (!r || !Array.isArray(r.bars)) return [];
    return r.bars.map((b) => num(b.c)).filter((n) => n != null);
  },

  async profile() { return null; },
  async search() { return []; },

  async marketStatus() {
    const r = await getJSON(`${TRADE}/clock`, { headers: headers(), provider: ID }).catch(() => null);
    if (!r) return null;
    // /clock's is_open covers the REGULAR session only, so it reads false at
    // 08:00 exactly as it does at 03:00. The endpoint therefore cannot tell
    // pre-market from overnight and session stays null; isOpen is still good
    // corroboration for the one thing it does answer.
    return { isOpen: !!r.is_open, session: null, holiday: null };
  },

  async validate() {
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=AAPL`, { headers: headers(), provider: ID }).catch(() => null);
    return !!(r && r.AAPL);
  },
});
