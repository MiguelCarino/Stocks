/* providers/candles.js — the time vocabulary of the bar pipeline, shared by every
   adapter and the facade: intervals, range presets, the window a range covers,
   trimming upstream bars to that window, aggregation to coarser bars, and the
   two localStorage caches (stk_candles for bars, stk_meta for fundamentals /
   news / events).

   TIMESTAMP CONVENTION. A bar's t is the epoch ms at which the bar OPENS.
   Intraday bars carry the real instant. Daily, weekly and monthly bars carry
   00:00 UTC of the bar's trading DATE (the exchange-local date) — never a
   midnight in New York, which is 04:00 or 05:00 UTC depending on DST and would
   make Friday's bar render as Thursday for every viewer west of Greenwich.
   Format daily+ ticks with timeZone 'UTC'. Every adapter normalizes to this.

   No DOM, no fetching. localStorage is touched only through guarded helpers so
   the module also loads under node --test. */

/* ---- Intervals and ranges ------------------------------------------------- */

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const INTERVALS = [
  { id: '1m', ms: MIN, label: '1 minute', intraday: true },
  { id: '5m', ms: 5 * MIN, label: '5 minutes', intraday: true },
  { id: '15m', ms: 15 * MIN, label: '15 minutes', intraday: true },
  { id: '30m', ms: 30 * MIN, label: '30 minutes', intraday: true },
  { id: '1h', ms: 60 * MIN, label: '1 hour', intraday: true },
  { id: '1d', ms: DAY, label: '1 day', intraday: false },
  { id: '1w', ms: 7 * DAY, label: '1 week', intraday: false },
  { id: '1M', ms: 30 * DAY, label: '1 month', intraday: false },   // nominal; months are bucketed by calendar
];
const INTERVAL_BY_ID = Object.fromEntries(INTERVALS.map((i) => [i.id, i]));

// Range presets, each with its default interval and the intervals that make a
// readable chart over that span (a 5-year chart of 1-minute bars is ~500k bars
// that no free tier will serve). `fallback` is what 1M drops to when the routed
// provider has no free intraday data (Alpha Vantage).
export const RANGES = [
  { id: '1D', label: '1 day', interval: '5m', intervals: ['1m', '5m', '15m', '30m', '1h'] },
  { id: '5D', label: '5 days', interval: '15m', intervals: ['5m', '15m', '30m', '1h'] },
  { id: '1M', label: '1 month', interval: '1h', fallback: '1d', intervals: ['15m', '30m', '1h', '1d'] },
  { id: '3M', label: '3 months', interval: '1d', intervals: ['1h', '1d', '1w'] },
  { id: '6M', label: '6 months', interval: '1d', intervals: ['1d', '1w'] },
  { id: 'YTD', label: 'Year to date', interval: '1d', intervals: ['1d', '1w'] },
  { id: '1Y', label: '1 year', interval: '1d', intervals: ['1d', '1w'] },
  { id: '2Y', label: '2 years', interval: '1d', intervals: ['1d', '1w', '1M'] },
  { id: '5Y', label: '5 years', interval: '1w', intervals: ['1d', '1w', '1M'] },
  { id: 'MAX', label: 'All available', interval: '1M', intervals: ['1d', '1w', '1M'] },
];
const RANGE_BY_ID = Object.fromEntries(RANGES.map((r) => [r.id, r]));

export function intervalMs(id) { return (INTERVAL_BY_ID[id] || INTERVAL_BY_ID['1d']).ms; }
export function isIntraday(id) { return !!(INTERVAL_BY_ID[id] && INTERVAL_BY_ID[id].intraday); }
export function isInterval(id) { return !!INTERVAL_BY_ID[id]; }
export function rangeSpec(id) { return RANGE_BY_ID[id] || null; }
export function defaultInterval(range) { return (RANGE_BY_ID[range] || RANGE_BY_ID['1D']).interval; }

// Intervals ordered fine -> coarse, for "nearest coarser one the provider has".
export function coarserIntervals(id) {
  const i = INTERVALS.findIndex((x) => x.id === id);
  return i < 0 ? [] : INTERVALS.slice(i + 1).map((x) => x.id);
}

/* ---- Exchange-local time --------------------------------------------------
   A trimmed copy of the zonedParts / zonedTimeToMs pair in session.js, which
   does not export them. Restated rather than imported for the same reason
   session.js restates its own grid: the provider layer must not be broken by a
   refactor of the calendar engine. */

export const US_TZ = 'America/New_York';
const FMT = new Map();
function fmt(tz) {
  if (FMT.has(tz)) return FMT.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { f = null; }
  FMT.set(tz, f);
  return f;
}

