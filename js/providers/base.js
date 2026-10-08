/* providers/base.js — the adapter contract every data source implements, plus
   the normalized shapes the rest of the app is allowed to see. Adding a provider
   (or WebSocket streaming, or a self-hosted proxy) is a new module behind this
   boundary — never a change to the UI.

   Two things here are load-bearing beyond the shape itself.

   BASELINE. Every vendor ships a "change" and a "change percent", and they are
   not the same measurement. Finnhub's pc is the official regular-session close.
   Polygon's prevDay.c is a full-day aggregate that includes extended-hours
   prints. Alpaca's is IEX-only, roughly two percent of consolidated volume.
   CoinGecko's is a synthetic rolling 24-hour window that has no close in it at
   all. Rendering all four as "Today" is a quiet lie, so each adapter states its
   baseline and the UI is expected to label the number accordingly.

   BUDGET. Instrumentation lives in getJSON, not in market.quotes(), because the
   two counts differ by more than an order of magnitude: Finnhub has no batch
   quote endpoint, so one logical refresh of a twenty-symbol watchlist is twenty
   HTTP requests. Counting at the facade would report one. Free tiers are priced
   in HTTP requests, so that is what gets counted. */

// Normalized quote — the ONLY quote shape the UI consumes:
//   { symbol, price, prevClose, change, changePct, high, low, open, volume,
//     currency, baseline, baselineNote, session, source, ts }
const SESSIONS = new Set(['pre', 'open', 'post', 'closed']);
const BASELINES = new Set(['prev_close', 'rolling_24h', 'unknown']);

export function normQuote(symbol, q, source) {
  const price = num(q.price ?? q.c);
  const prevClose = num(q.prevClose ?? q.pc);
  const change = q.change != null ? num(q.change) : (price != null && prevClose != null ? price - prevClose : null);
  const changePct = q.changePct != null ? num(q.changePct)
    : (change != null && prevClose ? (change / prevClose) * 100 : null);
  return {
    symbol,
    price, prevClose, change, changePct,
    open: num(q.open ?? q.o), high: num(q.high ?? q.h), low: num(q.low ?? q.l),
    volume: num(q.volume ?? q.v),
    // null, not 'USD'. Most endpoints here are USD by construction (a US-locale
    // snapshot, a vs_currency=usd market) and say so explicitly; the ones that
    // quote foreign listings without naming a currency must not be dressed up
    // as dollars just because a default was convenient.
    currency: q.currency || null,
    // Whatever the change/changePct above are actually measured against.
    baseline: BASELINES.has(q.baseline) ? q.baseline : 'unknown',
    // One clause of prose for a tooltip, where the three-value vocabulary above
    // is too coarse to distinguish an official close from an IEX-only one.
    baselineNote: q.baselineNote || null,
    // Provider-ASSERTED session. Never inferred from a clock, never guessed
    // from a price timestamp: a wrong badge is worse than an absent one.
    session: SESSIONS.has(q.session) ? q.session : null,
    source,
    // Only Finnhub reports a timestamp for the print itself; for every other
    // adapter this is the moment WE fetched, which is a different fact. Keeping
    // both under one field made 'As of' claim a precision it did not have, and
    // left a frozen quote indistinguishable from a fresh one — the fetch time
    // advances on every poll even when the price behind it has not moved since
    // Friday. tsSource lets a reader be told which of the two they are looking at.
    ts: q.ts || Date.now(),
    tsSource: q.ts != null ? 'provider' : 'fetch',
  };
}

export function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ---- Call budget -----------------------------------------------------------
   A rolling hour of request timestamps. Deliberately in-memory only: persisting
   would mean a localStorage write per HTTP request, and the number this answers
   ("am I about to burn my free tier right now") is a question about the current
   session anyway. stats() is cheap enough to call from a render. */

const WINDOW_MS = 3600 * 1000;
const NOTIFY_MS = 250;      // one burst of twenty Finnhub calls should wake the UI once, not twenty times.

const calls = [];           // [{ t, p }], append-only within the window, oldest first
const budgetListeners = new Set();
const started = Date.now();
let notifyTimer = null;

function prune(now) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < calls.length && calls[i].t < cutoff) i++;
  if (i) calls.splice(0, i);
}

function notifyBudget() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const s = budget.stats();
    for (const cb of [...budgetListeners]) { try { cb(s); } catch (e) { /* one bad listener must not stop the rest */ } }
  }, NOTIFY_MS);
}

