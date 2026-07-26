/* session.js — the single source of truth for "is this symbol tradeable right
   now, when does that change, and how much should you trust the answer".

   The central design decision is how exchange-local time is obtained: the
   instant is FORMATTED in the exchange timezone with Intl.DateTimeFormat and the
   resulting integers are compared, rather than adding a UTC offset to a
   timestamp. Offsets are not a constant — they move twice a year, and on the
   transition days the offset before a session boundary differs from the offset
   after it, so offset arithmetic is guaranteed to misclassify at least one
   session edge per year. Formatting is correct by construction; the price is an
   Intl call per lookup, paid down with a formatter cache because a countdown in
   the UI calls this once a second.

   Everything here is pure: no network, no localStorage, no ambient Date.now().
   The caller supplies the instant, which also makes the whole module trivially
   testable (see the expectation block at the bottom of the file). */

import { classify } from './providers/assetclass.js';

/* Last calendar year the holiday table was checked against the exchange's own
   published calendar. Past this, the table is still produced by the same rules
   the exchange uses, but nobody has confirmed it — sessionAt() reports
   approx:true so the UI can hedge instead of lying. */
export const HOLIDAY_HORIZON = 2028;

/* Rule-derived holidays are equally unverified going backwards, and the
   historical record additionally contains closures no rule can reproduce
   (hurricanes, mourning days). Dates before this are flagged approx too. */
const HOLIDAY_FLOOR = 2026;

export const MARKETS = {
  US_EQUITY: {
    id: 'US_EQUITY', label: 'US equities', tz: 'America/New_York',
    days: 'Mon-Fri', holidays: true,
    hours: { pre: '04:00', open: '09:30', close: '16:00', post: '20:00' },
  },
  CRYPTO: {
    id: 'CRYPTO', label: 'Crypto', tz: 'UTC',
    days: 'Every day', holidays: false,
    hours: { open: '00:00', close: '24:00' },
  },
  FX: {
    id: 'FX', label: 'FX', tz: 'America/New_York',
    days: 'Sun 17:00 - Fri 17:00', holidays: false,
    hours: { open: '17:00', close: '17:00' },
  },
};

/* ---- Zoned time primitives -------------------------------------------------
   hourCycle:'h23' and deliberately NOT hour12:false. The spec allows an engine
   to resolve hour12:false to the h24 cycle, which renders midnight as '24:00';
   that parses to 1440 minutes, sorts after every boundary of the day, and turns
   00:15 into "after hours". h23 is the only spelling that cannot do that. */

const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FORMATTERS = new Map();

/* The weekday is deliberately NOT requested. It is fully determined by the
   civil date this formatter already yields, and taking it from a localized
   token means an unexpected string (locale-data fallback, a trimmed ICU) would
   have to be mapped through an English table — a miss there reads as Sunday and
   shuts the market forever with no error anywhere. Deriving it arithmetically
   cannot fail that way, and asks the formatter for one field less. */
function formatter(tz) {
  if (FORMATTERS.has(tz)) return FORMATTERS.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { f = null; } // unknown zone, or an ICU-less build
  FORMATTERS.set(tz, f);
  return f;
}

// -> { y, m, d, dow, minutes } in the target zone. Falls back to UTC rather than
// throwing; a wrong-but-coherent clock beats a crashed panel.
function zonedParts(ms, tz) {
  const f = formatter(tz);
  if (!f) {
    const u = new Date(ms);
    return {
      y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(),
      dow: u.getUTCDay(), minutes: u.getUTCHours() * 60 + u.getUTCMinutes(),
    };
  }
  let y = 0, m = 0, d = 0, h = 0, mi = 0;
  for (const p of f.formatToParts(ms)) {
    if (p.type === 'year') y = +p.value;
    else if (p.type === 'month') m = +p.value;
    else if (p.type === 'day') d = +p.value;
    else if (p.type === 'hour') h = +p.value;
    else if (p.type === 'minute') mi = +p.value;
  }
  return { y, m, d, dow: weekdayOf(y, m, d), minutes: h * 60 + mi };
}

/* Inverse of zonedParts: the epoch ms at which the given wall-clock minute
   occurs in tz. Two correction passes — the first lands within one offset of the
   target, the second absorbs the case where that first jump crossed a DST
   transition. A wall time that does not exist (02:30 on the spring-forward day)
   settles just past the gap, which is the right answer for a boundary. */