// -> { y, m, d, minutes } wall clock in tz (UTC when Intl cannot do the zone).
export function zonedParts(ms, tz = US_TZ) {
  const f = tz === 'UTC' ? null : fmt(tz);
  if (!f) { const u = new Date(ms); return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), minutes: u.getUTCHours() * 60 + u.getUTCMinutes() }; }
  let y = 0, m = 0, d = 0, h = 0, mi = 0;
  for (const p of f.formatToParts(ms)) {
    if (p.type === 'year') y = +p.value;
    else if (p.type === 'month') m = +p.value;
    else if (p.type === 'day') d = +p.value;
    else if (p.type === 'hour') h = +p.value;
    else if (p.type === 'minute') mi = +p.value;
  }
  return { y, m, d, minutes: h * 60 + mi };
}

export function zonedTimeToMs(y, m, d, minutes, tz = US_TZ) {
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN;
  if (tz === 'UTC') return wall;
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const delta = wall - (Date.UTC(p.y, p.m - 1, p.d) + p.minutes * MIN);
    if (!delta) break;
    guess += delta;
  }
  return guess;
}

export function pad2(n) { return n < 10 ? '0' + n : String(n); }
export function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
export function utcYmd(ms) { const u = new Date(ms); return ymd(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()); }

// The calendar the asset class trades on: exchange-local dates for equities,
// UTC dates for crypto and FX (FX really rolls at 17:00 New York; UTC is the
// convention every free FX feed here uses for its daily bars).
export function tzFor(cls) { return cls === 'equity' ? US_TZ : 'UTC'; }

// 'YYYY-MM-DD' (or a full ISO / 'YYYY-MM-DD HH:MM:SS' string) -> 00:00 UTC of that date.
export function dateToUtcMidnight(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

// An instant -> 00:00 UTC of its date in tz. For upstream daily bars stamped at
// exchange midnight (Polygon, Alpaca) this recovers the trading date.
export function dayStartUtc(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d);
}

/* ---- Range windows -------------------------------------------------------- */

// Lower bound (epoch ms) of a calendar range. 1D/5D are counted in sessions,
// not hours, and are trimmed by trimToRange instead — this only gives a
// generous fetch window for them.
export function rangeStart(range, now = Date.now()) {
  const u = new Date(now);
  const Y = u.getUTCFullYear(), M = u.getUTCMonth(), D = u.getUTCDate();
  switch (range) {
    case '1D': return Date.UTC(Y, M, D - 5);
    case '5D': return Date.UTC(Y, M, D - 10);
    case '1M': return Date.UTC(Y, M - 1, D);
    case '3M': return Date.UTC(Y, M - 3, D);
    case '6M': return Date.UTC(Y, M - 6, D);
    case 'YTD': return Date.UTC(Y, 0, 1);
    case '1Y': return Date.UTC(Y - 1, M, D);
    case '2Y': return Date.UTC(Y - 2, M, D);
    case '5Y': return Date.UTC(Y - 5, M, D);
    case 'MAX': return Date.UTC(Y - 30, 0, 1);
    default: return Date.UTC(Y, M, D - 5);
  }
}

// Rough bar count a range needs at an interval, for count-based APIs (Twelve
// Data outputsize, Alpaca limit). Over-asks by a margin; trimToRange cuts.
export function estimateBars(range, interval, cls, now = Date.now()) {
  const ms = intervalMs(interval);
  if (range === '1D' || range === '5D') {
    const sessions = range === '1D' ? 2 : 6;   // one spare session for "the last" across a weekend
    if (!isIntraday(interval)) return sessions + 2;
    const perSession = cls === 'equity' ? 390 * MIN : DAY;
    return Math.ceil((sessions * perSession) / ms) + 10;
  }
  const spanDays = (now - rangeStart(range, now)) / DAY;
  const tradingFrac = cls === 'crypto' ? 1 : (5 / 7);
  if (!isIntraday(interval)) {
    if (interval === '1d') return Math.ceil(spanDays * tradingFrac) + 5;
    if (interval === '1w') return Math.ceil(spanDays / 7) + 2;
    return Math.ceil(spanDays / 30) + 2;
  }
  const perDay = cls === 'equity' ? 390 * MIN : DAY;
  return Math.ceil((spanDays * tradingFrac * perDay) / ms) + 10;
}

