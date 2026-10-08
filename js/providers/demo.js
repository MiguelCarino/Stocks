/* providers/demo.js — keyless DEMO adapter. Everything it serves is synthesized
   on the spot from data/demo.json (names, sectors, a reference close, sample
   fundamentals) and a seeded generator, and is clearly badged DEMO in the UI.

   ONE PRICE PATH. Quotes, every chart interval, the 52-week range in the
   fundamentals and the sample news are all read off the same deterministic
   path, so a demo user who opens a 5-minute chart next to the quote card sees
   numbers that agree — the day's high on the card is the highest wick on the
   chart. The path is a geometric Brownian motion on DAILY closes, anchored so
   the close of the session before the latest one equals the reference close in
   demo.json (the quote card's "previous close" is therefore stable), with each
   session filled in by a Brownian bridge at one-minute resolution between that
   day's open and close. Seeds are (symbol, trading date), so the same instant
   always produces the same bars — in every tab, every popout, every test.

   CALENDARS. Equities trade 09:30-16:00 New York on NYSE days (weekends and
   full holidays skipped via session.js; half days run to 13:00). FX trades on
   UTC weekdays, 24h. Crypto never closes. A session in progress is shown up to
   now, and the quote price glides along the path second by second — when the
   market is shut the demo price is shut too, as a real one would be.

   VOLUME. Lognormal around each ticker's typical daily volume, larger on big
   moves, distributed across the session in the usual U shape. Spot FX has no
   consolidated volume, so FX bars carry v: null rather than an invented one.

   The bundled file is same-origin and costs no quota, so it is fetched directly
   rather than through getJSON: counting it would put a number in the call
   budget that no free tier is charging for. */

import { register, normQuote, num } from './base.js';
import { classify, cryptoQuote, fxPair } from './assetclass.js';
import { holidayInfo } from '../session.js';
import { aggregate, trimToRange, rangeStart, zonedParts, zonedTimeToMs, US_TZ, isIntraday, utcYmd, defaultInterval, isInterval, ymd } from './candles.js';

const DAY = 86400000;
const MIN = 60000;
const FULL_RES_DAYS = 100;   // sessions newer than this get a 1-minute bridge; older ones a coarse one
const MAX_YEARS = 10;        // how far back 'MAX' reaches in demo mode

let DATA = null;
let loading = null;