function zonedTimeToMs(y, m, d, minutes, tz) {
  const wall = Date.UTC(y, m - 1, d) + minutes * 60000;
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const delta = wall - (Date.UTC(p.y, p.m - 1, p.d) + p.minutes * 60000);
    if (!delta) break;
    guess += delta;
  }
  return guess;
}

// Civil-date arithmetic only — no timezone involved, so UTC is just a calendar.
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}
function weekdayOf(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function nthWeekday(y, m, n, w) {
  const first = weekdayOf(y, m, 1);
  return 1 + ((w - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y, m, w) {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return days - ((weekdayOf(y, m, days) - w + 7) % 7);
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function ymdKey(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

// Anonymous Gregorian computus. Good Friday is Easter Sunday minus two days.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const dd = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * mth + 114) / 31), ((h + l - 7 * mth + 114) % 31) + 1];
}

/* ---- Holiday table ---------------------------------------------------------
   Generated per year from NYSE Rule 7.2 rather than transcribed, because a
   transcribed table silently stops being true the day it runs out. The rules,
   with the alignment cases that trip people up:

   - Saturday holiday -> preceding Friday; Sunday holiday -> following Monday.
   - Sole exception: Jan 1 on a Saturday is NOT pulled back to Dec 31, because
     Dec 31 is the last trading day of the year. 2028 and 2033 consequently have
     no New Year's holiday at all.
   - The 13:00 half-days before Independence Day and Christmas exist only when
     the holiday itself lands Tue-Fri. If Jul 4 is a Saturday the closure moves
     onto Jul 3 as a FULL holiday (2026); if it is a Sunday it moves to Jul 5 and
     Jul 3 falls on a Friday with no half-day (2027). Christmas Eve behaves
     identically against Dec 25. Getting this backwards is the classic bug and
     produces a UI that claims a market is open on a day it is shut.
   - The day after Thanksgiving is always a 13:00 close.

   Verified against the NYSE Group 2026/2027/2028 Holiday and Early Closings
   Calendar (ICE press release, 2025-12-23) — see HOLIDAY_HORIZON. */

const YEARS = new Map();

function buildYear(y) {
  const t = new Map();
  const closed = (m, d, name) => t.set(ymdKey(y, m, d), { name, earlyClose: false });
  const half = (m, d, name) => {
    const k = ymdKey(y, m, d);
    if (!t.has(k)) t.set(k, { name, earlyClose: true }); // a full closure always wins
  };
  const observed = (m, d) => {
    const w = weekdayOf(y, m, d);
    return w === 6 ? addDays(y, m, d, -1) : w === 0 ? addDays(y, m, d, 1) : { y, m, d };
  };

  if (weekdayOf(y, 1, 1) !== 6) {
    const o = observed(1, 1);
    closed(o.m, o.d, 'New Year’s Day' + (o.d !== 1 ? ' (observed)' : ''));
  }
  closed(1, nthWeekday(y, 1, 3, 1), 'Martin Luther King, Jr. Day');
  closed(2, nthWeekday(y, 2, 3, 1), 'Washington’s Birthday');

  const [em, ed] = easter(y);
  const gf = addDays(y, em, ed, -2);
  closed(gf.m, gf.d, 'Good Friday');

  closed(5, lastWeekday(y, 5, 1), 'Memorial Day');

  const jun = observed(6, 19);
  closed(jun.m, jun.d, 'Juneteenth' + (jun.d !== 19 ? ' (observed)' : ''));

  const jul = observed(7, 4);
  closed(jul.m, jul.d, 'Independence Day' + (jul.d !== 4 ? ' (observed)' : ''));

  closed(9, nthWeekday(y, 9, 1, 1), 'Labor Day');

  const tg = nthWeekday(y, 11, 4, 4);
  closed(11, tg, 'Thanksgiving Day');
  half(11, tg + 1, 'Day after Thanksgiving');

  const dec = observed(12, 25);
  closed(dec.m, dec.d, 'Christmas Day' + (dec.d !== 25 ? ' (observed)' : ''));

  const jul4 = weekdayOf(y, 7, 4);
  if (jul4 >= 2 && jul4 <= 5) half(7, 3, 'Independence Day eve');
  const dec25 = weekdayOf(y, 12, 25);
  if (dec25 >= 2 && dec25 <= 5) half(12, 24, 'Christmas Eve');

  return t;
}

function yearTable(y) {
  let t = YEARS.get(y);
  if (!t) { t = buildYear(y); YEARS.set(y, t); }
  return t;
}

/* Unscheduled closures no rule can predict. Kept apart from the generator so the
   derived table stays a pure function of the year and this stays an audit list. */
const ADHOC = new Map([
  ['2025-01-09', { name: 'National Day of Mourning', earlyClose: false }],
]);

export function holidayInfo(ymd) {
  if (typeof ymd !== 'string' || ymd.length < 10) return null;
  const y = +ymd.slice(0, 4);
  if (!Number.isFinite(y)) return null;
  const key = ymd.slice(0, 10);
  return ADHOC.get(key) || yearTable(y).get(key) || null;
}

/* ---- US equity session grid ----------------------------------------------- */

const PRE_OPEN = 4 * 60;          // 04:00
const RTH_OPEN = 9 * 60 + 30;     // 09:30
const RTH_CLOSE = 16 * 60;        // 16:00
const POST_CLOSE = 20 * 60;       // 20:00
const EARLY_RTH_CLOSE = 13 * 60;  // 13:00 on a half-day
const EARLY_POST_CLOSE = 17 * 60; // and after-hours is truncated to 17:00, not 20:00

// One exchange-local calendar day. Non-trading days carry no marks, which is
// what lets the boundary scans below walk straight over weekends and holidays.
function daySchedule(y, m, d, dow) {
  if (dow === 0 || dow === 6) return { trading: false, kind: 'weekend', hol: null };
  const hol = holidayInfo(ymdKey(y, m, d));
  if (hol && !hol.earlyClose) return { trading: false, kind: 'holiday', hol };
  const earlyClose = !!hol;
  const close = earlyClose ? EARLY_RTH_CLOSE : RTH_CLOSE;
  const end = earlyClose ? EARLY_POST_CLOSE : POST_CLOSE;
  return {
    trading: true, kind: 'trading', hol, earlyClose, close,
    marks: [[PRE_OPEN, 'pre'], [RTH_OPEN, 'open'], [close, 'post'], [end, 'closed']],
  };
}

// Twelve days is far beyond the longest possible closed stretch (a Friday
// holiday plus the weekend plus a Monday holiday is four), but the bound keeps a
// corrupt calendar from spinning forever.
const SCAN_DAYS = 12;

function nextTradingMark(p, tz) {
  let cur = { y: p.y, m: p.m, d: p.d, dow: p.dow };
  for (let i = 0; i < SCAN_DAYS; i++) {
    const s = daySchedule(cur.y, cur.m, cur.d, cur.dow);
    if (s.trading) {
      for (const [min, state] of s.marks) {
        if (i > 0 || min > p.minutes) {
          return { ms: zonedTimeToMs(cur.y, cur.m, cur.d, min, tz), state };
        }
      }
    }
    cur = addDays(cur.y, cur.m, cur.d, 1);
  }
  return null;
}

/* The trading marks only exist on trading days, so a scan over them walks
   straight past the local midnights on which one shut state becomes another:
   Friday evening 'closed' becomes 'weekend', and the evening before a holiday
   stays 'closed' all the way to the next pre-market. Callers that cache a
   session until nextChange — the popouts do exactly that — would then render
   'Closed · Frozen since Wed 16:00' through an entire market holiday. Only
   flips BETWEEN shut states are reported: a shut day rolling into a trading day
   changes nothing until 04:00, which the mark scan already covers. */
function nextShutFlip(p, state, tz) {
  if (state !== 'closed' && state !== 'weekend' && state !== 'holiday') return null;
  const nx = addDays(p.y, p.m, p.d, 1);
  const s = daySchedule(nx.y, nx.m, nx.d, nx.dow);
  if (s.trading || s.kind === state) return null;
  return { ms: zonedTimeToMs(nx.y, nx.m, nx.d, 0, tz), state: s.kind };
}

function earlier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b.ms < a.ms ? b : a;
}

// Wall-clock label of the most recent regular close at or before `p`, e.g.
// 'Fri 16:00'. Rendered straight from civil fields, so it costs no Intl call.
function lastCloseLabel(p) {
  let cur = { y: p.y, m: p.m, d: p.d, dow: p.dow };
  for (let i = 0; i < SCAN_DAYS; i++) {
    const s = daySchedule(cur.y, cur.m, cur.d, cur.dow);
    if (s.trading && (i > 0 || p.minutes >= s.close)) {
      return DOW_NAME[cur.dow] + ' ' + pad2(Math.floor(s.close / 60)) + ':' + pad2(s.close % 60);
    }
    cur = addDays(cur.y, cur.m, cur.d, -1);
  }
  return null;
}

const LABEL = {
  pre: 'Pre-market', open: 'Open', post: 'After hours',
  closed: 'Closed', weekend: 'Weekend', holiday: 'Holiday',
};

// Phrased by the state being entered, so the countdown reads as an event.
const ENTER = {
  pre: 'Pre-market in ', open: 'Opens in ',
  post: 'Closes in ', closed: 'After hours ends in ',
  weekend: 'Weekend in ', holiday: 'Holiday in ',
};

function equitySession(ms, tz) {
  const p = zonedParts(ms, tz);
  const s = daySchedule(p.y, p.m, p.d, p.dow);

  let state = s.kind === 'trading' ? 'closed' : s.kind;
  if (s.trading) for (const [min, st] of s.marks) if (p.minutes >= min) state = st;

  const isTradeable = state === 'pre' || state === 'open' || state === 'post';
  const nx = earlier(nextTradingMark(p, tz), nextShutFlip(p, state, tz));

  let detail = null;
  if (state === 'holiday') detail = s.hol.name;
  else if (s.trading && s.earlyClose) detail = 'Early close 13:00';
  else if (!isTradeable) {
    const last = lastCloseLabel(p);
    if (last) detail = 'Frozen since ' + last;
  }

  return {
    state,
    isOpen: state === 'open',
    isTradeable,
    earlyClose: !!(s.trading && s.earlyClose),
    approx: p.y > HOLIDAY_HORIZON || p.y < HOLIDAY_FLOOR,
    label: LABEL[state],
    detail,
    nextChange: nx ? nx.ms : null,
    nextLabel: nx ? ENTER[nx.state] + formatCountdown(nx.ms - ms) : null,
    tz,
  };
}

/* ---- Crypto ---------------------------------------------------------------
   Continuous. There is no boundary to count down to, so nextChange stays null
   rather than inventing a UTC midnight the market does not observe. */
function cryptoSession(tz) {
  return {
    state: 'open', isOpen: true, isTradeable: true, earlyClose: false, approx: false,
    label: 'Crypto 24/7', detail: null, nextChange: null, nextLabel: null, tz,
  };
}

/* ---- FX -------------------------------------------------------------------
   One continuous week: Sunday 17:00 ET through Friday 17:00 ET. The interbank
   market also pauses briefly at 17:00 ET each weekday for the daily rollover —
   that is a liquidity trough and a value-date change, not a session boundary, so
   it is deliberately not modelled as its own state. National holidays thin FX
   out but do not close it, so there is no holiday table here either. */
const FX_ROLL = 17 * 60;

function fxSession(ms, tz) {
  const p = zonedParts(ms, tz);
  const shut = p.dow === 6
    || (p.dow === 0 && p.minutes < FX_ROLL)
    || (p.dow === 5 && p.minutes >= FX_ROLL);

  // Days until the next Sunday 17:00 (when shut) or Friday 17:00 (when open).
  // ahead === 0 can only mean "later today": the two cases where today's 17:00 is
  // already behind us are exactly the two that flip `shut`, so they pick the
  // other target and land on a different day.
  const target = shut ? 0 : 5;
  const at = addDays(p.y, p.m, p.d, (target - p.dow + 7) % 7);
  const nextChange = zonedTimeToMs(at.y, at.m, at.d, FX_ROLL, tz);

  return {
    state: shut ? 'weekend' : 'open',
    isOpen: !shut, isTradeable: !shut, earlyClose: false, approx: false,
    label: shut ? 'Weekend' : 'Open',
    detail: shut ? 'Frozen since Fri 17:00' : null,
    nextChange,
    nextLabel: (shut ? 'Opens in ' : 'Closes in ') + formatCountdown(nextChange - ms),
    tz,
  };
}

/* ---- Public API ----------------------------------------------------------- */

export function marketForSymbol(symbol, quote) {
  try {
    // A rolling-24h baseline is the provider itself telling us the instrument
    // never closes, which beats any guess made from the ticker string.
    if (quote && quote.baseline === 'rolling_24h') return 'CRYPTO';
    const cls = classify(String(symbol || '').toUpperCase());
    return cls === 'crypto' ? 'CRYPTO' : cls === 'fx' ? 'FX' : 'US_EQUITY';
  } catch { return 'US_EQUITY'; }
}

export function sessionAt(dateOrMs, market = 'US_EQUITY') {
  const def = MARKETS[market] || MARKETS.US_EQUITY;
  // Only a Date or a number is an instant. Coercing anything else would let
  // null, '' and [] through as the Unix epoch, which classifies as 'post' —
  // a confident wrong answer where 'Session unavailable' is the honest one.
  const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : (typeof dateOrMs === 'number' ? dateOrMs : NaN);
  if (!Number.isFinite(ms)) return unavailable(def.tz);
  try {
    if (def.id === 'CRYPTO') return cryptoSession(def.tz);
    if (def.id === 'FX') return fxSession(ms, def.tz);
    return equitySession(ms, def.tz);
  } catch { return unavailable(def.tz); }
}

function unavailable(tz) {
  return {
    state: 'closed', isOpen: false, isTradeable: false, earlyClose: false, approx: true,
    label: 'Closed', detail: 'Session unavailable', nextChange: null, nextLabel: null, tz,
  };
}

// Multi-day gaps drop the minutes: '62h' carries the point that a Friday-evening
// user is waiting through a long weekend, '62h 14m' just adds noise.
export function formatCountdown(ms) {
  const secs = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return h + 'h';
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

/* ---- Expected results (hand-checked; all times America/New_York) ------------

   sessionAt(Date '2026-07-14T10:00-04:00')            // normal Tuesday
     state 'open'     isOpen true   isTradeable true   detail null
     nextLabel 'Closes in 6h'                          nextChange Tue 16:00

   sessionAt(Date '2026-07-14T05:00-04:00')
     state 'pre'      isOpen false  isTradeable true   detail null
     nextLabel 'Opens in 4h 30m'                       nextChange Tue 09:30

   sessionAt(Date '2026-07-14T17:00-04:00')
     state 'post'     isOpen false  isTradeable true   detail null
     nextLabel 'After hours ends in 3h'                nextChange Tue 20:00

   sessionAt(Date '2026-07-14T22:00-04:00')
     state 'closed'   isTradeable false  detail 'Frozen since Tue 16:00'
     nextLabel 'Pre-market in 6h'                      nextChange Wed 04:00

   sessionAt(Date '2026-07-17T21:00-04:00')            // Friday, after the tail
     state 'closed'   detail 'Frozen since Fri 16:00'
     nextLabel 'Weekend in 3h'                         nextChange Sat 18 Jul 00:00

   sessionAt(Date '2026-07-18T12:00-04:00')            // Saturday
     state 'weekend'  detail 'Frozen since Fri 16:00'
     nextLabel 'Pre-market in 40h'                     nextChange Mon 20 Jul 04:00
     (Sunday is weekend too, so no midnight flip intervenes)

   sessionAt(Date '2026-12-31T21:00-05:00')            // Thu before New Year's Day
     state 'closed'   nextLabel 'Holiday in 3h'        nextChange Fri 1 Jan 2027 00:00

   sessionAt(Date '2026-11-26T10:00-05:00')            // Thanksgiving
     state 'holiday'  isTradeable false  detail 'Thanksgiving Day'
     nextLabel 'Pre-market in 18h'                     nextChange Fri 27 Nov 04:00

   sessionAt(Date '2026-11-27T14:00-05:00')            // day after Thanksgiving
     state 'post'     earlyClose true    detail 'Early close 13:00'
     nextLabel 'After hours ends in 3h'                nextChange Fri 17:00
     (NOT 'open' — regular hours ended at 13:00 and the tail runs to 17:00)

   sessionAt(Date '2040-03-06T10:00-05:00')            // past HOLIDAY_HORIZON
     state 'open'     approx true        // caller must render the hedge

   sessionAt(anything, 'CRYPTO')  -> state 'open',  label 'Crypto 24/7'
   sessionAt(Date '2026-07-18T12:00-04:00', 'FX') -> state 'weekend',
     nextLabel 'Opens in 29h'                         nextChange Sun 19 Jul 17:00

   Holiday spot-checks against the NYSE 2026-2028 calendar:
     holidayInfo('2026-07-03') -> { Independence Day (observed), earlyClose false }
     holidayInfo('2026-12-24') -> { Christmas Eve,               earlyClose true  }
     holidayInfo('2027-06-18') -> { Juneteenth (observed),       earlyClose false }
     holidayInfo('2027-12-24') -> { Christmas Day (observed),    earlyClose false }
     holidayInfo('2028-01-01') -> null   (Saturday; Dec 31 stays open)
     holidayInfo('2028-07-03') -> { Independence Day eve,        earlyClose true  }
--------------------------------------------------------------------------- */