// Cut a sorted bar array to the range. 1D/5D keep the last 1 / 5 trading
// DATES present in the data (exchange-local for equities) — "the last session",
// not "the last 24 hours", which on a Monday morning would be an empty chart.
// Crypto has no sessions, so its 1D/5D are rolling 24h / 120h windows.
export function trimToRange(bars, range, cls, interval, now = Date.now()) {
  if (!Array.isArray(bars) || !bars.length) return [];
  if (range === '1D' || range === '5D') {
    const n = range === '1D' ? 1 : 5;
    if (!isIntraday(interval)) return bars.slice(-n);
    if (cls === 'crypto') {
      const last = bars[bars.length - 1].t;
      const cut = last - n * DAY + intervalMs(interval);
      return bars.filter((b) => b.t >= cut);
    }
    const tz = tzFor(cls);
    const keys = [];
    let lastKey = null;
    const keyed = bars.map((b) => {
      const p = zonedParts(b.t, tz);
      const k = ymd(p.y, p.m, p.d);
      if (k !== lastKey) { keys.push(k); lastKey = k; }
      return k;
    });
    const keep = new Set(keys.slice(-n));
    return bars.filter((_, i) => keep.has(keyed[i]));
  }
  if (range === 'MAX') return bars;
  const from = rangeStart(range, now);
  // A weekly/monthly bar is stamped at its first day, which can precede the
  // range start by up to a bucket; keep the bucket that straddles it.
  const slack = interval === '1w' ? 7 * DAY : interval === '1M' ? 31 * DAY : 0;
  return bars.filter((b) => b.t >= from - slack);
}

/* US regular-session filter (09:30-16:00 New York, 13:00 on a half day is not
   modelled here — a few after-close bars on Black Friday are an acceptable
   miss). Applied to Polygon and Alpaca intraday bars, which include extended
   hours; Twelve Data returns the regular session unless prepost is asked for. */
export function regularSessionOnly(bars) {
  return bars.filter((b) => { const m = zonedParts(b.t, US_TZ).minutes; return m >= 570 && m < 960; });
}

/* ---- Aggregation ---------------------------------------------------------- */