async function load() {
  if (DATA) return DATA;
  if (!loading) loading = fetch('data/demo.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => (DATA = d));
  return loading;
}
// Tests (and tools) inject the bundle instead of fetching it.
export function setDemoData(d) { DATA = d; loading = Promise.resolve(d); PARAMS.clear(); }

/* ---- Seeded randomness ------------------------------------------------------
   FNV-1a for the seed, mulberry32 for the stream, Box-Muller for normals. A
   fresh stream per (symbol, date, purpose) keeps one day's draws independent of
   how many other days were generated before it. */

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/* ---- Per-symbol parameters ------------------------------------------------- */

const PARAMS = new Map();
function params(sym) {
  if (PARAMS.has(sym)) return PARAMS.get(sym);
  const cls = classify(sym);
  const t = DATA && DATA.tickers ? DATA.tickers[sym] : null;
  const m = (t && t.demo) || {};
  const r = rng(sym + '|params');
  // A ticker the bundle does not know still gets a stable, plausible path, so
  // demo mode works for anything a user types. It is never shown in live mode
  // without the DEMO flag (see market.candles).
  let anchor = num(t && t.quote && t.quote.prevClose) ?? num(t && t.quote && t.quote.price);
  if (anchor == null) anchor = cls === 'crypto' ? +(0.05 * Math.pow(10, r() * 3)).toPrecision(4)
    : cls === 'fx' ? +(0.5 + r() * 1.5).toFixed(4) : +(15 + r() * 385).toFixed(2);
  const vol = num(m.vol) ?? (cls === 'crypto' ? 0.035 : cls === 'fx' ? 0.005 : 0.017);
  const avgVolume = cls === 'fx' ? null : (num(m.avgVolume) ?? Math.round((cls === 'crypto' ? 5e7 : 1e6) * Math.pow(10, r() * 1.5)));
  const drift = num(m.drift) ?? (cls === 'crypto' ? 0.0006 : cls === 'fx' ? 0 : 0.0003);
  const currency = (t && t.quote && t.quote.currency) || (cls === 'fx' ? fxPair(sym)[1] : cls === 'crypto' ? cryptoQuote(sym) : 'USD');
  const p = {
    sym, cls, anchor, vol, avgVolume, drift, currency,
    // Overnight gap: real for equities, a sliver for FX, none for crypto (its
    // "open" is just the price at 00:00 UTC — the previous close by definition).
    gap: cls === 'equity' ? vol * 0.35 : cls === 'fx' ? vol * 0.05 : 0,
    dp: decimals(anchor, cls),
  };
  PARAMS.set(sym, p);
  return p;
}

function decimals(price, cls) {
  if (cls === 'fx') return price >= 20 ? 3 : 5;
  if (price >= 1000) return 2;
  if (price >= 1) return cls === 'crypto' && price < 100 ? 4 : 2;
  if (price >= 0.01) return 5;
  return 8;
}
function round(v, dp) { const f = Math.pow(10, dp); return Math.round(v * f) / f; }

/* ---- Calendar ---------------------------------------------------------------
   Days are identified by their UTC day number (00:00 UTC of the trading date /
   86400000), which is also every daily bar's t. */

function dayInfo(cls, dn) {
  const d = new Date(dn * DAY);
  const dow = d.getUTCDay();
  if (cls === 'crypto') return { trading: true, minutes: 1440, open: dn * DAY };
  if (dow === 0 || dow === 6) return { trading: false };
  if (cls === 'fx') return { trading: true, minutes: 1440, open: dn * DAY };
  const hol = holidayInfo(utcYmd(dn * DAY));
  if (hol && !hol.earlyClose) return { trading: false };
  return {
    trading: true,
    minutes: hol ? 210 : 390,
    open: zonedTimeToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 570, US_TZ),
  };
}
function prevTradingDay(cls, dn) {
  for (let i = 0; i < 15; i++) { dn--; if (dayInfo(cls, dn).trading) return dn; }
  return dn;
}

// The latest session at `now` and how far into it we are (minutes, fractional).
function nowState(cls, now) {
  if (cls === 'equity') {
    const p = zonedParts(now, US_TZ);
    const dn = Date.UTC(p.y, p.m - 1, p.d) / DAY;
    const di = dayInfo(cls, dn);
    if (di.trading && now >= di.open) return { lastDay: dn, elapsed: Math.min(di.minutes, (now - di.open) / MIN) };
    const ld = prevTradingDay(cls, dn);
    return { lastDay: ld, elapsed: dayInfo(cls, ld).minutes };
  }
  const dn = Math.floor(now / DAY);
  if (dayInfo(cls, dn).trading) return { lastDay: dn, elapsed: Math.max(1 / 60, (now - dn * DAY) / MIN) };
  const ld = prevTradingDay(cls, dn);
  return { lastDay: ld, elapsed: 1440 };
}

/* ---- The path ---------------------------------------------------------------- */

function dayReturn(P, dn) {
  const r = rng(P.sym + '|r|' + dn);
  let z = normal(r);
  if (r() < 0.03) z *= 2;   // the occasional fat-tailed day
  return { ret: P.drift + P.vol * z, z };
}

