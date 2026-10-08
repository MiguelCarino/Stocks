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
import { rangeStart, estimateBars, dayStartUtc, US_TZ } from './candles.js';

const DATA = 'https://data.alpaca.markets/v2';
const TRADE = 'https://api.alpaca.markets/v2';
const ID = 'alpaca';
let KEY = '', SECRET = '';
export function setAlpacaKeys(k, s) { KEY = (k || '').trim(); SECRET = (s || '').trim(); }
function headers() { return { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET }; }
// Alpaca spells class shares BRK.B, like Polygon; results key back to the app symbol.
function apSymbol(sym) { return String(sym).replace(/[-/]([A-Z])$/, '.$1'); }
const TF = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '1d': '1Day', '1w': '1Week', '1M': '1Month' };

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
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=${encodeURIComponent(symbols.map(apSymbol).join(','))}&feed=iex`, { headers: headers(), provider: ID });
    const snaps = r || {};
    for (const sym of symbols) {
      const s = snaps[apSymbol(sym)] || snaps[sym]; if (!s) continue;
      const bar = s.dailyBar || {}, prev = s.prevDailyBar || {}, trade = s.latestTrade || {};
      const price = num(trade.p) ?? num(bar.c);
      const prevClose = num(prev.c);
      out[sym] = normQuote(sym, {
        price, prevClose, open: num(bar.o), high: num(bar.h), low: num(bar.l), volume: num(bar.v),
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

  candleIntervals: () => Object.keys(TF),
  meta: { adjusted: 'splits+dividends', feed: 'iex', delayed: 'IEX only — about 2% of consolidated volume' },

  // IEX-feed bars, split- and dividend-adjusted. One page (limit 10000) covers
  // every range/interval pair the range table allows; intraday includes
  // extended hours, which the facade trims. sort=desc so a tight limit keeps
  // the NEWEST bars; the facade re-sorts oldest-first.
  async candles(sym, { interval = '1d', range = '1Y', priority, maxWait } = {}) {
    const tf = TF[interval];
    if (!tf) return [];
    const start = new Date(rangeStart(range)).toISOString();
    const limit = Math.min(10000, Math.ceil(estimateBars(range, interval, 'equity') * 2.6) + 20);
    const r = await getJSON(`${DATA}/stocks/${encodeURIComponent(apSymbol(sym))}/bars?timeframe=${tf}&start=${encodeURIComponent(start)}&limit=${limit}&adjustment=all&feed=iex&sort=desc`, { headers: headers(), provider: ID, priority, maxWait });
    if (!r || !Array.isArray(r.bars)) return [];
    const daily = interval === '1d' || interval === '1w' || interval === '1M';
    return r.bars.map((b) => { const t = Date.parse(b.t); return { t: daily ? dayStartUtc(t, US_TZ) : t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; });
  },

  // Benzinga headlines via Alpaca (free with any key).
  async news(sym, { limit = 10 } = {}) {
    const r = await getJSON(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(apSymbol(sym))}&limit=${Math.min(50, limit)}&sort=desc`, { headers: headers(), provider: ID, priority: 0 });
    return ((r && r.news) || []).map((n) => ({
      id: 'alpaca-' + n.id, t: Date.parse(n.created_at) || 0, headline: n.headline || '', summary: n.summary || '',
      source: n.source || 'Alpaca', url: n.url || '',
      image: Array.isArray(n.images) && n.images.length ? (n.images.find((i) => i.size === 'small') || n.images[0]).url : undefined,
    }));
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
    const r = await getJSON(`${DATA}/stocks/snapshots?symbols=AAPL&feed=iex`, { headers: headers(), provider: ID, priority: 2 }).catch((e) => { if (e.authError) throw e; return null; });
    return !!(r && r.AAPL);
  },
});
