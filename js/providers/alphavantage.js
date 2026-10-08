/* providers/alphavantage.js — Alpha Vantage adapter (equities, FX, crypto). Broad
   coverage but a very low free quota (25 req/day) and no batch endpoint, so the
   router uses it mainly as a fallback and base.js paces it hard.

   Alpha Vantage answers everything with HTTP 200. A throttle, a premium-only
   endpoint and a bad key all arrive as a body with Note / Information / Error
   Message, and the three must be told apart: a throttle is worth retrying
   tomorrow, a premium endpoint never is for this key, and a bad key is the one
   the user can fix. classify() below reads the prose for which it is.

   Free endpoints used: GLOBAL_QUOTE, CURRENCY_EXCHANGE_RATE (fiat and crypto),
   TIME_SERIES_DAILY / WEEKLY / MONTHLY, FX_DAILY / WEEKLY / MONTHLY,
   DIGITAL_CURRENCY_DAILY / WEEKLY / MONTHLY, OVERVIEW, EARNINGS,
   NEWS_SENTIMENT, EARNINGS_CALENDAR (CSV), SYMBOL_SEARCH. Every intraday
   function is premium and is not called. */

import { register, normQuote, getJSON, num, apiError } from './base.js';
import { classify, fxPair, cryptoBase, cryptoQuote } from './assetclass.js';
import { dateToUtcMidnight } from './candles.js';

const BASE = 'https://www.alphavantage.co/query';
const ID = 'alphavantage';
let KEY = '';
export function setAlphaVantageKey(k) { KEY = (k || '').trim(); }

// -> null when the body is data, or the typed error it actually is.
function bodyError(j) {
  if (!j || typeof j !== 'object') return null;
  const msg = j.Note || j.Information || j['Error Message'];
  if (!msg) return null;
  if (/api ?key/i.test(msg) && /invalid|missing/i.test(msg)) return apiError('authError', msg, { provider: ID });
  if (/premium/i.test(msg)) return apiError('premium', msg, { provider: ID });
  if (/rate limit|call frequency|requests per|per day|per minute|thank you for using/i.test(msg)) return apiError('rateLimited', msg, { provider: ID, daily: /per day|daily/i.test(msg) });
  // "Invalid API call" with a valid key: an unknown symbol. Data-less, not a fault.
  return apiError('error', msg, { provider: ID, noData: true });
}
function check(j) { const e = bodyError(j); if (e && !e.noData) throw e; return e ? null : j; }
// Kept for callers that only need the yes/no.
function throttled(j) { const e = bodyError(j); return !!(e && e.rateLimited); }

const SERIES = {
  equity: { '1d': ['TIME_SERIES_DAILY', 'Time Series (Daily)'], '1w': ['TIME_SERIES_WEEKLY', 'Weekly Time Series'], '1M': ['TIME_SERIES_MONTHLY', 'Monthly Time Series'] },
  fx: { '1d': ['FX_DAILY', 'Time Series FX (Daily)'], '1w': ['FX_WEEKLY', 'Time Series FX (Weekly)'], '1M': ['FX_MONTHLY', 'Time Series FX (Monthly)'] },
  crypto: { '1d': ['DIGITAL_CURRENCY_DAILY', 'Time Series (Digital Currency Daily)'], '1w': ['DIGITAL_CURRENCY_WEEKLY', 'Time Series (Digital Currency Weekly)'], '1M': ['DIGITAL_CURRENCY_MONTHLY', 'Time Series (Digital Currency Monthly)'] },
};

// Field lookup tolerant of both naming generations ('1. open' and the older
// '1a. open (USD)' on digital-currency series).
function pick(row, n, word, ccy) {
  return num(row[`${n}. ${word}`]) ?? num(row[`${n}a. ${word} (${ccy})`]) ?? num(row[`${n}b. ${word} (USD)`]);
}