export const budget = {
  // Called at the top of getJSON — before the fetch, because the request counts
  // against the quota whether or not it comes back.
  record(providerId) {
    const now = Date.now();
    prune(now);
    calls.push({ t: now, p: providerId || 'unknown' });
    notifyBudget();
  },

  stats() {
    const now = Date.now();
    prune(now);
    const minCut = now - 60 * 1000;
    const byProvider = {};
    let lastMin = 0;
    for (const c of calls) {
      const row = byProvider[c.p] || (byProvider[c.p] = { lastMin: 0, lastHour: 0 });
      row.lastHour++;
      if (c.t >= minCut) { row.lastMin++; lastMin++; }
    }
    // `since` is when the window actually starts: the counter's own birth until
    // an hour has passed, the rolling cutoff after that. Without it a reading of
    // "12 calls in the last hour" is unreadable thirty seconds after load.
    return { lastMin, lastHour: calls.length, byProvider, since: Math.max(started, now - WINDOW_MS) };
  },

  on(cb) { if (typeof cb === 'function') budgetListeners.add(cb); },
  off(cb) { budgetListeners.delete(cb); },
};

/* ---- Normalized bar -------------------------------------------------------
   { t: epoch ms (bar OPEN; daily+ = 00:00 UTC of the trading date, see
   candles.js), o, h, l, c, v: number|null }. A bar that cannot be drawn
   honestly is dropped rather than repaired: non-finite prices, a non-positive
   price, or a high/low that does not contain the open and close. Repairing it
   (clamping h up to c) would invent a print nobody made. Volume is null — never
   0 — when the feed has none (spot FX, CoinGecko OHLC), so a chart can tell
   "no volume data" from "nothing traded". */

export function normBar(b) {
  if (!b) return null;
  const t = typeof b.t === 'number' ? b.t : (b.t != null ? Date.parse(b.t) : NaN);
  const o = num(b.o), h = num(b.h), l = num(b.l), c = num(b.c);
  if (!Number.isFinite(t) || o == null || h == null || l == null || c == null) return null;
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  // A hair of tolerance: some feeds round h/l and o/c to different precisions.
  const eps = Math.max(h, 1e-12) * 1e-9;
  if (h + eps < Math.max(o, c) || l - eps > Math.min(o, c) || l > h) return null;
  const v = num(b.v);
  return { t, o, h, l, c, v: v == null || v < 0 ? null : v };
}

