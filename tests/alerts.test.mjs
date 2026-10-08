// node --test tests/alerts.test.mjs
// Alert evaluation per type, plus the latch / cross / once / expiry / session /
// confirmation / missing-data semantics. store.js touches localStorage, location
// and history at import, so a Map-backed shim is installed before it loads.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };

const { store } = await import('../js/store.js');
const { evaluateAlerts } = await import('../js/engine.js');
const AT = await import('../js/alerttypes.js');

const T0 = Date.UTC(2026, 9, 7, 15, 0, 0);   // a Wednesday afternoon (UTC)
const DAY = 86400000;

function rule(over) {
  return { id: 'r' + Math.random().toString(36).slice(2), symbol: 'AAA', type: 'price', op: 'above', value: 100,
    armed: true, sessions: [], repeat: 'rearm', expires: null, ...over };
}
// One pass; returns the fired texts.
function run(quotes, ctx = {}) {
  const fired = [];
  evaluateAlerts(quotes, (r, text) => fired.push(text), { now: T0, ...ctx });
  return fired;
}
function q(price, over) { return { AAA: { symbol: 'AAA', price, prevClose: 100, changePct: (price / 100 - 1) * 100, ...over } }; }
// Daily bars, oldest first, stamped at 00:00 UTC; the last one is yesterday.
function bars(closes, over = {}) {
  const n = closes.length;
  return closes.map((c, i) => ({ t: T0 - (n - i) * DAY, o: c, h: c, l: c, c, v: 1000, ...over }));
}
function reset(rules) { store.rules = rules; store.alertlog = []; }

test('price above: fires once, latches, re-arms after clearing and cooldown', () => {
  const r = rule(); reset([r]);
  assert.equal(run(q(99)).length, 0);
  assert.equal(run(q(100)).length, 1, 'inclusive >=');
  assert.equal(run(q(101)).length, 0, 'latched');
  run(q(99));                                              // clears latch
  assert.equal(r._latched, false);
  assert.equal(run(q(101)).length, 0, 'still in cooldown');
  assert.equal(run(q(101), { now: T0 + 61000 }).length, 1);
  assert.equal(store.alertlog.length, 2);
  assert.equal(store.alertlog[0].ruleId, r.id);
});

test('missing metric skips the rule without touching the latch', () => {
  const r = rule({ type: 'pct', op: 'below', value: 1 }); reset([r]);
  assert.equal(run({ AAA: { symbol: 'AAA', price: 50, changePct: null } }).length, 0, 'null is not 0%');
  r._latched = true;
  run({ AAA: { symbol: 'AAA', price: 50, changePct: null } });
  assert.equal(r._latched, true);
  assert.equal(run({}).length, 0, 'no quote at all');
});

test('crossAbove waits for a real cross', () => {
  const r = rule({ op: 'crossAbove' }); reset([r]);
  assert.equal(run(q(105)).length, 0, 'already above when created');
  assert.equal(run(q(95)).length, 0);
  assert.equal(r._xready, true);
  assert.equal(run(q(102)).length, 1);
  assert.equal(r._prev, 102);
  assert.equal(run(q(103), { now: T0 + 120000 }).length, 0, 'staying above is not a new cross');
  run(q(90), { now: T0 + 130000 });
  assert.equal(run(q(110), { now: T0 + 200000 }).length, 1);
});

test('crossBelow mirrors crossAbove', () => {
  const r = rule({ op: 'crossBelow', value: 50 }); reset([r]);
  run(q(51)); assert.equal(run(q(49)).length, 1);
});

test("repeat 'once' disarms after firing", () => {
  const r = rule({ repeat: 'once' }); reset([r]);
  assert.equal(run(q(120)).length, 1);
  assert.equal(r.armed, false);
  assert.equal(r.disarmedBy, 'fired');
  run(q(80)); assert.equal(run(q(120), { now: T0 + 1e6 }).length, 0);
});

test('expired rules disarm and never fire', () => {
  const r = rule({ expires: '2026-10-06' }); reset([r]);
  assert.equal(run(q(150)).length, 0);
  assert.equal(r.armed, false);
  assert.equal(r.disarmedBy, 'expired');
  const live = rule({ expires: '2026-10-07' }); reset([live]);
  assert.equal(run(q(150)).length, 1, 'expiry day itself still counts');
});

test('session gate skips without consuming the latch', () => {
  const r = rule({ sessions: ['open'] }); reset([r]);
  const post = () => ({ state: 'post', label: 'After hours' });
  assert.equal(run(q(150), { sessionFor: post }).length, 0);
  assert.equal(r._latched, undefined);
  assert.equal(run(q(150), { sessionFor: () => ({ state: 'open' }) }).length, 1);
});

