/* scan.test.mjs — screener metrics, filters and the treemap layout (js/scan.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFromBars, applyFilters, passes, treemap, SCAN_PRESETS, SCAN_FIELDS } from '../js/scan.js';

const DAY = 86400000;
function bars(n, f, start = Date.UTC(2025, 9, 1)) {
  const out = [];
  for (let i = 0; i < n; i++) { const c = f(i); out.push({ t: start + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }); }
  return out;
}

test('empty or junk input gives null, never NaN', () => {
  assert.equal(metricsFromBars([]), null);
  assert.equal(metricsFromBars(null), null);
  const m = metricsFromBars(bars(3, () => 10));
  for (const v of Object.values(m)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
  assert.equal(m.sma200, null);
  assert.equal(m.trend, null);
});

test('steady rise: uptrend, positive changes, at the 52-week high', () => {
  const m = metricsFromBars(bars(260, (i) => 100 + i));
  assert.equal(m.trend, 'up');
  assert.ok(m.chg1d > 0 && m.chg5d > 0 && m.chg1m > 0);
  assert.ok(m.vsSma50 > 0 && m.vsSma200 > 0);
  assert.equal(m.rsi14, 100);                      // no down days at all
  assert.ok(Math.abs(m.chg5d - ((359 / 354 - 1) * 100)) < 1e-9);
  assert.ok(m.fromHigh52 <= 0 && m.fromHigh52 > -2);
});

test('a live quote on a new day moves price, 1D and gap', () => {
  const b = bars(30, () => 100);
  const q = { price: 103, changePct: 3, prevClose: 100, open: 102, ts: b[b.length - 1].t + DAY + 3600e3, volume: 5000 };
  const m = metricsFromBars(b, q);
  assert.equal(m.price, 103);
  assert.equal(m.chg1d, 3);
  assert.ok(Math.abs(m.gap - 2) < 1e-9);
  assert.ok(Math.abs(m.relVol - 5) < 1e-9);       // 5000 vs a flat 1000 average
});

test('golden cross detected within the last 10 bars', () => {
  // Long decline then a sharp rally: the 50-day crosses above the 200-day late.
  const b = bars(300, (i) => (i < 200 ? 200 - i * 0.5 : 100 + (i - 200) * 3));
  const crosses = [];
  for (let n = 220; n <= 300; n++) { const m = metricsFromBars(b.slice(0, n)); if (m.cross === 'golden') crosses.push(n); }
  assert.ok(crosses.length > 0 && crosses.length <= 10);
});

test('filters: a missing value never passes; presets are well formed', () => {
  assert.equal(passes({ rsi14: null }, { f: 'rsi14', op: 'lt', v: 30 }), false);
  assert.equal(passes({ rsi14: 25 }, { f: 'rsi14', op: 'lt', v: 30 }), true);
  assert.equal(passes({ trend: 'up' }, { f: 'trend', op: 'is', v: 'up' }), true);
  const rows = [{ sym: 'A', m: { rsi14: 20 } }, { sym: 'B', m: { rsi14: 50 } }];
  assert.deepEqual(applyFilters(rows, [{ f: 'rsi14', op: 'lt', v: 30 }]).map((r) => r.sym), ['A']);
  assert.equal(applyFilters(rows, []).length, 2);
  const ids = new Set(SCAN_FIELDS.map((f) => f.id).concat('cross'));
  for (const p of SCAN_PRESETS) for (const f of p.filters) assert.ok(ids.has(f.f), p.id);
});

test('treemap fills the rectangle with areas proportional to value', () => {
  const items = [5, 3, 2, 1, 1, 0.5].map((value, i) => ({ value, id: i }));
  const out = treemap(items, 0, 0, 300, 200);
  assert.equal(out.length, items.length);
  const total = items.reduce((a, b) => a + b.value, 0);
  let area = 0;
  for (const r of out) {
    area += r.w * r.h;
    assert.ok(Math.abs(r.w * r.h - (r.value / total) * 60000) < 1e-6);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 300 + 1e-6 && r.y + r.h <= 200 + 1e-6);
  }
  assert.ok(Math.abs(area - 60000) < 1e-6);
  assert.deepEqual(treemap([{ value: 0 }], 0, 0, 10, 10), []);
});
