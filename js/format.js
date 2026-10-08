/* format.js — every number the UI prints, formatted in one place.

   These functions existed three times over (app.js, popout.js, and now the
   widgets), and the copies had already drifted apart once: two decimals is right
   for equities and wrong for everything else, so 'EURUSD $1.08' and a DOGE move
   of '0.00' both shipped before the precision rule was fixed in one copy at a
   time. A widget system multiplies the number of callers, which makes a shared
   module the only version of this that stays correct.

   Precision follows the MAGNITUDE of the number by default. An FX pair moves in
   the fourth decimal and a sub-dollar coin has nothing left at the second, and
   1.0848 is visibly a number that needs four places. Magnitude alone gets one
   case wrong, though: a $96.44 stock printed as $96.4400, because between 1 and
   100 a share price and a currency rate look the same. So callers that know the
   asset class say so — { kind: 'equity' | 'fx' | 'crypto' }, usually built with
   priceKind(market) — and a known equity drops to cents above $1. With no kind
   the magnitude rule stands, which is the safe side: an unclassified pair keeps
   its pips and the worst case is two extra zeros. Like { fx }, the class arrives
   as an argument; this module never reaches into app state to guess it.

   Pure. No imports, no DOM, no ambient state. Intl is still a browser API, so
   every call into it is guarded — a locale-data-less build should print an
   unformatted number, never take down a render. */

// Absent, not zero. Every formatter answers with this rather than inventing a
// value, and callers are expected to let it through.
const DASH = '—';

// A real minus sign, not a hyphen: the digits are tabular-nums and a hyphen is
// visibly too short beside them. Matches the '+'/'−' pairs already in the UI.
const MINUS = '−';

// Market id (session.js: 'US_EQUITY' | 'FX' | 'CRYPTO') to a price kind.
export function priceKind(market) {
  if (!market) return undefined;
  return market === 'FX' ? 'fx' : market === 'CRYPTO' ? 'crypto' : 'equity';
}

function kindOf(opts) {
  if (!opts) return undefined;
  return opts.kind || (opts.fx ? 'fx' : undefined);
}

export function priceDecimals(v, kind) {
  const a = Math.abs(Number(v) || 0);
  // Stocks quote in cents; only penny stocks need more.
  if (kind === 'equity') return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 8;
}

/* opts.fx marks a ratio rather than an amount of money. 'EURUSD $1.0848' reads
   as a dollar price for one euro, which is not what the number means, so a pair
   drops the prefix and names its counter currency as a suffix instead. */
export function fmtPrice(v, currency, opts) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const fx = !!(opts && opts.fx);
  const prefix = fx ? '' : (!currency || currency === 'USD' ? '$' : currency + ' ');
  const suffix = fx && currency ? ' ' + currency : '';
  return prefix + group(n, priceDecimals(n, kindOf(opts))) + suffix;
}

// Absolute move, rendered at the precision of the price it moved. Falling back
// to the move's own magnitude keeps a change without a price readable instead of
// rounding it to nothing.
export function fmtMove(v, price, opts) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return group(n, priceDecimals(price != null ? price : n, kindOf(opts)));
}

export function fmtPct(v) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return (n >= 0 ? '+' : MINUS) + Math.abs(n).toFixed(2) + '%';
}

/* A bare price figure (no currency) — ledger rows, average cost, lot tooltips,
   calculator results. With a kind it follows priceDecimals. Without one it keeps
   the magnitude rule's places but drops trailing zeros past the cents, so a
   typed 96.44 reads 96.44 while 1.0848 keeps its pips. */
export function fmtPriceNum(v, kind) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const d = priceDecimals(n, kind);
  if (kind || d <= 2) return group(n, d);
  let s = group(n, d);
  while (/\.\d{3,}$/.test(s) && s.endsWith('0')) s = s.slice(0, -1);
  return s;
}

export function fmtNum(v, dp) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const d = Number.isFinite(Number(dp)) ? Math.max(0, Math.min(20, Math.floor(Number(dp)))) : 2;
  return group(n, d);
}

export function fmtInt(v) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  try { return n.toLocaleString('en-US'); } catch (e) { return String(Math.round(n)); }
}

/* Share counts are read for order of magnitude, not audited: '14.4M' answers the
   question a volume column is asked. Below a million the separated integer is
   both shorter and exact, so there is no reason to abbreviate it. */
export function fmtVolume(v) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return fmtInt(n);
}

export function fmtCap(v) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + fmtInt(n);
}

// 24-hour, because a trading day is discussed in 24-hour time and 'as of 4:00'
// is ambiguous in exactly the hour where it matters most.
export function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return DASH;
  try { return new Date(n).toLocaleTimeString('en-US', { hour12: false }); }
  catch (e) { return DASH; }
}

/* Duplicates session.js formatCountdown deliberately: this module imports
   nothing, so a formatter cannot be the reason a chart pulls in the exchange
   calendar. Multi-day gaps drop the minutes — '62h' carries the point, '62h 14m'
   only adds noise. */
export function fmtAge(ms) {
  const secs = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return h + 'h';
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

function group(n, d) {
  try { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  catch (e) { return n.toFixed(d); }
}
