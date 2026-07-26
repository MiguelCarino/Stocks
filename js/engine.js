/* engine.js — non-UI logic: the refresh scheduler, alert evaluation, and pure
   portfolio math.

   Everything the engine needs to know about the outside world (which market
   session a symbol is in, whether this window leads the peer mesh, whether any
   peer window is on screen) arrives as callbacks the caller injects. The engine
   therefore still imports nothing but store.js: session.js stays pure, peers.js
   stays a browser-coupled singleton, and this file stays testable by handing it
   plain functions instead of a browser. */

import { store } from './store.js';

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
  const anyVisible = fn(opts.anyVisible, () => !document.hidden);

  let timer = null, paused = false, backoff = 0, running = false, gate = true, nextAt = 0;

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
    if (paused) { nextAt = 0; return; }
    const secs = gate ? pollSeconds(session(), store.settings.interval) + backoff : GATE_RECHECK_S;
    nextAt = Date.now() + secs * 1000;
    timer = setTimeout(run, secs * 1000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) run(); });

  return {
    start() { run(); },
    stop() { clearTimeout(timer); timer = null; nextAt = 0; },
    now() { run(); },

    // Externally-driven catch-up, for when this window's own timer cannot be
    // trusted. A backgrounded leader is clamped to roughly one wake-up a minute,
    // so `nextAt` slides past unnoticed while a popout on another monitor shows
    // an ageing frame. A visible peer calls this on its own un-clamped cadence;
    // the scheduled time is still the authority, so an early nudge is a no-op
    // and no amount of nudging can poll faster than the governor allows.
    wake() { if (!paused && !running && nextAt && Date.now() >= nextAt) run(); },
    setPaused(p) { paused = !!p; if (!paused) run(); else schedule(); },
    isPaused() { return paused; },
    isGated() { return !gate; },
    nextRun() { return nextAt || null; },
  };
}

/* ---- Alerts ---------------------------------------------------------------
   Edge-triggered: a rule fires once when the condition becomes true, then must
   reset (condition false) before it can fire again, with a cooldown guard.

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
   the rule, and persisting it would export and re-import as stale state. */

const CONFIRM_TICKS = 2;
const COOLDOWN_MS = 60000;
const streaks = new Map();

// Session names attached to a fired alert. A notification that arrives at 02:00
// has to say the market was shut, or the number in it reads as tradeable.
const NOTE = {
  pre: ' · pre-market', post: ' · after hours',
  closed: ' · market closed', weekend: ' · market closed', holiday: ' · market closed',
};

export function evaluateAlerts(quotes, onFire, ctx = {}) {
  const now = Date.now();
  const sessionFor = typeof ctx.sessionFor === 'function' ? ctx.sessionFor : null;
  const need = clampTicks(ctx.confirmTicks);

  for (const rule of store.rules) {
    if (!rule.armed) continue;
    const q = quotes[rule.symbol];
    if (!q || q.price == null) continue;

    const sess = sessionFor ? safeSession(sessionFor, rule.symbol) : null;
    const scope = Array.isArray(rule.sessions) ? rule.sessions : [];
    // An unknown session cannot disqualify anything: a monitoring tool that goes
    // silent because it lost the calendar is worse than one that over-reports.
    if (scope.length && sess && !scope.includes(sess.state)) continue;

    const key = ruleKey(rule);
    const metric = rule.type === 'pct' ? (q.changePct ?? 0) : q.price;
    const hit = rule.op === 'above' ? metric >= rule.value : metric <= rule.value;

    if (!hit) {
      streaks.delete(key);
      if (rule._latched) rule._latched = false; // re-arm once the condition clears
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
    store.saveRules();

    const unit = rule.type === 'pct' ? '%' : '';
    const text = `${rule.symbol} ${rule.type === 'pct' ? 'change' : 'price'} ${rule.op} ${rule.value}${unit}`
      + ` — now ${fmtMetric(metric, rule.type)}${sess && NOTE[sess.state] ? NOTE[sess.state] : ''}`;
    const entry = { ts: now, symbol: rule.symbol, text, session: sess ? sess.state : null };
    store.logAlert(entry);
    try {
      onFire(rule, text, q, {
        ts: now, entry,
        session: entry.session,
        label: sess ? sess.label : null,
        approx: !!(sess && sess.approx),
      });
    } catch (e) { /* one bad handler must not strand the remaining rules */ }
  }

  pruneStreaks();
}

function safeSession(fn, symbol) {
  try { const s = fn(symbol); return s && typeof s === 'object' ? s : null; }
  catch (e) { return null; }
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

function fmtMetric(v, type) { return type === 'pct' ? v.toFixed(2) + '%' : v.toFixed(2); }

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