// Normalize, drop invalid, sort oldest-first and de-duplicate on t (the LAST
// occurrence wins — upstream pagination overlaps repeat the bar with fresher data).
export function normBars(arr) {
  if (!Array.isArray(arr)) return [];
  const byT = new Map();
  for (const raw of arr) { const b = normBar(raw); if (b) byT.set(b.t, b); }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/* ---- Typed errors -----------------------------------------------------------
   One vocabulary for every adapter and the facade, so the UI can say "your key
   was rejected" instead of "no data":
     rateLimited  HTTP 429, a throttle body, or the local pacer refusing to queue
     authError    HTTP 401, or a body that says the key is invalid
     premium      the endpoint exists but not on the free plan (HTTP 402/403, or
                  a body saying so) — permanent for this key, not worth retrying
     timeout      our own abort fired
     network      fetch threw (offline, DNS, CORS)
   `daily` is set on rateLimited when it is the per-DAY cap that is spent. */

export function apiError(kind, message, extra) {
  const e = new Error(message || kind);
  e.kind = kind;
  e[kind] = true;
  if (extra) Object.assign(e, extra);
  return e;
}
export function errorKind(e) {
  if (!e) return null;
  return e.kind || (e.rateLimited ? 'rateLimited' : e.authError ? 'authError' : e.premium ? 'premium' : e.timeout ? 'timeout' : e.network ? 'network' : 'error');
}

/* ---- Published free-tier limits + pacing -----------------------------------
   The figures each vendor publishes for its FREE tier (late 2025). They are the
   pacer's ceiling, not a promise: vendors change them, and a paid key simply
   never hits the pacer's wait. perSec guards burst limits that are separate
   from the minute cap (Finnhub's 30/s). Daily counts reset at 00:00 UTC, which
   is what Twelve Data and Alpha Vantage use. */

export const LIMITS = {
  finnhub: { perMin: 60, perSec: 25, perDay: null, note: '60 calls/minute' },
  twelvedata: { perMin: 8, perDay: 800, note: '8 credits/minute, 800/day (a batched quote costs one credit per symbol)' },
  polygon: { perMin: 5, perDay: null, note: '5 calls/minute, end-of-day / delayed data' },
  alpaca: { perMin: 200, perDay: null, note: '200 calls/minute, IEX feed' },
  alphavantage: { perMin: 5, perDay: 25, note: '25 calls/day' },
  coingecko: { perMin: 10, perDay: null, note: '~10 calls/minute without a key (shared, varies)' },
  demo: { perMin: null, perDay: null, note: 'Bundled sample data — no network' },
};

/* Per-provider pacer. A queue per provider; a request leaves the queue only when
   the trailing-minute count (and the trailing-second count, and today's count)
   is under the limit. Higher `priority` leaves first (visible chart > armed
   alerts > screener > sparklines), FIFO within a priority. A request whose
   projected wait exceeds its maxWait is rejected as rateLimited rather than
   parked for minutes: a stale sparkline is better skipped than delivered late.
   Time and timers are injectable so the logic is testable without a clock. */

export function createPacer({ limits = LIMITS, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), persist = null } = {}) {
  const state = new Map();   // id -> { min: [t], sec: [t], day, dayKey, queue: [], timer, cooldownUntil }
  const dayKeyOf = (t) => new Date(t).toISOString().slice(0, 10);
  const saved = persist ? persist.load() : null;

  function st(id) {
    let s = state.get(id);
    if (!s) {
      const dk = dayKeyOf(now());
      const day = saved && saved.day === dk && saved.by && Number.isFinite(saved.by[id]) ? saved.by[id] : 0;
      s = { min: [], sec: [], day, dayKey: dk, queue: [], timer: null, cooldownUntil: 0, seq: 0 };
      state.set(id, s);
    }
    const dk = dayKeyOf(now());
    if (s.dayKey !== dk) { s.dayKey = dk; s.day = 0; }
    return s;
  }

  // ms until the next slot opens for this provider (0 = now, Infinity = not today).
  function waitFor(id, cost = 1) {
    const L = limits[id] || {};
    const s = st(id);
    const t = now();
    while (s.min.length && s.min[0] <= t - 60000) s.min.shift();
    while (s.sec.length && s.sec[0] <= t - 1000) s.sec.shift();
    if (L.perDay && s.day >= L.perDay) return Infinity;
    let w = Math.max(0, s.cooldownUntil - t);
    // A request costing more credits than a whole minute holds (a 20-symbol
    // Twelve Data batch on an 8/min plan) waits for an empty minute, then goes.
    const c = L.perMin ? Math.min(cost, L.perMin) : cost;
    if (L.perMin && s.min.length + c > L.perMin) w = Math.max(w, s.min[s.min.length - (L.perMin - c) - 1] + 60000 - t);
    if (L.perSec && s.sec.length >= L.perSec) w = Math.max(w, s.sec[s.sec.length - L.perSec] + 1000 - t);
    return w;
  }

  function take(id, cost = 1) {
    const s = st(id); const t = now();
    for (let i = 0; i < cost; i++) s.min.push(t);
    s.sec.push(t); s.day += cost;
    if (persist) persist.save(snapshotDay());
  }

  function snapshotDay() {
    const dk = dayKeyOf(now()); const by = {};
    for (const [id, s] of state) if (s.dayKey === dk) by[id] = s.day;
    return { day: dk, by };
  }

  function pump(id) {
    const s = st(id);
    if (s.timer) return;
    while (s.queue.length) {
      s.queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
      const w = waitFor(id, s.queue[0].cost);
      if (w === Infinity) {
        // Daily cap spent: everything queued fails now; nothing frees up before midnight UTC.
        for (const job of s.queue.splice(0)) job.reject(apiError('rateLimited', id + ' daily limit reached', { daily: true, provider: id }));
        return;
      }
      if (w > 0) {
        // Drop the jobs that would wait past their own patience, then sleep.
        const keep = [];
        for (const job of s.queue) { if (now() + w - job.queuedAt > job.maxWait) job.reject(apiError('rateLimited', id + ' is paced — try again shortly', { queued: true, provider: id, retryInMs: w })); else keep.push(job); }
        s.queue = keep;
        if (!s.queue.length) return;
        s.timer = setTimer(() => { s.timer = null; pump(id); }, w + 5);
        return;
      }
      const job = s.queue.shift();
      take(id, job.cost);
      job.resolve();
    }
  }

  return {
    // Resolves when a slot is granted (the caller then fires the request).
    acquire(id, { priority = 1, maxWait = 30000, cost = 1 } = {}) {
      const L = limits[id];
      if (!L || (!L.perMin && !L.perDay && !L.perSec)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const s = st(id);
        s.queue.push({ resolve, reject, priority, maxWait, cost: Math.max(1, cost | 0), queuedAt: now(), seq: s.seq++ });
        pump(id);
      });
    },
    // A 429 from upstream: stop sending to this provider for a while.
    penalize(id, ms = 60000) { const s = st(id); s.cooldownUntil = Math.max(s.cooldownUntil, now() + ms); },
    // Estimated ms before `n` more calls could complete on this provider.
    forecast(id, n = 1) {
      const L = limits[id] || {};
      const s = st(id);
      if (L.perDay && s.day + n > L.perDay) return Infinity;
      if (!L.perMin) return 0;
      const ahead = s.queue.length + n;
      const free = Math.max(0, L.perMin - s.min.length);
      if (ahead <= free) return Math.max(0, s.cooldownUntil - now());
      return Math.ceil((ahead - free) / L.perMin) * 60000;
    },
    usage(id) {
      const s = st(id); waitFor(id);
      return { usedMin: s.min.length, usedDay: s.day, queued: s.queue.length, cooldownUntil: s.cooldownUntil > now() ? s.cooldownUntil : null };
    },
  };
}

