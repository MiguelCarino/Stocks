/* providers/twelvedata.js — Twelve Data adapter (free 8 credits/min, 800/day,
   CORS-enabled). Primary source for OHLCV candles at every interval, and the
   batched fallback quote source when no Finnhub key is present.

   The one adapter here that reports a currency per instrument, which matters
   because it is also the only one serving all three asset classes: an FX or a
   foreign listing routed through Twelve Data is genuinely not dollars, and the
   quote says so instead of inheriting a default. */

import { register, normQuote, getJSON, num, apiError } from './base.js';
import { classify, fxPair, cryptoBase, cryptoQuote } from './assetclass.js';
import { estimateBars, dateToUtcMidnight } from './candles.js';

const BASE = 'https://api.twelvedata.com';
const ID = 'twelvedata';
let KEY = '';
export function setTwelveDataKey(k) { KEY = (k || '').trim(); }

// App interval -> Twelve Data interval. Every one is on the free plan.
const TD_INTERVAL = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '1d': '1day', '1w': '1week', '1M': '1month' };

// Twelve Data wants slash notation for non-equities: EUR/USD, BTC/USD. Our
// symbols arrive compacted (EURUSD, BTC, BTCEUR) or dashed (ETH-EUR), so
// reformat by asset class — keeping a crypto's own quote currency instead of
// forcing every coin to /USD, which priced BTCEUR in dollars.
function tdSymbol(sym) {
  const c = classify(sym);
  if (c === 'fx') { const [a, b] = fxPair(sym); return `${a}/${b}`; }
  if (c === 'crypto') { return `${cryptoBase(sym)}/${cryptoQuote(sym)}`; }
  return sym;
}

/* Twelve Data answers errors with HTTP 200 and a body of
   { code, message, status: 'error' } — for a bad key, a spent credit allowance
   and a plan restriction alike. Read the code, or the failure is silent. */
function bodyError(r) {
  if (!r || r.status !== 'error') return null;
  const code = Number(r.code);
  const msg = String(r.message || 'Twelve Data error');
  if (code === 429 || /credits|limit/i.test(msg)) return apiError('rateLimited', msg, { provider: ID, daily: /day/i.test(msg) });
  if (code === 401 || /api ?key/i.test(msg)) return apiError('authError', msg, { provider: ID });
  if (code === 403 || /plan|upgrade|available exclusively/i.test(msg)) return apiError('premium', msg, { provider: ID });
  return null;   // 400/404: unknown symbol and the like — no data, not a provider fault
}
function throwIfBodyError(r) { const e = bodyError(r); if (e) throw e; }

