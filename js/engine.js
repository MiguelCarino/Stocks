/* engine.js — non-UI logic: the refresh scheduler, alert evaluation, and pure
   portfolio math.

   Everything the engine needs to know about the outside world (which market
   session a symbol is in, whether this window leads the peer mesh, whether any
   peer window is on screen) arrives as callbacks the caller injects. The engine
   therefore imports nothing browser-coupled — store.js plus pure modules (the
   alert-type registry, the formatters, the session calendar). peers.js stays a
   browser-coupled singleton, and this file stays testable by handing it
   plain functions instead of a browser. */

import { store } from './store.js';
import { ALERT_TYPES, paramsFor, liveSeries, isCrossOp, describeRule, formatMetric } from './alerttypes.js';
import { fmtMove, priceKind } from './format.js';
import { marketForSymbol } from './session.js';

const i18nT = (s) => (typeof window !== 'undefined' && window.CarinoI18n ? window.CarinoI18n.t(s) : s);

/* ---- Scheduler ------------------------------------------------------------
   A session-aware polling loop.

   Cadence is governed rather than paused. Sleeping until the next calendar
   boundary would be strictly better arithmetic and strictly worse engineering:
   the holiday table is only authoritative to a horizon, so a wrong entry would
   have the app sleep straight through a live trading day. The closed-market
   floor turns that failure mode from blindness into five minutes of latency,
   and a session that admits it is approximate never earns the floor at all.

   Visibility is a property of the mesh, not of this document. The old
   `document.hidden` test froze every popout the moment the main window was
   backgrounded — which is precisely when a detached panel is the only thing the
   user is looking at. */

const OFF_HOURS_FLOOR_S = 60;
const SHUT_FLOOR_S = 300;
const GATE_RECHECK_S = 5;   // cheap: re-tests leadership/visibility, never the network

// Exported so the UI can explain the cadence it is showing without re-deriving it.
export function pollSeconds(session, interval) {
  const base = Math.max(5, Number(interval) || 15);
  if (!session || session.isOpen) return base;
  if (session.isTradeable) return Math.max(OFF_HOURS_FLOOR_S, base);
  return Math.max(session.approx ? OFF_HOURS_FLOOR_S : SHUT_FLOOR_S, base);
}

export function createScheduler(tickFn, opts = {}) {
  const fn = (f, fallback) => (typeof f === 'function' ? f : fallback);
  const getSession = fn(opts.getSession, () => null);
  const isLeader = fn(opts.isLeader, () => true);
  // No peer census means this window is the only one whose visibility exists.
  const anyVisible = fn(opts.anyVisible, () => typeof document === 'undefined' || !document.hidden);

  let timer = null, paused = false, backoff = 0, running = false, gate = true, nextAt = 0, stopped = false;

  // A callback that throws must not silence polling forever, so both gates
  // fail open — a redundant fetch is cheaper than a watchlist that stops moving.
  function gateOpen() {
    try { return !!isLeader() && !!anyVisible(); } catch (e) { return true; }
  }
  function session() {
    try { const s = getSession(); return s && typeof s === 'object' ? s : null; }
    catch (e) { return null; }
  }

  async function run() {
    gate = gateOpen();
    if (paused || !gate || running) return schedule();
    running = true;
    try { await tickFn(); backoff = 0; }
    catch (e) { if (e && e.rateLimited) backoff = Math.min(backoff ? backoff * 2 : 30, 300); }
    finally { running = false; schedule(); }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    // Paused is explicit and setPaused(false) resumes immediately, so there is
    // nothing worth waking up for. A closed gate is not explicit — leadership
    // changes silently when another window dies — so it is re-tested often.
    // stop() must also outlast a tick that was in flight when it was called.
    if (paused || stopped) { nextAt = 0; return; }
    const secs = gate ? pollSeconds(session(), store.settings.interval) + backoff : GATE_RECHECK_S;
    nextAt = Date.now() + secs * 1000;
    timer = setTimeout(run, secs * 1000);
  }

  // One listener per scheduler, bound by start() and removed by stop(). It used
  // to be added at construction and never removed, so every createScheduler call
  // leaked a listener that kept calling run() on a scheduler nobody held.
  const onVisible = () => { if (!document.hidden && !paused) run(); };
  let bound = false;
  function bind(on) {
    if (typeof document === 'undefined' || on === bound) return;
    if (on) document.addEventListener('visibilitychange', onVisible);
    else document.removeEventListener('visibilitychange', onVisible);
    bound = on;
  }

  return {
    start() { stopped = false; bind(true); run(); },
    stop() { stopped = true; bind(false); clearTimeout(timer); timer = null; nextAt = 0; },
    now() { if (!stopped) run(); },

    // Externally-driven catch-up, for when this window's own timer cannot be
    // trusted. A backgrounded leader is clamped to roughly one wake-up a minute,
    // so `nextAt` slides past unnoticed while a popout on another monitor shows
    // an ageing frame. A visible peer calls this on its own un-clamped cadence;
    // the scheduled time is still the authority, so an early nudge is a no-op
    // and no amount of nudging can poll faster than the governor allows.
    wake() { if (!stopped && !paused && !running && nextAt && Date.now() >= nextAt) run(); },
    setPaused(p) { paused = !!p; if (!paused && !stopped) run(); else schedule(); },
    isPaused() { return paused; },
    isGated() { return !gate; },
    nextRun() { return nextAt || null; },
  };
}

