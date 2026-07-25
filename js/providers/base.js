/* providers/base.js — the adapter contract every data source implements, plus
   the normalized shapes the rest of the app is allowed to see. Adding a provider
   (or WebSocket streaming, or a self-hosted proxy) is a new module behind this
   boundary — never a change to the UI. */

// Normalized quote — the ONLY quote shape the UI consumes:
//   { symbol, price, prevClose, change, changePct, high, low, open, volume, currency, source, ts }
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
    currency: q.currency || 'USD',
    source, ts: q.ts || Date.now(),
  };
}

export function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Small helper: fetch JSON with a timeout, throwing a typed error on HTTP 429 so
// the scheduler can back off.
export async function getJSON(url, { timeoutMs = 9000, headers } = {}) {
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