// 'YYYY-MM-DD' (daily+) or 'YYYY-MM-DD HH:MM:SS' in UTC (we ask for timezone=UTC).
function tdTime(s, daily) {
  if (daily) return dateToUtcMidnight(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
}

// Statistics (fundamentals) is a paid endpoint on most plans. One refusal is
// remembered for the session instead of re-spending a credit on every symbol.
let statsUnavailable = false;

register({
  id: ID,
  label: 'Twelve Data',
  needsKey: true,
  classes: ['equity', 'fx', 'crypto'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    // One batched call for the whole group (comma-separated), keyed by the
    // Twelve Data symbol and mapped back to the app's symbol.
    const back = new Map();   // tdSym -> appSym
    const tdSyms = symbols.map((s) => { const t = tdSymbol(s); back.set(t, s); return t; });
    const r = await getJSON(`${BASE}/quote?symbol=${encodeURIComponent(tdSyms.join(','))}&apikey=${KEY}`, { provider: ID, cost: tdSyms.length });
    // A top-level error object (bad key, credits spent) is not a symbol row.
    throwIfBodyError(r);
    const out = {};
    const rows = tdSyms.length === 1 ? { [tdSyms[0]]: r } : r;
    for (const tdSym of tdSyms) {
      const q = rows[tdSym];
      const appSym = back.get(tdSym);
      if (!q || q.status === 'error' || q.close == null) continue;
      const cls = classify(appSym);
      out[appSym] = normQuote(appSym, {
        price: q.close, prevClose: q.previous_close, open: q.open, high: q.high, low: q.low,
        volume: q.volume, changePct: q.percent_change, change: q.change,
        currency: (q.currency || '').toUpperCase() || null,
        baseline: 'prev_close',
        // Crypto never has a close, so what Twelve Data hands back for a coin is
        // the previous UTC daily candle — a real boundary, but an arbitrary one
        // that will not match CoinGecko's rolling window on the same coin.
        baselineNote: cls === 'crypto' ? 'Previous UTC daily candle close' : 'Previous session close',
        // is_market_open covers the regular session only and reads false at
        // 08:00 as at 03:00, so it cannot name a session.
        session: null,
      }, ID);
    }
    return out;
  },

  candleIntervals: () => Object.keys(TD_INTERVAL),
  meta: { adjusted: 'splits', delayed: 'Real-time for US equities on the free plan where licensed; otherwise delayed' },

  // Full OHLCV. outputsize is sized from the range (max 5000) and the facade
  // trims to the exact window; timezone=UTC makes intraday stamps unambiguous.
  async candles(sym, { interval = '1d', range = '1Y', priority, maxWait } = {}) {
    const iv = TD_INTERVAL[interval];
    if (!iv) return [];
    const cls = classify(sym);
    const size = Math.min(5000, Math.ceil(estimateBars(range, interval, cls) * 1.3) + 10);
    const r = await getJSON(`${BASE}/time_series?symbol=${encodeURIComponent(tdSymbol(sym))}&interval=${iv}&outputsize=${size}&timezone=UTC&order=ASC&apikey=${KEY}`, { provider: ID, priority, maxWait });
    throwIfBodyError(r);
    if (!r || !Array.isArray(r.values)) return [];
    const daily = interval === '1d' || interval === '1w' || interval === '1M';
    return r.values.map((v) => ({ t: tdTime(v.datetime, daily), o: v.open, h: v.high, l: v.low, c: v.close, v: v.volume }));
  },

  // Paid on most plans (see statsUnavailable); returns null rather than failing.
  async fundamentals(sym) {
    if (statsUnavailable || classify(sym) !== 'equity') return null;
    let r;
    try { r = await getJSON(`${BASE}/statistics?symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { provider: ID, priority: 0 }); throwIfBodyError(r); }
    catch (e) { if (e.premium) { statsUnavailable = true; return null; } throw e; }
    const st = r && r.statistics;
    if (!st) return null;
    const v = st.valuations_metrics || {}, f = st.financials || {}, sh = st.stock_statistics || {}, px = st.stock_price_summary || {}, dv = st.dividends_and_splits || {};
    const inc = f.income_statement || {}, bal = f.balance_sheet || {};
    const pct = (x) => (num(x) == null ? null : num(x) * 100);
    return {
      symbol: sym, source: ID, asOf: new Date().toISOString(),
      marketCap: num(v.market_capitalization), pe: num(v.trailing_pe), forwardPe: num(v.forward_pe), peg: num(v.peg_ratio),
      eps: num(inc.diluted_eps_ttm), ps: num(v.price_to_sales_ttm), pb: num(v.price_to_book_mrq),
      dividendYield: pct(dv.trailing_annual_dividend_yield), dividendPerShare: num(dv.trailing_annual_dividend_rate), payoutRatio: pct(dv.payout_ratio),
      beta: num(px.beta), high52: num(px.fifty_two_week_high), low52: num(px.fifty_two_week_low), high52Date: null, low52Date: null,
      avgVolume10d: num(sh.avg_10_volume), avgVolume3m: num(sh.avg_90_volume), sharesOutstanding: num(sh.shares_outstanding),
      revenueGrowth: pct(inc.quarterly_revenue_growth), profitMargin: pct(f.profit_margin), roe: pct(f.return_on_equity_ttm),
      debtToEquity: num(bal.total_debt_to_equity_mrq) == null ? null : num(bal.total_debt_to_equity_mrq) / 100,
      currency: (r.meta && r.meta.currency) || null,
    };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/symbol_search?symbol=${encodeURIComponent(q)}&apikey=${KEY}`, { provider: ID, priority: 2 });
    throwIfBodyError(r);
    return (r.data || []).slice(0, 12).map((x) => ({ symbol: x.symbol, description: `${x.instrument_name} · ${x.exchange}` }));
  },

  // No market-status endpoint on the free plan; is_market_open rides along with
  // a quote and is regular-hours only, so there is nothing worth spending a
  // request on.
  async marketStatus() { return null; },

  async validate() {
    const r = await getJSON(`${BASE}/quote?symbol=AAPL&apikey=${KEY}`, { provider: ID, priority: 2 });
    throwIfBodyError(r);
    return num(r.close) != null;
  },
});