/* ---- Alerts ---------------------------------------------------------------
   Edge-triggered: a rule fires once when the condition becomes true, then must
   reset (condition false) before it can fire again, with a cooldown guard.
   WHAT a rule measures lives in alerttypes.js; this loop owns only WHEN it fires.

   Two session-aware guards sit on top of that edge.

   The gate is checked BEFORE the latch and skips the rule entirely — it never
   reads or writes `_latched`. Consuming the latch while out of scope would make
   the session flip itself look like a fresh edge, so gating would manufacture
   exactly the spurious fire it exists to prevent.

   Confirmation exists because extended-hours books are thin: one 100-share
   print three percent off fair value satisfies a rule, mean-reverts on the next
   poll (clearing and re-arming the latch), and does it again all night on trades
   nobody could have taken. Requiring the condition to survive consecutive polls
   costs one poll of latency during regular hours — where it is not applied at
   all — and removes the entire class of overnight phantom alerts. The streak
   lives in memory only: it is a property of this session of this window, not of
   the rule, and persisting it would export and re-import as stale state. A new
   leader after a hand-off therefore starts its streaks from zero, which costs
   at most one extra poll.

   A metric that cannot be measured (no quote, no bars yet, no avg volume) skips
   the rule outright and touches nothing — not the latch, not the streak, not
   the cross state. "Unknown" is not "false", and treating it as false would
   re-arm a latch on a data hiccup and fire again on the next good poll.

   Cross ops (crossAbove/crossBelow) need to have SEEN the other side: `_xready`
   is set once the condition is observed false and spent when the rule fires, so
   a rule created while price is already above its level waits for a real cross
   instead of firing on the first poll. It is the plain level op plus that one
   flag, which keeps confirmation and the latch working unchanged. `_prev` keeps
   the last measured value for the UI. Both are runtime (underscore) fields:
   persisted in stk_rules so a reload does not forget which side the price was
   on, stripped from every export.

   Comparisons are inclusive (>=, <=): 'below 100' fires at exactly 100. A
   threshold is a level the user wants to hear about reaching, not passing. */

const CONFIRM_TICKS = 2;
const COOLDOWN_MS = 60000;
const streaks = new Map();

// Session names attached to a fired alert. A notification that arrives at 02:00
// has to say the market was shut, or the number in it reads as tradeable.
const NOTE = {
  pre: 'pre-market', post: 'after hours',
  closed: 'market closed', weekend: 'market closed', holiday: 'market closed',
};

