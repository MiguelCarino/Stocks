/* providers/alphavantage.js — Alpha Vantage adapter (equities + FX). Broad
   coverage but a very low free quota (~25 req/day, 5/min) and no batch endpoint,
   so the router uses it mainly as a fallback. A throttle response (HTTP 200 with
   a Note/Information body) is surfaced as rate-limited so the scheduler backs off. */

import { register, normQuote, getJSON, num } from './base.js';
import { classify, fxPair } from './assetclass.js';

const BASE = 'https://www.alphavantage.co/query';
const ID = 'alphavantage';
let KEY = '';
export function setAlphaVantageKey(k) { KEY = (k || '').trim(); }

function throttled(j) { return !!(j && (j.Note || j.Information || (j['Error Message'] && /call frequency/i.test(j['Error Message'])))); }
function rl() { const e = new Error('alpha-vantage throttled'); e.rateLimited = true; return e; }

register({
  id: ID,
  label: 'Alpha Vantage',
  needsKey: true,
  classes: ['equity', 'fx'],
  batch: false,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    for (const sym of symbols) {
      try {
        if (classify(sym) === 'fx') {
          const [from, to] = fxPair(sym);
          const j = await getJSON(`${BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${KEY}`, { provider: ID });
          if (throttled(j)) throw rl();
          const r = j['Realtime Currency Exchange Rate'];
          const price = r ? num(r['5. Exchange Rate']) : null;
          // The quote currency is the pair's own second leg — the one place in
          // this file where a currency is genuinely known.
          if (price != null) out[sym] = normQuote(sym, {
            price, currency: to,
            // The endpoint returns a rate and a bid/ask, with no prior close of
            // any kind: there is no change to measure, so nothing is claimed.
            baseline: 'unknown',
            baselineNote: 'Spot rate only — no reference close available',
            session: null,
          }, ID);
        } else {
          const j = await getJSON(`${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { provider: ID });
          if (throttled(j)) throw rl();
          const g = j['Global Quote'] || {};
          const price = num(g['05. price']);
          if (price != null) out[sym] = normQuote(sym, {
            price, prevClose: num(g['08. previous close']), open: num(g['02. open']),
            high: num(g['03. high']), low: num(g['04. low']), volume: num(g['06. volume']),
            change: num(g['09. change']),
            changePct: g['10. change percent'] ? num(String(g['10. change percent']).replace('%', '')) : null,
            // GLOBAL_QUOTE names no currency and Alpha Vantage serves foreign
            // listings (RELIANCE.BSE quotes in rupees), so USD would be a guess.
            currency: null,
            baseline: 'prev_close',
            baselineNote: 'Previous session close',
            session: null,
          }, ID);
        }
      } catch (e) { if (e.rateLimited) throw e; }
    }
    return out;
  },

  async series(sym, range = '1D') {
    let fn = 'TIME_SERIES_INTRADAY&interval=5min', key = 'Time Series (5min)';
    if (range === '1M') { fn = 'TIME_SERIES_DAILY'; key = 'Time Series (Daily)'; }
    else if (range === '1Y') { fn = 'TIME_SERIES_WEEKLY'; key = 'Weekly Time Series'; }
    const j = await getJSON(`${BASE}?function=${fn}&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${KEY}`, { provider: ID }).catch(() => null);
    if (!j || throttled(j)) return [];
    const series = j[key]; if (!series) return [];
    const rows = Object.keys(series).sort();   // dates ascending
    let pts = rows.map((d) => num(series[d]['4. close'])).filter((n) => n != null);
    const cap = range === '1Y' ? 52 : range === '1M' ? 22 : 78;
    if (pts.length > cap) pts = pts.slice(-cap);
    return pts;
  },

  async search(q) {
    const j = await getJSON(`${BASE}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(q)}&apikey=${KEY}`, { provider: ID }).catch(() => null);
    if (!j || !Array.isArray(j.bestMatches)) return [];
    return j.bestMatches.slice(0, 12).map((m) => ({ symbol: m['1. symbol'], description: m['2. name'] }));
  },

  // Alpha Vantage does publish a MARKET_STATUS endpoint, and it is deliberately
  // not wired up: the free tier is 25 calls per DAY across all functions, so a
  // status poll on any useful cadence would consume the entire day's quota
  // before lunch and leave nothing for quotes. Corroboration is worth less than
  // the prices it would starve.
  async marketStatus() { return null; },

  async validate() {
    const j = await getJSON(`${BASE}?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${KEY}`, { provider: ID }).catch(() => null);
    return !!(j && j['Global Quote'] && j['Global Quote']['05. price']);
  },
});