// Combine sorted bars into coarser buckets. Intraday buckets align to the
// SESSION start (09:30 ET -> 09:30, 10:30, ... for 1h), the way every charting
// package does, rather than to the clock hour, which would leave a 30-minute
// stub bar at the open. Weekly buckets start Monday, monthly on the 1st.
export function aggregate(bars, interval, cls = 'equity') {
  if (!Array.isArray(bars) || !bars.length) return [];
  const ms = intervalMs(interval);
  const tz = tzFor(cls);
  const out = [];
  let cur = null, curKey = null;
  let sessionKey = null, sessionStart = 0;
  const srcIntraday = bars.length > 1 ? (bars[1].t - bars[0].t) < DAY * 0.9 : bars[0].t % DAY !== 0;
  for (const b of bars) {
    let key;
    if (interval === '1w') {
      const d = new Date(b.t); const dow = (d.getUTCDay() + 6) % 7;   // Monday = 0
      key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
    } else if (interval === '1M') {
      const d = new Date(b.t); key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    } else if (interval === '1d') {
      key = srcIntraday ? dayStartUtc(b.t, tz) : b.t;
    } else {
      // Session-anchored intraday bucket. A new session begins when the local
      // date changes; its first bar is the anchor.
      const p = zonedParts(b.t, tz);
      const sk = ymd(p.y, p.m, p.d);
      if (sk !== sessionKey) { sessionKey = sk; sessionStart = cls === 'equity' ? zonedTimeToMs(p.y, p.m, p.d, 570, tz) : Date.UTC(p.y, p.m - 1, p.d); }
      key = sessionStart + Math.floor((b.t - sessionStart) / ms) * ms;
    }
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { t: (interval === '1w' || interval === '1M') ? b.t : key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      curKey = key;
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v = (cur.v == null || b.v == null) ? (cur.v ?? b.v ?? null) : cur.v + b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* Bars from a series of (t, price) samples — CoinGecko's market_chart is the
   only source here that needs it. o is the previous bucket's close (crypto
   trades continuously, so that IS where the next bar opened), h/l are the
   extremes of the samples, which understates true highs and lows when a bucket
   holds one or two samples. Callers flag that as partial. */
export function barsFromSamples(samples, interval, cls = 'crypto') {
  const ms = intervalMs(interval);
  const out = [];
  let cur = null, prevClose = null;
  for (const [t, p] of samples) {
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    let key;
    if (interval === '1w') { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); }
    else if (interval === '1M') { const d = new Date(t); key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
    else key = Math.floor(t / ms) * ms;
    if (!cur || cur.t !== key) {
      if (cur) { out.push(cur); prevClose = cur.c; }
      const o = prevClose ?? p;
      cur = { t: key, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: null, _n: 1 };
    } else {
      if (p > cur.h) cur.h = p;
      if (p < cur.l) cur.l = p;
      cur.c = p; cur._n++;
    }
  }
  if (cur) out.push(cur);
  for (const b of out) delete b._n;
  return out;
}

/* ---- Bounded localStorage caches -------------------------------------------
   One JSON object per key, insertion order = recency (a hit re-inserts). Both
   caches are disposable: every failure path degrades to memory-only, and a
   quota error evicts half the entries before giving up. The store's reclaim()
   is asked (see report) to drop these keys first under pressure. */

function lsGet(key) {
  try { if (typeof localStorage === 'undefined') return null; const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function lsSet(key, val) {
  try { if (typeof localStorage === 'undefined') return false; localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}
function lsRemove(key) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch (e) { /* nothing to do */ } }

export function createLRU(storageKey, { max = 40, maxBytes = 1500000, maxEntryBytes = 250000, pack, unpack } = {}) {
  let map = null;
  let timer = null;
  function load() {
    if (map) return map;
    map = new Map();
    const raw = storageKey ? lsGet(storageKey) : null;
    if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) map.set(k, raw[k]);
    return map;
  }
  function flush() {
    timer = null;
    if (!storageKey) return;
    const m = load();
    // Serialize, then shed oldest entries until the whole blob fits the budget.
    let obj = {}, size = 2;
    const entries = [...m.entries()].reverse();   // newest first
    const kept = [];
    for (const [k, v] of entries) {
      const s = JSON.stringify(v);
      if (s.length > maxEntryBytes) continue;     // too big to persist; stays in memory
      if (size + s.length + k.length + 4 > maxBytes) break;
      size += s.length + k.length + 4;
      kept.push([k, v]);
    }
    for (const [k, v] of kept.reverse()) obj[k] = v;
    if (!lsSet(storageKey, obj)) {
      // Quota: keep the newest half and try once more, then give up quietly.
      const half = kept.slice(-Math.floor(kept.length / 2));
      obj = {}; for (const [k, v] of half) obj[k] = v;
      if (!lsSet(storageKey, obj)) lsRemove(storageKey);
    }
  }
  function schedule() {
    if (timer || !storageKey) return;
    timer = typeof setTimeout === 'function' ? setTimeout(flush, 800) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();   // never hold node --test open
  }
  return {
    get(k) {
      const m = load();
      if (!m.has(k)) return null;
      const v = m.get(k);
      m.delete(k); m.set(k, v);   // refresh recency
      return unpack ? unpack(v) : v;
    },
    peek(k) { const m = load(); return m.has(k) ? (unpack ? unpack(m.get(k)) : m.get(k)) : null; },
    set(k, v) {
      const m = load();
      m.delete(k); m.set(k, pack ? pack(v) : v);
      while (m.size > max) m.delete(m.keys().next().value);
      schedule();
    },
    delete(k) { const m = load(); if (m.delete(k)) schedule(); },
    clear() { map = new Map(); lsRemove(storageKey); },
    // Forget the in-memory copy so the next read re-loads storage. For a
    // read-only window (a popout) that another window keeps writing.
    reload() { if (!timer) map = null; },
    size() { return load().size; },
    flush,
  };
}

// Bars persist as [t,o,h,l,c,v] tuples: roughly half the bytes of objects.
function packEntry(e) { return { at: e.at, src: e.src, iv: e.interval, p: e.partial ? 1 : 0, n: e.note || undefined, b: e.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]) }; }
function unpackEntry(e) {
  if (!e || !Array.isArray(e.b)) return null;
  return { at: e.at, src: e.src, interval: e.iv, partial: !!e.p, note: e.n || null, bars: e.b.map((a) => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] ?? null })) };
}

export const CANDLE_KEY = 'stk_candles';
export const META_KEY = 'stk_meta';
export const candleCache = createLRU(CANDLE_KEY, { max: 40, maxBytes: 1500000, maxEntryBytes: 250000, pack: packEntry, unpack: unpackEntry });
export const metaCache = createLRU(META_KEY, { max: 150, maxBytes: 400000, maxEntryBytes: 60000 });

// How long a bar set is fresh: about one bar for intraday, clamped to 1-5 min;
// 15 min for daily and coarser (the last bar still moves during the session).
export function candleTTL(interval) {
  if (!isIntraday(interval)) return 15 * MIN;
  return Math.max(MIN, Math.min(5 * MIN, intervalMs(interval) / 2));
}