export function evaluateAlerts(quotes, onFire, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const sessionFor = typeof ctx.sessionFor === 'function' ? ctx.sessionFor : null;
  const need = clampTicks(ctx.confirmTicks);
  const today = dayKey(now);
  const qs = quotes && typeof quotes === 'object' ? quotes : {};
  let dirty = false;
  const touch = () => { dirty = true; };

  for (const rule of store.rules) {
    if (!rule || !rule.armed) continue;

    // Expiry is checked whether or not the market is in scope: a rule that ran
    // out on Saturday must not come back to life on Monday's first poll.
    if (typeof rule.expires === 'string' && rule.expires && today > rule.expires) {
      rule.armed = false; rule.disarmedBy = 'expired'; dirty = true;
      streaks.delete(ruleKey(rule));
      continue;
    }

    const def = ALERT_TYPES[rule.type];
    if (!def) continue;   // a type from a newer build: kept, never guessed at
    const portfolio = def.needs === 'portfolio';
    const q = portfolio ? null : qs[rule.symbol];
    if (!portfolio && !q) continue;

    // Portfolio rules have no single market; their session is unknown, which by
    // the rule below means ungated and unconfirmed.
    const sess = !portfolio && sessionFor ? safeSession(sessionFor, rule.symbol) : null;
    const scope = Array.isArray(rule.sessions) ? rule.sessions : [];
    // An unknown session cannot disqualify anything: a monitoring tool that goes
    // silent because it lost the calendar is worse than one that over-reports.
    if (scope.length && sess && !scope.includes(sess.state)) continue;

    const key = ruleKey(rule);
    const bars = def.needs === 'bars' ? syncValue(ctx.barsFor, rule.symbol) : null;
    const fundamentals = def.fundamentals ? syncValue(ctx.fundamentalsFor, rule.symbol) : null;
    const mctx = {
      rule, quote: q, now, touch,
      params: paramsFor(rule),
      series: Array.isArray(bars) ? liveSeries(bars, q, now) : null,
      fundamentals: fundamentals && typeof fundamentals === 'object' ? fundamentals : null,
      portfolio: ctx.portfolio && typeof ctx.portfolio === 'object' ? ctx.portfolio : null,
    };
    let metric = null;
    try { metric = def.metric(mctx); } catch (e) { metric = null; }
    if (typeof metric !== 'number' || !Number.isFinite(metric)) continue;

    rule._prev = metric;
    const value = def.fixedValue != null ? def.fixedValue : Number(rule.value);
    if (!Number.isFinite(value)) continue;
    const up = rule.op === 'above' || rule.op === 'crossAbove';
    const cond = up ? metric >= value : metric <= value;
    const cross = isCrossOp(rule.op);
    if (cross && !cond && !rule._xready) { rule._xready = true; dirty = true; }
    const hit = cond && (!cross || !!rule._xready);

    if (!hit) {
      streaks.delete(key);
      if (rule._latched) { rule._latched = false; dirty = true; } // re-arm once the condition clears
      continue;
    }
    if (rule._latched) continue;
    if (rule.cooldownUntil && now <= rule.cooldownUntil) continue;

    if (sess && (sess.state === 'pre' || sess.state === 'post')) {
      const prev = streaks.get(key);
      // A streak belongs to the session it was built in; pre-market progress
      // must not be spent by the first thin print after the close.
      const n = (prev && prev.state === sess.state ? prev.n : 0) + 1;
      if (n < clampTicks(rule.confirm, need)) { streaks.set(key, { state: sess.state, n }); continue; }
    }
    streaks.delete(key);

    rule._latched = true;
    rule.cooldownUntil = now + COOLDOWN_MS;
    if (cross) rule._xready = false;
    if (rule.repeat === 'once') { rule.armed = false; rule.disarmedBy = 'fired'; }
    dirty = false;
    store.saveRules();

    const note = sess && NOTE[sess.state] ? ' · ' + i18nT(NOTE[sess.state]) : '';
    const text = `${describeRule(rule)} — ${i18nT('now')} ${fmtMetric(rule, metric, q)}${note}`;
    const entry = {
      ts: now, symbol: rule.symbol, text, session: sess ? sess.state : null,
      ruleId: rule.id || null, type: rule.type,
    };
    store.logAlert(entry);
    try {
      onFire(rule, text, q, {
        ts: now, entry, metric,
        session: entry.session,
        label: sess ? sess.label : null,
        approx: !!(sess && sess.approx),
      });
    } catch (e) { /* one bad handler must not strand the remaining rules */ }
  }

  // Runtime state that changed without a fire (a new trailing peak, a cross that
  // became ready, an expiry) is written once per pass, not once per rule. `_prev`
  // alone never triggers a write: it changes on every poll and is display-only.
  if (dirty) store.saveRules();
  pruneStreaks();
}

