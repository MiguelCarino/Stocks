/* engine.js — non-UI logic: the refresh scheduler, alert evaluation, and pure
   portfolio math (kept dependency-free and unit-testable). */

import { store } from './store.js';

/* ---- Scheduler ------------------------------------------------------------
   A visibility-aware polling loop. Pauses when the tab is hidden (Page
   Visibility API) to save the free-tier budget, and backs off on rate limits. */
export function createScheduler(tickFn) {
  let timer = null, paused = false, backoff = 0, running = false;

  async function run() {
    if (paused || document.hidden || running) return schedule();
    running = true;
    try { await tickFn(); backoff = 0; }
    catch (e) { if (e && e.rateLimited) backoff = Math.min(backoff ? backoff * 2 : 30, 300); }
    finally { running = false; schedule(); }
  }
  function schedule() {
    clearTimeout(timer);
    const base = Math.max(5, store.settings.interval || 15);
    timer = setTimeout(run, (base + backoff) * 1000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) run(); });

  return {
    start() { run(); },
    stop() { clearTimeout(timer); },
    now() { run(); },
    setPaused(p) { paused = p; if (!p) run(); },
    isPaused() { return paused; },
  };
}

/* ---- Alerts ---------------------------------------------------------------
   Edge-triggered: a rule fires once when the condition becomes true, then must
   reset (condition false) before it can fire again, with a cooldown guard. */
export function evaluateAlerts(quotes, onFire) {
  const now = Date.now();
  for (const rule of store.rules) {
    if (!rule.armed) continue;
    const q = quotes[rule.symbol];
    if (!q || q.price == null) continue;

    const metric = rule.type === 'pct' ? (q.changePct ?? 0) : q.price;
    const hit = rule.op === 'above' ? metric >= rule.value : metric <= rule.value;

    if (hit && !rule._latched && (!rule.cooldownUntil || now > rule.cooldownUntil)) {
      rule._latched = true;
      rule.cooldownUntil = now + 60000;
      store.saveRules();
      const unit = rule.type === 'pct' ? '%' : '';
      const text = `${rule.symbol} ${rule.type === 'pct' ? 'change' : 'price'} ${rule.op} ${rule.value}${unit} — now ${fmtMetric(metric, rule.type)}`;
      store.logAlert({ ts: now, symbol: rule.symbol, text });
      onFire(rule, text, q);
    } else if (!hit && rule._latched) {
      rule._latched = false; // re-arm once the condition clears
    }
  }
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
