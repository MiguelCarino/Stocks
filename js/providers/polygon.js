/* providers/polygon.js — Polygon.io adapter (US equities). One batched snapshot
   call covers the whole equity group; the free tier is rate-limited (~5 req/min)
   so base.js paces every call and surfaces HTTP 429 as rate-limited. Also the
   free source for split/dividend history and ticker news.

   Polygon's prevDay aggregate is a full-day bar: it includes extended-hours
   prints, so todaysChangePerc is measured against a slightly different number
   than the official close every other equity provider here uses. The difference
   is usually pennies and occasionally is not, which is exactly why the quote
   states its baseline instead of leaving the UI to assume one. */

import { register, normQuote, getJSON, num } from './base.js';
import { rangeStart, dayStartUtc, US_TZ } from './candles.js';

const BASE = 'https://api.polygon.io';
const ID = 'polygon';
let KEY = '';
export function setPolygonKey(k) { KEY = (k || '').trim(); }

function ymd(d) { return d.toISOString().slice(0, 10); }

// Class shares: Polygon writes BRK.B; users and other feeds type BRK-B or BRK/B.
// Requests go out in Polygon's spelling and results are keyed back to whatever
// the watchlist holds — the old code keyed by Polygon's ticker, so a BRK-B
// entry never received its quote.
function polySymbol(sym) { return String(sym).replace(/[-/]([A-Z])$/, '.$1'); }

const AGG = { '1m': [1, 'minute'], '5m': [5, 'minute'], '15m': [15, 'minute'], '30m': [30, 'minute'], '1h': [1, 'hour'], '1d': [1, 'day'], '1w': [1, 'week'], '1M': [1, 'month'] };
const DAY = 86400000;