test('extended hours need confirmation ticks', () => {
  const r = rule({ sessions: ['pre', 'open', 'post'] }); reset([r]);
  const pre = () => ({ state: 'pre', label: 'Pre-market' });
  assert.equal(run(q(150), { sessionFor: pre }).length, 0);
  const t = run(q(150), { sessionFor: pre });
  assert.equal(t.length, 1);
  assert.match(t[0], /pre-market/);
  const r1 = rule({ sessions: [], confirm: 1 }); reset([r1]);
  assert.equal(run(q(150), { sessionFor: pre }).length, 1, 'per-rule confirm overrides');
});

test('unknown types and broken callbacks never throw', () => {
  reset([rule({ type: 'fromTheFuture' }), rule({ type: 'rsi', value: 50 })]);
  assert.doesNotThrow(() => run(q(150), { barsFor: () => { throw new Error('x'); } }));
  assert.equal(run(q(150), { barsFor: () => Promise.resolve(bars([1, 2, 3])) }).length, 0, 'async answer = not yet');
});

test('alert text uses magnitude precision', () => {
  reset([rule({ symbol: 'DOGE', value: 0.0001 })]);
  const t = run({ DOGE: { symbol: 'DOGE', price: 0.000123, changePct: 1 } });
  assert.equal(t.length, 1);
  assert.match(t[0], /0\.00012300/);
  assert.doesNotMatch(t[0], /now 0\.00\b/);
});

test('pct / pctFromOpen / gap / volume', () => {
  reset([rule({ type: 'pct', value: 5 })]);
  assert.equal(run(q(106)).length, 1);
  reset([rule({ type: 'pctFromOpen', value: 2 })]);
  assert.equal(run(q(103, { open: 101 })).length, 0);
  assert.equal(run(q(104, { open: 101 })).length, 1);
  reset([rule({ type: 'gap', op: 'below', value: -2 })]);
  assert.equal(run(q(97, { open: 97 })).length, 1);
  reset([rule({ type: 'gap', value: 2 })]);
  assert.equal(run(q(97, { open: null })).length, 0, 'no open, no gap');
  reset([rule({ type: 'volume', value: 5e6 })]);
  assert.equal(run(q(100, { volume: 6e6 })).length, 1);
});

test('relVolume from bars, then from fundamentals', () => {
  reset([rule({ type: 'relVolume', value: 2 })]);
  const b = bars(Array(30).fill(100), { v: 1000 });
  assert.equal(run(q(100, { volume: 1500 }), { barsFor: () => b }).length, 0);
  assert.equal(run(q(100, { volume: 2500 }), { barsFor: () => b, now: T0 + 1 }).length, 1);
  reset([rule({ type: 'relVolume', value: 2 })]);
  assert.equal(run(q(100, { volume: 3e6 }), { fundamentalsFor: () => ({ avgVolume10d: 1e6 }) }).length, 1);
});

test('52-week proximity and new highs/lows', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 50 + (i % 50));   // range 50..99
  const b = bars(closes);
  reset([rule({ type: 'newHigh52', value: 0 })]);
  assert.equal(run(q(98), { barsFor: () => b }).length, 0);
  assert.equal(run(q(99.5), { barsFor: () => b }).length, 1);
  reset([rule({ type: 'newLow52' })]);
  assert.equal(run(q(49), { barsFor: () => b }).length, 1);
  reset([rule({ type: 'high52Prox', op: 'below', value: 5 })]);
  assert.equal(run(q(95), { barsFor: () => b }).length, 1);
  reset([rule({ type: 'newHigh52' })]);
  assert.equal(run(q(150), { barsFor: () => bars([1, 2, 3]) }).length, 0, 'thirty bars are not a year');
  assert.equal(run(q(150), { barsFor: () => bars([1, 2, 3]), fundamentalsFor: () => ({ high52: 140, low52: 10 }) }).length, 1);
});

test('trailStop tracks the peak since armed', () => {
  const r = rule({ type: 'trailStop', value: 10 }); reset([r]);
  run(q(100)); run(q(120));
  assert.equal(r._peak, 120);
  assert.equal(run(q(110)).length, 0);
  assert.equal(run(q(108)).length, 1, '10% below 120');
  store.updateRule(r.id, { armed: false }); store.updateRule(r.id, { armed: true });
  assert.equal(r._peak, undefined, 're-arm resets the peak');
});

test('smaCross / emaCross / maCross on daily bars with the live print', () => {
  const b = bars(Array(60).fill(100));
  const r = rule({ type: 'smaCross', op: 'crossAbove', value: 0, params: { period: 50 } }); reset([r]);
  assert.equal(run(q(99, { prevClose: 100 }), { barsFor: () => b }).length, 0);
  assert.equal(run(q(101, { prevClose: 100 }), { barsFor: () => b }).length, 1);
  const e = rule({ type: 'emaCross', op: 'below', value: -1, params: { period: 21 } }); reset([e]);
  assert.equal(run(q(97, { prevClose: 100 }), { barsFor: () => b }).length, 1);
  // golden cross: slow average flat at 100, fast one dragged up by the recent run
  const up = bars([...Array(200).fill(100), ...Array(49).fill(100)]);
  const g = rule({ type: 'maCross', op: 'crossAbove', value: 0, params: { fast: 5, slow: 20 } }); reset([g]);
  run(q(99, { prevClose: 100 }), { barsFor: () => up });
  assert.equal(g._xready, true);
  assert.equal(run(q(130, { prevClose: 100 }), { barsFor: () => up }).length, 1);
});