register({
  id: ID,
  label: 'Alpha Vantage',
  needsKey: true,
  // Crypto was in the quote preference table but not here, so the router
  // skipped it; CURRENCY_EXCHANGE_RATE does serve digital currencies.
  classes: ['equity', 'fx', 'crypto'],
  batch: false,
  hasSeries: true,

  async quote(symbols) {
    const out = {};
    for (const sym of symbols) {
      try {
        const cls = classify(sym);
        if (cls === 'fx' || cls === 'crypto') {
          const [from, to] = cls === 'fx' ? fxPair(sym) : [cryptoBase(sym), cryptoQuote(sym)];
          const j = check(await getJSON(`${BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${KEY}`, { provider: ID }));
          const r = j && j['Realtime Currency Exchange Rate'];
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
          const j = check(await getJSON(`${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { provider: ID }));
          const g = (j && j['Global Quote']) || {};
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
      } catch (e) { if (e.rateLimited || e.authError) throw e; }
    }
    return out;
  },

  // Daily and coarser only — intraday is premium. 'full' history for long
  // ranges; when the account refuses 'full' (premium on some keys) it retries
  // once with 'compact' (latest 100 bars) and says so via partial.
  candleIntervals: () => ['1d', '1w', '1M'],
  meta: { adjusted: 'none', delayed: 'End of day' },

  async candles(sym, { interval = '1d', range = '1Y', priority, maxWait } = {}) {
    const cls = classify(sym);
    const spec = (SERIES[cls] || SERIES.equity)[interval];
    if (!spec) return [];
    const [fn, key] = spec;
    let sel;
    if (cls === 'fx') { const [a, b] = fxPair(sym); sel = `from_symbol=${a}&to_symbol=${b}`; }
    else if (cls === 'crypto') sel = `symbol=${cryptoBase(sym)}&market=${cryptoQuote(sym)}`;
    else sel = `symbol=${encodeURIComponent(sym)}`;
    const wantFull = interval === '1d' && !['1D', '5D', '1M', '3M'].includes(range);
    const size = interval === '1d' && cls !== 'crypto' ? `&outputsize=${wantFull ? 'full' : 'compact'}` : '';
    let j = await getJSON(`${BASE}?function=${fn}&${sel}${size}&apikey=${KEY}`, { provider: ID, priority, maxWait });
    let partial = false;
    const err = bodyError(j);
    if (err && err.premium && wantFull) {
      j = await getJSON(`${BASE}?function=${fn}&${sel}&outputsize=compact&apikey=${KEY}`, { provider: ID, priority, maxWait });
      partial = true;
    }
    check(j);
    const series = j && j[key];
    if (!series) return [];
    const ccy = cls === 'crypto' ? cryptoQuote(sym) : 'USD';
    const bars = Object.keys(series).map((d) => {
      const row = series[d];
      return { t: dateToUtcMidnight(d), o: pick(row, 1, 'open', ccy), h: pick(row, 2, 'high', ccy), l: pick(row, 3, 'low', ccy), c: pick(row, 4, 'close', ccy),
        // FX series carry no volume; crypto's '5. volume' is in coin units.
        v: cls === 'fx' ? null : num(row['5. volume']) };
    });
    return partial ? { bars, partial: true, note: 'Latest 100 sessions only — full history is premium on this key' } : bars;
  },

  // OVERVIEW: ratios arrive as fractions (0.0052) and are converted to percent.
  async fundamentals(sym) {
    if (classify(sym) !== 'equity') return null;
    const j = check(await getJSON(`${BASE}?function=OVERVIEW&symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { provider: ID, priority: 0 }));
    if (!j || !j.Symbol) return null;
    const pct = (x) => (num(x) == null ? null : +(num(x) * 100).toFixed(3));
    return {
      symbol: sym, source: ID, asOf: new Date().toISOString(),
      marketCap: num(j.MarketCapitalization), pe: num(j.PERatio) ?? num(j.TrailingPE), forwardPe: num(j.ForwardPE), peg: num(j.PEGRatio),
      eps: num(j.EPS), ps: num(j.PriceToSalesRatioTTM), pb: num(j.PriceToBookRatio),
      dividendYield: pct(j.DividendYield), dividendPerShare: num(j.DividendPerShare),
      payoutRatio: num(j.EPS) && num(j.DividendPerShare) != null && num(j.EPS) > 0 ? +((num(j.DividendPerShare) / num(j.EPS)) * 100).toFixed(1) : null,
      beta: num(j.Beta), high52: num(j['52WeekHigh']), low52: num(j['52WeekLow']), high52Date: null, low52Date: null,
      avgVolume10d: null, avgVolume3m: null, sharesOutstanding: num(j.SharesOutstanding),
      revenueGrowth: pct(j.QuarterlyRevenueGrowthYOY), profitMargin: pct(j.ProfitMargin), roe: pct(j.ReturnOnEquityTTM),
      debtToEquity: null,
      currency: (j.Currency || '').toUpperCase() || null,
    };
  },

  async events(sym) {
    const empty = { earnings: [], dividends: [], splits: [] };
    if (classify(sym) !== 'equity') return empty;
    const j = check(await getJSON(`${BASE}?function=EARNINGS&symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { provider: ID, priority: 0 }));
    const q = (j && j.quarterlyEarnings) || [];
    empty.earnings = q.slice(0, 8).map((e) => ({
      date: e.reportedDate || e.fiscalDateEnding, epsEstimate: num(e.estimatedEPS), epsActual: num(e.reportedEPS),
      revenueEstimate: null, revenueActual: null, hour: e.reportTime === 'pre-market' ? 'bmo' : e.reportTime === 'post-market' ? 'amc' : null,
    })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return empty;
  },

  async news(sym, { limit = 10 } = {}) {
    const cls = classify(sym);
    const t = cls === 'crypto' ? 'CRYPTO:' + cryptoBase(sym) : cls === 'fx' ? 'FOREX:' + fxPair(sym)[0] : sym;
    const j = check(await getJSON(`${BASE}?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(t)}&limit=${Math.min(50, limit)}&apikey=${KEY}`, { provider: ID, priority: 0 }));
    const feed = (j && j.feed) || [];
    return feed.slice(0, limit).map((n) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?/.exec(n.time_published || '');
      return {
        id: 'av-' + (n.url || n.title), t: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : 0,
        headline: n.title || '', summary: n.summary || '', source: n.source || 'Alpha Vantage', url: n.url || '', image: n.banner_image || undefined,
      };
    });
  },

  // EARNINGS_CALENDAR is CSV: symbol,name,reportDate,fiscalDateEnding,estimate,currency
  async calendar({ from, to } = {}) {
    const txt = await getJSON(`${BASE}?function=EARNINGS_CALENDAR&horizon=3month&apikey=${KEY}`, { provider: ID, priority: 0, text: true });
    if (typeof txt !== 'string' || /^\s*\{/.test(txt)) { try { check(JSON.parse(txt)); } catch (e) { if (e.kind) throw e; } return { earnings: [], ipos: [] }; }
    const lines = txt.trim().split(/\r?\n/);
    const head = lines.shift().split(',');
    const ix = (k) => head.indexOf(k);
    const out = [];
    for (const ln of lines) {
      const c = ln.split(',');
      const date = c[ix('reportDate')];
      if (!date || (from && date < from) || (to && date > to)) continue;
      out.push({ date, symbol: c[ix('symbol')], epsEstimate: num(c[ix('estimate')]), hour: null });
    }
    return { earnings: out, ipos: [] };
  },

  async search(q) {
    const j = await getJSON(`${BASE}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(q)}&apikey=${KEY}`, { provider: ID, priority: 2, maxWait: 8000 }).catch(() => null);
    if (!j || throttled(j) || !Array.isArray(j.bestMatches)) return [];
    return j.bestMatches.slice(0, 12).map((m) => ({ symbol: m['1. symbol'], description: m['2. name'] }));
  },

  // Alpha Vantage does publish a MARKET_STATUS endpoint, and it is deliberately
  // not wired up: the free tier is 25 calls per DAY across all functions, so a
  // status poll on any useful cadence would consume the entire day's quota
  // before lunch and leave nothing for quotes. Corroboration is worth less than
  // the prices it would starve.
  async marketStatus() { return null; },

  async validate() {
    const j = await getJSON(`${BASE}?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${KEY}`, { provider: ID, priority: 2 });
    check(j);
    return !!(j && j['Global Quote'] && j['Global Quote']['05. price']);
  },
});