// One session as `steps` bars between open o and close c (a Brownian bridge in
// log space), plus the forming bar when the session is in progress (`upto` is
// fractional). Every per-step draw happens for the full session before any
// bar is cut, so a session's first hour is identical at 10:30 and at 16:00.
function sessionBars(P, dn, info, o, c, V, steps, upto) {
  const r = rng(P.sym + '|b|' + dn + '|' + steps);
  const sig = (P.vol * 0.85) / Math.sqrt(steps);
  const W = new Float64Array(steps + 1);
  for (let k = 1; k <= steps; k++) W[k] = W[k - 1] + normal(r) * sig;
  const lo = Math.log(o), lc = Math.log(c);
  const path = new Float64Array(steps + 1);
  for (let k = 0; k <= steps; k++) path[k] = lo + ((lc - lo) * k) / steps + W[k] - (k / steps) * W[steps];
  path[0] = lo; path[steps] = lc;

  const wickHi = new Float64Array(steps), wickLo = new Float64Array(steps), w = new Float64Array(steps);
  let wsum = 0;
  for (let k = 0; k < steps; k++) {
    wickHi[k] = Math.abs(normal(r)) * sig * 0.5;
    wickLo[k] = Math.abs(normal(r)) * sig * 0.5;
    const x = (k + 0.5) / steps;
    const shape = P.cls === 'equity' ? 0.55 + 2.6 * (2 * x - 1) * (2 * x - 1) + (x > 0.985 ? 2.5 : 0)
      : 1 + 0.35 * Math.sin(2 * Math.PI * (x - 0.3));
    w[k] = shape * Math.exp(0.45 * normal(r));
    wsum += w[k];
  }

  const stepMs = (info.minutes / steps) * MIN;
  const n = Math.min(steps, Math.ceil(upto - 1e-9));
  const out = [];
  for (let k = 0; k < n; k++) {
    const po = Math.exp(path[k]);
    const forming = k + 1 > upto;
    const pc = forming ? Math.exp(path[k] + (path[k + 1] - path[k]) * (upto - k)) : Math.exp(path[k + 1]);
    const oo = round(po, P.dp), cc = round(pc, P.dp);
    const hh = forming ? Math.max(oo, cc) : Math.max(oo, cc, round(Math.max(po, pc) * Math.exp(wickHi[k]), P.dp));
    const ll = forming ? Math.min(oo, cc) : Math.min(oo, cc, round(Math.min(po, pc) * Math.exp(-wickLo[k]), P.dp));
    const vol = V == null ? null : Math.round((V * w[k]) / wsum * (forming ? (upto - k) : 1));
    out.push({ t: info.open + k * stepMs, o: oo, h: hh, l: ll, c: cc, v: vol });
  }
  return out;
}

function summarize(bars, t) {
  let h = -Infinity, l = Infinity, v = 0, hasV = false;
  for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; if (b.v != null) { v += b.v; hasV = true; } }
  return { t, o: bars[0].o, h, l, c: bars[bars.length - 1].c, v: hasV ? v : null };
}

// Trading days (ascending) a request needs, before trimming.
function daysFor(P, range, interval, st, now) {
  const out = [];
  if (range === '1D' || range === '5D') {
    // Crypto's 1D is a rolling 24h, which reaches into yesterday's UTC day.
    let n = (range === '1D' ? 1 : 5) + (P.cls === 'crypto' && isIntraday(interval) ? 1 : 0);
    let dn = st.lastDay;
    while (n-- > 0) { out.unshift(dn); dn = prevTradingDay(P.cls, dn); }
    return out;
  }
  const floor = range === 'MAX' ? now - MAX_YEARS * 365.25 * DAY : rangeStart(range, now);
  const slack = interval === '1w' ? 7 : interval === '1M' ? 31 : 0;
  const first = Math.floor(floor / DAY) - slack;
  for (let dn = st.lastDay; dn >= first; dn--) if (dayInfo(P.cls, dn).trading) out.unshift(dn);
  return out;
}

