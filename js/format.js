/* format.js — every number the UI prints, formatted in one place.

   These functions existed three times over (app.js, popout.js, and now the
   widgets), and the copies had already drifted apart once: two decimals is right
   for equities and wrong for everything else, so 'EURUSD $1.08' and a DOGE move
   of '0.00' both shipped before the precision rule was fixed in one copy at a
   time. A widget system multiplies the number of callers, which makes a shared
   module the only version of this that stays correct.

   The central decision is that precision follows the MAGNITUDE of the number,
   not the asset class. An FX pair moves in the fourth decimal and a sub-dollar
   coin has nothing left at the second, but neither fact is knowable from a
   ticker string we may have classified wrong — whereas 1.0848 is visibly a
   number that needs four places. Asset class is consulted for exactly one thing,
   the currency prefix, and even that arrives as an argument: the old fmtPrice
   reached into app state to decide whether a symbol was FX, which is why it
   could not be lifted out of app.js at all. Callers pass { fx } instead.

   Pure. No imports, no DOM, no ambient state. Intl is still a browser API, so
   every call into it is guarded — a locale-data-less build should print an
   unformatted number, never take down a render. */

// Absent, not zero. Every formatter answers with this rather than inventing a
// value, and callers are expected to let it through.
const DASH = '—';

// A real minus sign, not a hyphen: the digits are tabular-nums and a hyphen is
// visibly too short beside them. Matches the '+'/'−' pairs already in the UI.
const MINUS = '−';

export function priceDecimals(v) {
  const a = Math.abs(Number(v) || 0);
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
  return prefix + group(n, priceDecimals(n)) + suffix;
}

// Absolute move, rendered at the precision of the price it moved. Falling back
// to the move's own magnitude keeps a change without a price readable instead of
// rounding it to nothing.
export function fmtMove(v, price) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return group(n, priceDecimals(price != null ? price : n));
}

export function fmtPct(v) {
  if (v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return (n >= 0 ? '+' : MINUS) + Math.abs(n).toFixed(2) + '%';
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