register({
  id: ID,
  label: 'Polygon',
  needsKey: true,
  classes: ['equity'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    const back = new Map(symbols.map((s) => [polySymbol(s), s]));
    const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent([...back.keys()].join(','))}&apiKey=${KEY}`;
    const r = await getJSON(url, { provider: ID });
    for (const t of (r.tickers || [])) {
      const sym = back.get(t.ticker) || t.ticker;
      const day = t.day || {}, prev = t.prevDay || {}, last = t.lastTrade || {};
      const price = num(last.p) ?? num(day.c) ?? num(prev.c);
      out[sym] = normQuote(sym, {
        price, prevClose: num(prev.c), open: num(day.o), high: num(day.h), low: num(day.l),
        volume: num(day.v), change: num(t.todaysChange), changePct: num(t.todaysChangePerc),
        // The endpoint is locale/us/markets/stocks: USD is guaranteed by the
        // URL, not assumed by a default.
        currency: 'USD',
        baseline: 'prev_close',
        baselineNote: 'Previous full-day close, includes extended-hours prints',
        // The snapshot carries no session flag. marketstatus/now does, but it is
        // a separate request against a 5/min quota.
        session: null,
      }, ID);
    }
    return out;
  },

  candleIntervals: () => Object.keys(AGG),
  // Free plan: end-of-day / 15-min delayed, about two years of history.
  meta: { adjusted: 'splits+dividends', delayed: 'Delayed on the free plan', historyDays: 730 },

  // /v2/aggs with adjusted=true. Intraday includes extended hours; the facade
  // trims to the regular session unless asked not to. Daily+ bars come stamped
  // at New York midnight and are re-stamped to 00:00 UTC of the trading date.
  async candles(sym, { interval = '1d', range = '1Y', priority, maxWait } = {}) {
    const a = AGG[interval];
    if (!a) return [];
    const now = Date.now();
    const from = new Date(Math.max(rangeStart(range, now), now - 730 * DAY));
    const to = new Date(now + DAY);
    const url = `${BASE}/v2/aggs/ticker/${encodeURIComponent(polySymbol(sym))}/range/${a[0]}/${a[1]}/${ymd(from)}/${ymd(to)}?adjusted=true&sort=asc&limit=50000&apiKey=${KEY}`;
    const r = await getJSON(url, { provider: ID, priority, maxWait });
    if (!r || !Array.isArray(r.results)) return [];
    const daily = a[1] === 'day' || a[1] === 'week' || a[1] === 'month';
    return r.results.map((b) => ({ t: daily ? dayStartUtc(b.t, US_TZ) : b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  },

  // Ticker details + the latest TTM financials (two calls against 5/min, so
  // background priority). P/E is market cap over TTM net income, which needs
  // no price; ratios are percent.
  async fundamentals(sym) {
    const ps = polySymbol(sym);
    const [det, fin] = await Promise.all([
      getJSON(`${BASE}/v3/reference/tickers/${encodeURIComponent(ps)}?apiKey=${KEY}`, { provider: ID, priority: 0 }).catch((e) => { if (e.authError || e.rateLimited) throw e; return null; }),
      getJSON(`${BASE}/vX/reference/financials?ticker=${encodeURIComponent(ps)}&timeframe=ttm&limit=1&apiKey=${KEY}`, { provider: ID, priority: 0 }).catch(() => null),
    ]);
    const d = det && det.results;
    if (!d) return null;
    const f = fin && Array.isArray(fin.results) && fin.results[0] ? fin.results[0].financials || {} : {};
    const val = (sec, k) => num(f[sec] && f[sec][k] && f[sec][k].value);
    const cap = num(d.market_cap);
    const ni = val('income_statement', 'net_income_loss');
    const rev = val('income_statement', 'revenues');
    const eq = val('balance_sheet', 'equity');
    const ltd = val('balance_sheet', 'long_term_debt');
    const shares = num(d.share_class_shares_outstanding) ?? num(d.weighted_shares_outstanding);
    return {
      symbol: sym, source: ID, asOf: new Date().toISOString(),
      marketCap: cap,
      pe: cap && ni && ni > 0 ? +(cap / ni).toFixed(2) : null,
      forwardPe: null, peg: null,
      eps: val('income_statement', 'diluted_earnings_per_share') ?? val('income_statement', 'basic_earnings_per_share'),
      ps: cap && rev ? +(cap / rev).toFixed(2) : null,
      pb: cap && eq && eq > 0 ? +(cap / eq).toFixed(2) : null,
      dividendYield: null, dividendPerShare: null, payoutRatio: null, beta: null,
      high52: null, low52: null, high52Date: null, low52Date: null, avgVolume10d: null, avgVolume3m: null,
      sharesOutstanding: shares,
      revenueGrowth: null,
      profitMargin: ni != null && rev ? +((ni / rev) * 100).toFixed(2) : null,
      roe: ni != null && eq && eq > 0 ? +((ni / eq) * 100).toFixed(2) : null,
      debtToEquity: ltd != null && eq && eq > 0 ? +(ltd / eq).toFixed(2) : null,
      currency: d.currency_name ? d.currency_name.toUpperCase() : null,
    };
  },

  async news(sym, { limit = 10 } = {}) {
    const r = await getJSON(`${BASE}/v2/reference/news?ticker=${encodeURIComponent(polySymbol(sym))}&limit=${Math.min(50, limit)}&order=desc&sort=published_utc&apiKey=${KEY}`, { provider: ID, priority: 0 });
    return ((r && r.results) || []).map((n) => ({
      id: 'polygon-' + n.id, t: Date.parse(n.published_utc) || 0, headline: n.title || '', summary: n.description || '',
      source: (n.publisher && n.publisher.name) || 'Polygon', url: n.article_url || '', image: n.image_url || undefined,
    }));
  },

  // Dividends and splits (free reference data). No earnings on the free plan.
  async events(sym) {
    const ps = polySymbol(sym);
    const [dv, sp] = await Promise.all([
      getJSON(`${BASE}/v3/reference/dividends?ticker=${encodeURIComponent(ps)}&limit=24&order=desc&apiKey=${KEY}`, { provider: ID, priority: 0 }).catch((e) => { if (e.authError || e.rateLimited) throw e; return null; }),
      getJSON(`${BASE}/v3/reference/splits?ticker=${encodeURIComponent(ps)}&limit=20&order=desc&apiKey=${KEY}`, { provider: ID, priority: 0 }).catch(() => null),
    ]);
    return {
      earnings: [],
      dividends: ((dv && dv.results) || []).map((x) => ({ exDate: x.ex_dividend_date || null, payDate: x.pay_date || null, amount: num(x.cash_amount), currency: (x.currency || '').toUpperCase() || null }))
        .sort((a, b) => String(a.exDate).localeCompare(String(b.exDate))),
      splits: ((sp && sp.results) || []).map((x) => ({ date: x.execution_date, ratio: num(x.split_to) && num(x.split_from) ? num(x.split_to) / num(x.split_from) : null }))
        .filter((x) => x.ratio).sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  },

  async profile(sym) {
    const r = await getJSON(`${BASE}/v3/reference/tickers/${encodeURIComponent(polySymbol(sym))}?apiKey=${KEY}`, { provider: ID }).catch((e) => { if (e.authError) throw e; return null; });
    const d = r && r.results;
    if (!d) return null;
    return { symbol: sym, name: d.name || sym, exchange: d.primary_exchange || '', sector: d.sic_description || '',
             currency: d.currency_name ? d.currency_name.toUpperCase() : null, marketCap: num(d.market_cap) || 0, logo: '',
             country: d.locale ? String(d.locale).toUpperCase() : null };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&limit=12&apiKey=${KEY}`, { provider: ID, priority: 2, maxWait: 8000 }).catch(() => null);
    return ((r && r.results) || []).map((x) => ({ symbol: x.ticker, description: x.name || '' }));
  },

  async marketStatus() {
    const r = await getJSON(`${BASE}/v1/marketstatus/now?apiKey=${KEY}`, { provider: ID }).catch(() => null);
    if (!r) return null;
    // market reads 'extended-hours' for BOTH sides of the regular session; the
    // earlyHours / afterHours booleans are the only thing that disambiguates
    // them, so they are read first and market is the fallback.
    const session = r.earlyHours ? 'pre' : r.afterHours ? 'post' : r.market === 'open' ? 'open' : 'closed';
    return { isOpen: r.market === 'open', session, holiday: null };
  },

  async validate() {
    const r = await getJSON(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL&apiKey=${KEY}`, { provider: ID, priority: 2 }).catch((e) => { if (e.authError) throw e; return null; });
    return !!(r && Array.isArray(r.tickers) && r.tickers.length);
  },
});