// -> Bar[] for one symbol, oldest first. Pure given (DATA, sym, opts, now).
export function demoCandles(sym, { interval, range = '1D' } = {}, now = Date.now()) {
  if (!isInterval(interval)) interval = defaultInterval(range);
  const P = params(sym);
  const st = nowState(P.cls, now);
  const days = daysFor(P, range, interval, st, now);
  if (!days.length) return [];
  const before = prevTradingDay(P.cls, days[0]);
  const all = [before, ...days];

  // Closes, anchored at the session before the latest one.
  const R = prevTradingDay(P.cls, st.lastDay);
  const c = new Array(all.length);
  let ri = all.indexOf(R);
  if (ri < 0) {
    // R precedes the window only when the window is just the last day (1D).
    c[0] = P.anchor; ri = 0;
  } else c[ri] = P.anchor;
  for (let i = ri + 1; i < all.length; i++) c[i] = c[i - 1] * Math.exp(dayReturn(P, all[i]).ret);
  for (let i = ri; i > 0; i--) c[i - 1] = c[i] / Math.exp(dayReturn(P, all[i]).ret);

  const intra = isIntraday(interval);
  const out = [];
  for (let i = 1; i < all.length; i++) {
    const dn = all[i];
    const info = dayInfo(P.cls, dn);
    const gr = rng(P.sym + '|g|' + dn);
    const o = c[i - 1] * Math.exp(P.gap * normal(gr));
    const { z } = dayReturn(P, dn);
    const V = P.avgVolume == null ? null : P.avgVolume * Math.exp(0.3 * normal(gr) - 0.045) * (0.8 + 0.25 * Math.abs(z));
    const full = intra || (st.lastDay - dn) <= FULL_RES_DAYS;
    const steps = full ? info.minutes : (P.cls === 'equity' ? 26 : 48);
    const upto = dn === st.lastDay ? st.elapsed * (steps / info.minutes) : steps;
    const bars = sessionBars(P, dn, info, o, c[i], V, steps, upto);
    if (!bars.length) continue;
    if (intra) { for (const b of bars) out.push(b); }
    else out.push(summarize(bars, dn * DAY));
  }
  let res;
  if (intra) res = interval === '1m' ? out : aggregate(out, interval, P.cls);
  else res = interval === '1d' ? out : aggregate(out, interval, P.cls);
  return trimToRange(res, range, P.cls, interval, now);
}

/* ---- Quote, fundamentals, events, news (all read off the path) ------------- */

function demoQuoteFrom(sym, now) {
  const P = params(sym);
  const bars = demoCandles(sym, { interval: '1m', range: '1D' }, now);
  if (!bars.length) return null;
  const s = summarize(bars, bars[0].t);
  // Equities/FX: the anchored close is by construction the previous session's
  // close. Crypto: the price 24 hours ago, which is what its baseline claims.
  const prevClose = P.cls === 'crypto' ? bars[0].o : P.anchor;
  return { price: s.c, prevClose, open: s.o, high: s.h, low: s.l, volume: s.v, currency: P.currency };
}

function ymdOf(ms) { return utcYmd(ms); }
function weekdayOnOrAfter(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay();
  if (dow === 6) t.setUTCDate(t.getUTCDate() + 2);
  if (dow === 0) t.setUTCDate(t.getUTCDate() + 1);
  return t.getTime();
}

