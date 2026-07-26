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
    source, ts: q.ts || Date.now(),
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

// Small helper: fetch JSON with a timeout, throwing a typed error on HTTP 429 so
// the scheduler can back off. `provider` is the budget attribution — every
// adapter passes its own id.
export async function getJSON(url, { timeoutMs = 9000, headers, provider } = {}) {
  budget.record(provider);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, cache: 'no-store', signal: ctrl.signal });
    if (res.status === 429) { const e = new Error('rate-limited'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// Provider registry. Each provider is { id, label, needsKey, quote, series, profile, search, marketStatus }.
const REGISTRY = new Map();
export function register(p) { REGISTRY.set(p.id, p); }
export function get(id) { return REGISTRY.get(id); }
export function all() { return [...REGISTRY.values()]; }
