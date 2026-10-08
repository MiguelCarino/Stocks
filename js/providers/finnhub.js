/* providers/finnhub.js — Finnhub adapter (free tier, CORS-enabled).
   Powers real-time-ish US quotes, company profiles, symbol search, market
   status, and the richest free fundamentals / news / earnings calendar of any
   source here. Candles (/stock/candle) and dividends (/stock/dividend2) are
   premium on Finnhub, so bars route through Twelve Data / Polygon / Alpaca and
   dividends through Polygon instead.

   Finnhub has no batch quote endpoint: one refresh of an N-symbol watchlist is
   N HTTP requests. That is the reason the call budget is instrumented down in
   getJSON rather than at the facade — this adapter is the one that would make a
   facade-level count meaningless. */

import { register, normQuote, getJSON, num } from './base.js';
import { classify, cryptoBase } from './assetclass.js';

const BASE = 'https://finnhub.io/api/v1';
const ID = 'finnhub';
let KEY = '';
export function setFinnhubKey(k) { KEY = (k || '').trim(); }

// /quote reports no currency, but Finnhub lists foreign tickers too (SHOP.TO is
// CAD), so USD cannot be assumed. profile2 does report it; whatever it taught us
// is reused on later quotes and the field stays null until then.
const currencyBySymbol = new Map();

function keyError(msg) {
  const e = new Error(String(msg)); e.kind = /limit/i.test(msg) ? 'rateLimited' : 'authError'; e[e.kind] = true; e.provider = ID; return e;
}
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }
const DAY = 86400000;

// /stock/market-status session strings -> the app's four-value vocabulary.
const SESSION_MAP = {
  'pre-market': 'pre',
  premarket: 'pre',
  regular: 'open',
  'post-market': 'post',
  postmarket: 'post',
  closed: 'closed',
};