// Quarterly schedule from a {months, day} template, over [from, to] (ms).
function schedule(tpl, from, to) {
  const out = [];
  if (!tpl || !Array.isArray(tpl.months)) return out;
  const y0 = new Date(from).getUTCFullYear(), y1 = new Date(to).getUTCFullYear();
  for (let y = y0; y <= y1; y++) for (const m of tpl.months) {
    const t = weekdayOnOrAfter(y, m, tpl.day || 15);
    if (t >= from && t <= to) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function demoEvents(sym, now) {
  const t = DATA && DATA.tickers ? DATA.tickers[sym] : null;
  const f = t && t.fund;
  const empty = { earnings: [], dividends: [], splits: [] };
  if (!f) return empty;
  const from = now - 400 * DAY, to = now + 200 * DAY;
  const r = rng(sym + '|events');
  const earnings = schedule(f.earn, from, to).map((ts, i) => {
    const past = ts < now - DAY;
    const q = (num(f.eps) || 0) / 4;
    const est = q ? +(q * (1 + 0.02 * i / 4)).toFixed(2) : null;
    const act = past && est != null ? +(est * (1 + (r() - 0.4) * 0.12)).toFixed(2) : null;
    const rq = num(f.revenue) ? num(f.revenue) / 4 : null;
    return {
      date: ymdOf(ts), epsEstimate: est, epsActual: act,
      revenueEstimate: rq ? Math.round(rq * (1 + 0.01 * i)) : null,
      revenueActual: past && rq ? Math.round(rq * (1 + 0.01 * i) * (1 + (r() - 0.45) * 0.05)) : null,
      hour: (f.earn && f.earn.hour) || 'amc',
    };
  });
  const perPay = num(f.dps) ? num(f.dps) / ((f.div && f.div.months && f.div.months.length) || 4) : 0;
  const dividends = perPay ? schedule(f.div, from, to).map((ts) => ({
    exDate: ymdOf(ts), payDate: ymdOf(ts + 14 * DAY), amount: +perPay.toFixed(4), currency: params(sym).currency,
  })) : [];
  const splits = Array.isArray(f.splits) ? f.splits.map((s) => ({ date: s.date, ratio: num(s.ratio) })).filter((s) => s.ratio) : [];
  return { earnings, dividends, splits };
}

function demoFundamentals(sym, now) {
  const P = params(sym);
  const t = DATA && DATA.tickers ? DATA.tickers[sym] : null;
  if (P.cls === 'fx') return null;
  const f = (t && t.fund) || null;
  if (!f) return null;
  const bars = demoCandles(sym, { interval: '1d', range: '1Y' }, now);
  if (!bars.length) return null;
  const price = bars[bars.length - 1].c;
  let hi = bars[0], lo = bars[0];
  for (const b of bars) { if (b.h > hi.h) hi = b; if (b.l < lo.l) lo = b; }
  const avg = (n) => { const s = bars.slice(-n).map((b) => b.v).filter((v) => v != null); return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null; };
  const eps = num(f.eps), fEps = num(f.forwardEps), dps = num(f.dps), shares = num(f.shares);
  const pe = eps && eps > 0 ? price / eps : null;
  const out = {
    symbol: sym, source: 'demo', asOf: new Date(now).toISOString(),
    marketCap: shares ? price * shares : null,
    pe: pe != null ? +pe.toFixed(2) : null,
    forwardPe: fEps && fEps > 0 ? +(price / fEps).toFixed(2) : null,
    peg: pe != null && num(f.growth) ? +(pe / num(f.growth)).toFixed(2) : null,
    eps,
    ps: num(f.revenue) && shares ? +((price * shares) / num(f.revenue)).toFixed(2) : null,
    pb: num(f.pb),
    dividendYield: dps ? +((dps / price) * 100).toFixed(2) : (P.cls === 'equity' ? 0 : null),
    dividendPerShare: dps ?? (P.cls === 'equity' ? 0 : null),
    payoutRatio: dps && eps && eps > 0 ? +((dps / eps) * 100).toFixed(1) : null,
    beta: num(f.beta),
    high52: hi.h, low52: lo.l, high52Date: ymdOf(hi.t), low52Date: ymdOf(lo.t),
    avgVolume10d: avg(10), avgVolume3m: avg(63),
    sharesOutstanding: shares,
    revenueGrowth: num(f.revenueGrowth), profitMargin: num(f.profitMargin), roe: num(f.roe), debtToEquity: num(f.debtToEquity),
    currency: P.currency,
  };
  if (P.cls === 'crypto') {
    out.circulatingSupply = shares; out.maxSupply = num(f.maxSupply);
    out.dividendYield = null; out.dividendPerShare = null;
  }
  return out;
}

// Sample headlines generated from the path's own big days, so they line up with
// the chart. Every one is prefixed [Sample] and links nowhere.
function demoNews(sym, limit, now) {
  const P = params(sym);
  const t = DATA && DATA.tickers ? DATA.tickers[sym] : null;
  const name = (t && t.profile && t.profile.name) || sym;
  const bars = demoCandles(sym, { interval: '1d', range: '1M' }, now);
  const avgV = bars.length ? bars.map((b) => b.v || 0).reduce((a, b) => a + b, 0) / bars.length : 0;
  const items = [];
  for (let i = bars.length - 1; i > 0 && items.length < limit; i--) {
    const b = bars[i], prev = bars[i - 1];
    const pct = ((b.c - prev.c) / prev.c) * 100;
    if (Math.abs(pct) < P.vol * 100 * 0.6 && items.length >= 2) continue;
    const dir = pct >= 0 ? 'rises' : 'falls';
    const volWord = b.v == null || !avgV ? '' : b.v > avgV * 1.25 ? ' on heavier-than-usual volume' : b.v < avgV * 0.8 ? ' on lighter volume' : '';
    const ts = b.t + (P.cls === 'equity' ? 21 * 3600000 : 12 * 3600000);
    if (ts > now) continue;
    items.push({
      id: 'demo-' + sym + '-' + b.t,
      t: ts,
      headline: `[Sample] ${name} ${dir} ${Math.abs(pct).toFixed(1)}%${volWord}`,
      summary: 'Generated from the demo price series to show how news appears here. Not real news and not a real market event.',
      source: 'Carino sample feed',
      url: '',
    });
  }
  const ev = demoEvents(sym, now).earnings.find((e) => Date.parse(e.date) > now);
  if (ev && items.length < limit) items.push({
    id: 'demo-' + sym + '-earn-' + ev.date, t: now - 3 * 3600000,
    headline: `[Sample] ${name} scheduled to report quarterly results on ${ev.date}`,
    summary: 'Sample calendar note generated for demo mode.', source: 'Carino sample feed', url: '',
  });
  return items.sort((a, b) => b.t - a.t).slice(0, limit);
}

/* ---- Adapter ---------------------------------------------------------------- */

register({
  id: 'demo',
  label: 'Demo',
  needsKey: false,
  classes: ['equity', 'fx', 'crypto'],
  batch: true,
  hasSeries: true,
  candleIntervals: () => ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'],

  async quote(symbols) {
    await load();
    const now = Date.now();
    const out = {};
    for (const sym of symbols) {
      const t = DATA.tickers[sym];
      if (!t) continue;   // only bundled tickers get a demo QUOTE; candles work for any symbol
      const q = demoQuoteFrom(sym, now);
      if (!q) continue;
      // Crypto has no close to measure against, so claiming 'prev_close' over it
      // would have the demo assert the one thing the real crypto adapters go out
      // of their way not to.
      const crypto = classify(sym) === 'crypto';
      out[sym] = normQuote(sym, {
        ...q,
        baseline: crypto ? 'rolling_24h' : 'prev_close',
        baselineNote: crypto ? 'Sample data — not a real 24h window' : 'Sample data — not a real close',
        // The sample calendar is not evidence that anything is trading.
        session: null,
      }, 'demo');
    }
    return out;
  },

  async candles(sym, { interval, range } = {}) {
    await load();
    return demoCandles(sym, { interval, range });
  },

  // Legacy closes-only series (sparklines). The facade now builds series on
  // candles; kept so the adapter still satisfies the old contract.
  async series(sym, range = '1D') {
    await load();
    return demoCandles(sym, { range }).map((b) => b.c);
  },

  async profile(sym) {
    const d = await load();
    return d.tickers[sym]?.profile || null;
  },

  async fundamentals(sym) { await load(); return demoFundamentals(sym, Date.now()); },
  async news(sym, { limit = 10 } = {}) { await load(); return demoNews(sym, limit, Date.now()); },
  async events(sym) { await load(); return demoEvents(sym, Date.now()); },

  async calendar({ from, to } = {}) {
    const d = await load();
    const now = Date.now();
    const lo = Date.parse(from || ymdOf(now)), hi = Date.parse(to || ymdOf(now + 30 * DAY));
    const earnings = [];
    for (const sym of Object.keys(d.tickers)) {
      for (const e of demoEvents(sym, now).earnings) {
        const ts = Date.parse(e.date);
        if (ts >= lo && ts <= hi) earnings.push({ date: e.date, symbol: sym, epsEstimate: e.epsEstimate, hour: e.hour });
      }
    }
    earnings.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
    return { earnings, ipos: [] };
  },

  async search(q) {
    const d = await load();
    q = q.toUpperCase();
    return Object.values(d.tickers)
      .filter((t) => t.profile.symbol.includes(q) || t.profile.name.toUpperCase().includes(q))
      .slice(0, 12)
      .map((t) => ({ symbol: t.profile.symbol, description: t.profile.name }));
  },

  // Sample data has no clock. The old { isOpen: true } was what made the market
  // strip announce OPEN at 3am on a Sunday — a fabricated fact dressed as a
  // provider report. The local calendar answers this now.
  async marketStatus() { return null; },
});

// Exported for tests and the demo.json regenerator.
export const __demo = { demoQuoteFrom, demoFundamentals, demoEvents, demoNews, params, nowState, ymd };