function safeSession(fn, symbol) {
  try { const s = fn(symbol); return s && typeof s === 'object' ? s : null; }
  catch (e) { return null; }
}

// The evaluation pass is synchronous by design (it runs inside the tick, after
// the fetch). A callback that answers with a Promise has not answered yet.
function syncValue(fn, symbol) {
  if (typeof fn !== 'function') return null;
  try {
    const v = fn(symbol);
    return v && typeof v.then === 'function' ? null : (v == null ? null : v);
  } catch (e) { return null; }
}

// Rules written before ids existed would otherwise all share the key `undefined`.
function ruleKey(rule) {
  return rule.id || `${rule.symbol}|${rule.type}|${rule.op}|${rule.value}`;
}

function clampTicks(v, fallback = CONFIRM_TICKS) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : fallback;
}

function pruneStreaks() {
  if (!streaks.size) return;
  const live = new Set(store.rules.map(ruleKey));
  for (const key of [...streaks.keys()]) if (!live.has(key)) streaks.delete(key);
}

// Local calendar day, matching how an expiry date is typed into a date input.
function dayKey(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// Precision follows magnitude (format.js) for prices; everything else uses the
// type's own formatter. A sub-dollar coin no longer reports 'now 0.00'.
function priceKindOf(sym, q) {
  try { return sym && sym[0] !== '@' ? priceKind(marketForSymbol(sym, q)) : undefined; } catch { return undefined; }
}

function fmtMetric(rule, v, q) {
  const def = ALERT_TYPES[rule.type];
  if (def && def.fmt === 'price' && def.unit === 'price') return fmtMove(v, v, { kind: priceKindOf(rule.symbol, q) }) + (q && q.currency && q.currency !== 'USD' ? ' ' + q.currency : '');
  return formatMetric(rule, v);
}

/* ---- Portfolio math (pure) ------------------------------------------------ */
export function costPerShare(h) {
  const shares = Number(h.shares) || 0;
  if (h.costMode === 'total') return shares ? (Number(h.cost) || 0) / shares : 0;
  return Number(h.cost) || 0;
}

export function valueHolding(h, quote) {
  const shares = Number(h.shares) || 0;
  const price = quote?.price ?? null;
  const avg = costPerShare(h);
  const marketValue = price != null ? price * shares : null;
  const costBasis = avg * shares;
  const totalPL = marketValue != null ? marketValue - costBasis : null;
  const totalPLPct = costBasis ? (totalPL / costBasis) * 100 : null;
  const dayPL = (quote && quote.change != null) ? quote.change * shares : null;
  return { shares, price, avg, marketValue, costBasis, totalPL, totalPLPct, dayPL };
}

export function portfolioTotals(holdings, quotes) {
  // `cost` accumulates only priced holdings so Total P/L (= value − cost) stays
  // internally consistent; `fullCost` is the cost basis across every holding for
  // the Cost-basis tile.
  let value = 0, cost = 0, fullCost = 0, dayPL = 0, haveValue = false;
  const rows = holdings.map((h) => {
    const v = valueHolding(h, quotes[h.symbol]);
    fullCost += v.costBasis;
    if (v.marketValue != null) { value += v.marketValue; cost += v.costBasis; haveValue = true; }
    if (v.dayPL != null) dayPL += v.dayPL;
    return { holding: h, ...v };
  });
  for (const r of rows) r.weight = haveValue && value ? (r.marketValue || 0) / value * 100 : null;
  const totalPL = haveValue ? value - cost : null;
  return { rows, value: haveValue ? value : null, cost: fullCost, dayPL: haveValue ? dayPL : null, totalPL,
           totalPLPct: cost && totalPL != null ? (totalPL / cost) * 100 : null };
}