register({
  id: ID,
  label: 'Finnhub',
  needsKey: true,
  classes: ['equity'],
  batch: false,
  hasSeries: false,

  async quote(symbols) {
    // Finnhub /quote is one symbol per call; the scheduler paces these.
    const out = {};
    await Promise.all(symbols.map(async (sym) => {
      try {
        const q = await getJSON(`${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`, { provider: ID });
        if (q && q.error) throw keyError(q.error);
        if (q && q.c != null && q.c !== 0) {
          out[sym] = normQuote(sym, {
            c: q.c, pc: q.pc, o: q.o, h: q.h, l: q.l, change: q.d, changePct: q.dp,
            ts: (q.t ? q.t * 1000 : Date.now()),
            currency: currencyBySymbol.get(sym) || null,
            // pc is the official consolidated regular-session close — the one
            // baseline in this codebase that needs no caveat.
            baseline: 'prev_close',
            baselineNote: 'Official previous regular-session close',
            // /quote carries no session flag. market-status does, but it is a
            // separate request and asserting one symbol's session from a
            // market-wide poll taken at another moment is a guess.
            session: null,
          }, ID);
        }
      } catch (e) {
        // A rejected key or a throttle is the provider's fault, not this
        // symbol's: surface it so the facade can say so. An unknown symbol or
        // one network blip is per-symbol and stays quiet.
        if (e.rateLimited || e.authError) throw e;
      }
    }));
    return out;
  },

  async profile(sym) {
    const p = await getJSON(`${BASE}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${KEY}`, { provider: ID });
    if (!p || !p.name) return null;
    const currency = (p.currency || '').toUpperCase() || null;
    if (currency) currencyBySymbol.set(sym, currency);
    // currency stays null when Finnhub does not say — see base.js on 'USD' defaults.
    return { symbol: sym, name: p.name, exchange: p.exchange || '', sector: p.finnhubIndustry || '',
             currency, marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : 0,
             logo: p.logo || '', country: p.country || null,
             sharesOutstanding: num(p.shareOutstanding) != null ? num(p.shareOutstanding) * 1e6 : null };
  },

  // /stock/metric?metric=all (free). Finnhub reports market cap and volumes in
  // millions and every ratio-like figure already in percent.
  async fundamentals(sym) {
    if (classify(sym) !== 'equity') return null;
    const r = await getJSON(`${BASE}/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${KEY}`, { provider: ID, priority: 1 });
    if (r && r.error) throw keyError(r.error);
    const m = r && r.metric;
    if (!m || !Object.keys(m).length) return null;
    const mil = (x) => (num(x) == null ? null : num(x) * 1e6);
    return {
      symbol: sym, source: ID, asOf: new Date().toISOString(),
      marketCap: mil(m.marketCapitalization),
      pe: num(m.peTTM) ?? num(m.peBasicExclExtraTTM) ?? num(m.peExclExtraTTM),
      forwardPe: num(m.forwardPE) ?? null,
      peg: num(m.pegTTM) ?? null,
      eps: num(m.epsTTM) ?? num(m.epsBasicExclExtraItemsTTM) ?? num(m.epsExclExtraItemsTTM),
      ps: num(m.psTTM) ?? num(m.psAnnual),
      pb: num(m.pbQuarterly) ?? num(m.pbAnnual) ?? num(m.pb),
      dividendYield: num(m.dividendYieldIndicatedAnnual) ?? num(m.currentDividendYieldTTM),
      dividendPerShare: num(m.dividendPerShareAnnual) ?? num(m.dividendPerShareTTM),
      payoutRatio: num(m.payoutRatioTTM) ?? num(m.payoutRatioAnnual),
      beta: num(m.beta),
      high52: num(m['52WeekHigh']), low52: num(m['52WeekLow']),
      high52Date: m['52WeekHighDate'] || null, low52Date: m['52WeekLowDate'] || null,
      avgVolume10d: mil(m['10DayAverageTradingVolume']), avgVolume3m: mil(m['3MonthAverageTradingVolume']),
      sharesOutstanding: null,
      revenueGrowth: num(m.revenueGrowthTTMYoy) ?? num(m.revenueGrowthQuarterlyYoy),
      profitMargin: num(m.netProfitMarginTTM) ?? num(m.netProfitMarginAnnual),
      roe: num(m.roeTTM) ?? num(m.roeRfy),
      debtToEquity: num(m['totalDebt/totalEquityQuarterly']) ?? num(m['totalDebt/totalEquityAnnual']),
      currency: currencyBySymbol.get(sym) || null,
    };
  },

  // /company-news for equities (last 10 days, free). Crypto gets the general
  // crypto feed filtered to headlines that name the coin — Finnhub has no
  // per-coin news endpoint on the free plan.
  async news(sym, { limit = 10 } = {}) {
    const cls = classify(sym);
    let rows;
    if (cls === 'equity') {
      const to = Date.now(), from = to - 10 * DAY;
      rows = await getJSON(`${BASE}/company-news?symbol=${encodeURIComponent(sym)}&from=${ymd(from)}&to=${ymd(to)}&token=${KEY}`, { provider: ID, priority: 0 });
    } else if (cls === 'crypto') {
      const all = await getJSON(`${BASE}/news?category=crypto&token=${KEY}`, { provider: ID, priority: 0 });
      const base = cryptoBase(sym);
      const re = new RegExp('\\b' + base.replace(/[^A-Z0-9]/g, '') + '\\b', 'i');
      rows = Array.isArray(all) ? all.filter((n) => re.test(n.headline || '') || re.test(n.related || '')) : [];
    } else return [];
    if (rows && rows.error) throw keyError(rows.error);
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, limit).map((n) => ({
      id: 'finnhub-' + (n.id ?? n.url), t: (num(n.datetime) || 0) * 1000,
      headline: n.headline || '', summary: n.summary || '', source: n.source || 'Finnhub', url: n.url || '', image: n.image || undefined,
    }));
  },

  // Earnings only: Finnhub's dividend and split endpoints are premium.
  async events(sym) {
    if (classify(sym) !== 'equity') return { earnings: [], dividends: [], splits: [] };
    const now = Date.now();
    const r = await getJSON(`${BASE}/calendar/earnings?from=${ymd(now - 400 * DAY)}&to=${ymd(now + 200 * DAY)}&symbol=${encodeURIComponent(sym)}&token=${KEY}`, { provider: ID, priority: 0 });
    if (r && r.error) throw keyError(r.error);
    const rows = (r && r.earningsCalendar) || [];
    return {
      earnings: rows.map((e) => ({ date: e.date, epsEstimate: num(e.epsEstimate), epsActual: num(e.epsActual), revenueEstimate: num(e.revenueEstimate), revenueActual: num(e.revenueActual), hour: e.hour || null }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
      dividends: [], splits: [],
    };
  },

  // Market-wide earnings + IPO calendars (both free).
  async calendar({ from, to } = {}) {
    const f = from || ymd(Date.now()), t = to || ymd(Date.now() + 14 * DAY);
    const [er, ip] = await Promise.all([
      getJSON(`${BASE}/calendar/earnings?from=${f}&to=${t}&token=${KEY}`, { provider: ID, priority: 0 }),
      getJSON(`${BASE}/calendar/ipo?from=${f}&to=${t}&token=${KEY}`, { provider: ID, priority: 0 }).catch(() => null),
    ]);
    if (er && er.error) throw keyError(er.error);
    return {
      earnings: ((er && er.earningsCalendar) || []).map((e) => ({ date: e.date, symbol: e.symbol, epsEstimate: num(e.epsEstimate), hour: e.hour || null })),
      ipos: ((ip && ip.ipoCalendar) || []).map((i) => ({ date: i.date, symbol: i.symbol || '', name: i.name || '', exchange: i.exchange || '', price: i.price || null, shares: num(i.numberOfShares), status: i.status || null })),
    };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/search?q=${encodeURIComponent(q)}&token=${KEY}`, { provider: ID, priority: 2 });
    // US listings (no exchange suffix) of any type — ETFs included — plus
    // foreign common stock. The old filter read the other way round by
    // operator precedence and dropped every US ETF.
    return (r.result || [])
      .filter((x) => x.symbol && (!x.symbol.includes('.') || x.type === 'Common Stock'))
      .slice(0, 12)
      .map((x) => ({ symbol: x.symbol, description: x.description }));
  },

  async marketStatus() {
    try {
      const r = await getJSON(`${BASE}/stock/market-status?exchange=US&token=${KEY}`, { provider: ID });
      const raw = String(r.session || '').toLowerCase();
      return {
        isOpen: !!r.isOpen,
        session: SESSION_MAP[raw] || (r.isOpen ? 'open' : 'closed'),
        // A holiday name here is the cheapest available check on the local
        // holiday table drifting out of date; the facade surfaces it.
        holiday: r.holiday || null,
      };
    } catch (e) { return null; }
  },

  // Validate a key with a single cheap call.
  async validate() {
    const q = await getJSON(`${BASE}/quote?symbol=AAPL&token=${KEY}`, { provider: ID, priority: 2 });
    if (q && q.error) throw keyError(q.error);
    return num(q.c) != null;
  },
});