test('RSI matches the textbook Wilder example', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(AT.rsiLast(c, 14) - 70.53) < 0.1, String(AT.rsiLast(c, 14)));
  assert.ok(Math.abs(AT.rsiLast([...c, 46.00], 14) - 66.32) < 0.1);
  assert.equal(AT.rsiLast([1, 2, 3], 14), null);
  reset([rule({ type: 'rsi', value: 70 })]);
  const b = bars(c.slice(0, -1));
  assert.equal(run({ AAA: { symbol: 'AAA', price: 46.28, prevClose: 46.28 } }, { barsFor: () => b }).length, 1);
});

test('MACD, Bollinger and ATR helpers', () => {
  const lin = Array.from({ length: 60 }, (_, i) => 100 + i);
  const m = AT.macdLast(lin);
  assert.ok(m && m.macd > 0 && Math.abs(m.hist) < 1e-6, 'steady trend: macd positive, hist ~0');
  const bb = AT.bbLast([1, 2, 3, 4, 5], 5, 2);
  assert.equal(bb.mid, 3);
  assert.ok(Math.abs(bb.upper - (3 + 2 * Math.SQRT2)) < 1e-9, 'population sigma');
  const flat = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10 }));
  assert.equal(AT.atrLast(flat, 14), 2);
  const ema = AT.emaSeries([1, 2, 3, 4], 2);
  assert.deepEqual(ema.slice(0, 1), [null]);
  assert.equal(ema[1], 1.5);
});

test('macdCross / bbBreak / atrMove rules', () => {
  const down = bars(Array.from({ length: 80 }, (_, i) => 200 - i));
  const r = rule({ type: 'macdCross', op: 'crossAbove', value: 0 }); reset([r]);
  run(q(110, { prevClose: 121 }), { barsFor: () => down });   // falling faster: histogram < 0
  assert.equal(r._xready, true);
  assert.equal(run(q(170, { prevClose: 121 }), { barsFor: () => down }).length, 1);

  const flat = bars(Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
  reset([rule({ type: 'bbBreak', op: 'above', value: 100 })]);
  assert.equal(run(q(100.5, { prevClose: 101 }), { barsFor: () => flat }).length, 0);
  assert.equal(run(q(104, { prevClose: 101 }), { barsFor: () => flat }).length, 1);

  const ranged = Array.from({ length: 30 }, (_, i) => ({ t: T0 - (30 - i) * DAY, o: 100, h: 101, l: 99, c: 100, v: 1 }));
  reset([rule({ type: 'atrMove', value: 1.5 })]);
  assert.equal(run(q(102, { prevClose: 100 }), { barsFor: () => ranged }).length, 0);
  assert.equal(run(q(103.5, { prevClose: 100 }), { barsFor: () => ranged }).length, 1);
});

test('portfolio rules read ctx.portfolio and skip without it', () => {
  const pv = rule({ symbol: '@PORTFOLIO', type: 'portfolioValue', op: 'below', value: 9000 });
  const pd = rule({ symbol: '@PORTFOLIO', type: 'portfolioDayPct', op: 'below', value: -2 });
  const pl = rule({ symbol: '@PORTFOLIO', type: 'portfolioDayPL', op: 'below', value: -100 });
  reset([pv, pd, pl]);
  assert.equal(run({}).length, 0);
  const t = run({}, { portfolio: { netWorth: 8000, marketValue: 7000, dayPL: -300 } });
  assert.equal(t.length, 3);
  assert.match(t[0], /^Portfolio value/);
});

test('describeRule and level filtering', () => {
  assert.match(AT.describeRule({ symbol: 'AAA', type: 'maCross', op: 'crossAbove', value: 0, params: {} }), /SMA50 crosses above SMA200/);
  assert.match(AT.describeRule({ symbol: 'AAA', type: 'nope', op: 'above', value: 1 }), /not supported/);
  assert.ok(AT.typesForLevel('beginner').includes('price'));
  assert.ok(!AT.typesForLevel('beginner').includes('macdCross'));
  assert.equal(AT.typesForLevel('pro').length, Object.keys(AT.ALERT_TYPES).length);
  for (const d of Object.values(AT.ALERT_TYPES)) {
    assert.ok(d.ops.length && d.learn && d.group && typeof d.metric === 'function', d.id);
  }
});