// Daily counters survive a reload: otherwise a reload resets Alpha Vantage's
// 25/day to zero in our books while the vendor keeps counting.
const QUOTA_KEY = 'stk_quota';
const quotaPersist = {
  load() { try { return typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(QUOTA_KEY) || 'null') : null; } catch (e) { return null; } },
  _t: null, _v: null,
  save(v) {
    this._v = v;
    if (this._t || typeof setTimeout !== 'function') return;
    this._t = setTimeout(() => {
      this._t = null;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(QUOTA_KEY, JSON.stringify(this._v)); } catch (e) { /* quota: counters stay in memory */ }
    }, 2000);
    if (this._t && typeof this._t.unref === 'function') this._t.unref();
  },
};

export const pacer = createPacer({ persist: quotaPersist });

/* ---- getJSON ---------------------------------------------------------------
   Fetch JSON with a timeout through the provider's pacer. Concurrent requests
   for the same URL share one fetch (a chart and a screener asking for the same
   daily bars in the same tick cost one credit). Options:
     provider   budget + pacing attribution — every adapter passes its own id
     priority   0 background · 1 normal (default) · 2 interactive/visible
     maxWait    ms the request may sit in the pacer queue before failing
     text       resolve the body as text (Alpha Vantage's CSV calendar)
     cost       credits the call spends (Twelve Data bills a batch per symbol)
   Errors are typed (see apiError). */

const inflight = new Map();

export function getJSON(url, { timeoutMs = 9000, headers, provider, priority = 1, maxWait = 30000, text = false, cost = 1 } = {}) {
  const key = (text ? 'T ' : 'J ') + url + (headers ? ' ' + JSON.stringify(headers) : '');
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    await pacer.acquire(provider, { priority, maxWait, cost });
    budget.record(provider);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); }, timeoutMs);
    try {
      let res;
      try { res = await fetch(url, { headers, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }); }
      catch (e) {
        if (timedOut) throw apiError('timeout', 'Request timed out', { provider });
        throw apiError('network', 'Network error' + (e && e.message ? ': ' + e.message : ''), { provider });
      }
      if (res.status === 429) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        pacer.penalize(provider, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60000);
        throw apiError('rateLimited', 'rate-limited', { provider });
      }
      if (res.status === 401) throw apiError('authError', 'API key rejected', { provider, status: 401 });
      if (res.status === 402 || res.status === 403) throw apiError('premium', 'Not available on this plan (HTTP ' + res.status + ')', { provider, status: res.status });
      if (!res.ok) throw apiError('error', 'HTTP ' + res.status, { provider, status: res.status });
      try { return text ? await res.text() : await res.json(); }
      catch (e) { if (timedOut) throw apiError('timeout', 'Request timed out', { provider }); throw apiError('error', 'Unreadable response', { provider }); }
    } finally { clearTimeout(t); }
  })();
  inflight.set(key, p);
  // Cleared on settle either way; a failure must not be replayed to the next caller.
  p.then(() => inflight.delete(key), () => inflight.delete(key));
  return p;
}

// Provider registry. Each provider is { id, label, needsKey, classes, quote,
// profile?, search, marketStatus, validate?, candles?, candleIntervals?,
// fundamentals?, news?, events?, calendar? } — every optional method is checked
// with typeof before the facade calls it.
const REGISTRY = new Map();
export function register(p) { REGISTRY.set(p.id, p); }
export function get(id) { return REGISTRY.get(id); }
export function all() { return [...REGISTRY.values()]; }
