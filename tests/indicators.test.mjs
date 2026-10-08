// Run: node --test tests/indicators.test.mjs
// Reference values are hand-checked or taken from the published StockCharts
// worked examples, so a regression shows up as a number, not as "looks off".
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/indicators.js';

const near = (a, b, eps = 1e-6, msg) => {
  assert.ok(a != null && Number.isFinite(a), (msg || '') + ' expected a number, got ' + a);
  assert.ok(Math.abs(a - b) <= eps, (msg || '') + ` ${a} != ${b} (±${eps})`);
};
const bar = (t, o, h, l, c, v = 1000) => ({ t: t * 86400000, o, h, l, c, v });
const fromCloses = (cs) => cs.map((c, i) => bar(i, c, c + 1, c - 1, c));

// StockCharts "RSI" ChartSchool worked example (14-period, Wilder smoothing).
const RSI_CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
  46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const RSI_EXPECTED = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.90, 45.50, 37.32, 33.09, 37.79];

test('SMA: simple window, alignment and warm-up', () => {
  const s = I.sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(s, [null, null, 2, 3, 4]);
});

test('SMA: a window containing a gap is null, not a shorter mean', () => {
  const s = I.sma([1, 2, null, 4, 5, 6], 2);
  assert.deepEqual(s, [null, 1.5, null, null, 4.5, 5.5]);
});

test('EMA: seeded with SMA, k = 2/(n+1)', () => {
  const e = I.ema([1, 2, 3, 4, 5, 6], 3);
  // seed SMA(1,2,3)=2; k=0.5 -> 3, 4, 5
  assert.deepEqual(e, [null, null, 2, 3, 4, 5]);
  const e2 = I.ema([10, 11, 12, 13], 2);       // seed 10.5, k=2/3
  near(e2[2], 12 * 2 / 3 + 10.5 / 3);
  near(e2[3], 13 * 2 / 3 + e2[2] / 3);
});

test('EMA: a missing value is skipped without resetting the state', () => {
  const e = I.ema([1, 2, 3, null, 5], 3);
  assert.equal(e[3], null);
  near(e[4], 5 * 0.5 + 2 * 0.5);
});

test('WMA: weights 1..n', () => {
  const w = I.wma([1, 2, 3], 3);
  near(w[2], (1 * 1 + 2 * 2 + 3 * 3) / 6);
});

test('RSI matches the Wilder/StockCharts worked example', () => {
  const r = I.rsiOf(RSI_CLOSES, 14);
  for (let i = 0; i < 14; i++) assert.equal(r[i], null);
  RSI_EXPECTED.forEach((v, k) => near(r[14 + k], v, 0.01, 'RSI[' + (14 + k) + ']'));
});

test('RSI: all gains = 100, flat = 50', () => {
  const up = I.rsiOf(Array.from({ length: 20 }, (_, i) => i + 1), 14);
  assert.equal(up[19], 100);
  const flat = I.rsiOf(new Array(20).fill(5), 14);
  assert.equal(flat[19], 50);
});

test('RSI registry entry exposes levels and range', () => {
  assert.deepEqual(I.INDICATORS.rsi.levels, [30, 70]);
  assert.deepEqual(I.INDICATORS.rsi.range, [0, 100]);
});

test('Bollinger: population stdev', () => {
  // classic textbook set: mean 5, population sd 2
  const bars = fromCloses([2, 4, 4, 4, 5, 5, 7, 9]);
  const b = I.bollinger(bars, 8, 2);
  near(b.mid[7], 5); near(b.upper[7], 9); near(b.lower[7], 1);
  near(I.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);
  near(I.stdev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));   // scalar form is the sample stdev
});

test('MACD = EMA12 − EMA26, signal = EMA9(MACD), hist = MACD − signal', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.3);
  const m = I.macdOf(c, 12, 26, 9);
  const e12 = I.ema(c, 12), e26 = I.ema(c, 26);
  assert.equal(m.macd[24], null);
  near(m.macd[25], e12[25] - e26[25]);
  near(m.macd[79], e12[79] - e26[79]);
  assert.equal(m.signal[32], null);
  near(m.signal[33], m.macd.slice(25, 34).reduce((a, b) => a + b, 0) / 9);
  near(m.hist[79], m.macd[79] - m.signal[79]);
});

test('ATR: true range uses the previous close, Wilder smoothing', () => {
  const bars = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 10, 11), bar(2, 11, 11.5, 8, 9), bar(3, 9, 10, 9, 10)];
  assert.deepEqual(I.trueRange(bars), [2, 2, 3.5, 1]);
  const a = I.atr(bars, 2);
  assert.equal(a[0], null);
  near(a[1], 2);            // seed = mean(2,2)
  near(a[2], (2 + 3.5) / 2);
  near(a[3], (a[2] + 1) / 2);
});

test('Stochastic: %K = SMA3 of raw, %D = SMA3 of %K', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, i, i + 2, i, i + 1));
  const s = I.stochastic(bars, 5, 3, 3);
  // in a steady climb close = hh − 1, range = 6 over 5 bars -> raw = 100*(c-ll)/6
  const raw = (i) => (100 * ((i + 1) - (i - 4))) / ((i + 2) - (i - 4));
  near(s.k[10], (raw(8) + raw(9) + raw(10)) / 3);
  assert.equal(s.d[5], null);
  assert.ok(s.d[19] != null);
});

test('ADX: DI lines from bar n, ADX from bar 2n−1, in 0..100', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 101 + i + (i % 3), 99 + i, 100.5 + i));
  const d = I.dmi(bars, 14);
  assert.equal(d.plus[13], null);
  assert.ok(d.plus[14] != null);
  assert.equal(d.adx[26], null);
  assert.ok(d.adx[27] != null);
  for (const v of d.adx) if (v != null) assert.ok(v >= 0 && v <= 100);
  assert.ok(d.plus[59] > d.minus[59], 'an uptrend has +DI above −DI');
});

test('OBV accumulates by close direction; v=null leaves a gap', () => {
  const bars = [bar(0, 1, 1, 1, 10, 100), bar(1, 1, 1, 1, 11, 50), bar(2, 1, 1, 1, 10, 20), bar(3, 1, 1, 1, 10, 30), { ...bar(4, 1, 1, 1, 12), v: null }];
  assert.deepEqual(I.obv(bars), [0, 50, 30, 30, null]);
});

test('VWAP resets per session on intraday bars and is null without volume', () => {
  const t0 = Date.UTC(2026, 0, 5, 14, 30);
  const m = 5 * 60000;
  const bars = [
    { t: t0, o: 10, h: 10, l: 10, c: 10, v: 100 },
    { t: t0 + m, o: 20, h: 20, l: 20, c: 20, v: 300 },
    { t: t0 + 86400000, o: 30, h: 30, l: 30, c: 30, v: 50 },
    { t: t0 + 86400000 + m, o: 30, h: 30, l: 30, c: 30, v: null },
  ];
  const v = I.INDICATORS.vwap.compute(bars, { bands: 0 }).lines[0].values;
  near(v[0], 10); near(v[1], (10 * 100 + 20 * 300) / 400); near(v[2], 30);
  assert.equal(v[3], null);
});

test('CCI, MFI, Williams %R, ROC, CMF: hand-checked values', () => {
  const bars = fromCloses([10, 11, 12, 13, 14]);
  // tp = c; sma3 at i=4 = 13; md = (1+0+1)/3
  near(I.cci(bars, 3)[4], (14 - 13) / (0.015 * (2 / 3)));
  near(I.mfi(bars, 3)[4], 100);
  const w = I.INDICATORS.willr.compute(bars, { period: 3 }).lines[0].values;
  near(w[4], (-100 * (15 - 14)) / (15 - 11));
  const r = I.INDICATORS.roc.compute(bars, { period: 2 }).lines[0].values;
  near(r[4], 100 * (14 / 12 - 1));
  const flatClose = [bar(0, 1, 2, 0, 2, 10), bar(1, 1, 2, 0, 0, 30)];   // close at high: +1·v, at low: −1·v
  near(I.cmf(flatClose, 2)[1], (10 - 30) / 40);
});

test('Pivots: classic, fibonacci, camarilla', () => {
  const p = I.pivots({ h: 110, l: 100, c: 105 }, 'classic');
  assert.deepEqual(p, { P: 105, R1: 110, S1: 100, R2: 115, S2: 95, R3: 120, S3: 90 });
  const f = I.pivots({ h: 110, l: 100, c: 105 }, 'fibonacci');
  near(f.R1, 105 + 3.82); near(f.S2, 105 - 6.18);
  const c = I.pivots({ h: 110, l: 100, c: 105 }, 'camarilla');
  near(c.R4, 105 + 5.5); near(c.S1, 105 - 11 / 12);
  assert.equal(I.pivots({ h: 1, l: null, c: 1 }), null);
});

test('Heikin-Ashi', () => {
  const ha = I.heikinAshi([bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12)]);
  near(ha[0].o, 10.5); near(ha[0].c, 10.5);
  near(ha[1].o, 10.5); near(ha[1].c, 11.5); near(ha[1].h, 13); near(ha[1].l, 10);
});

test('Ichimoku: Tenkan/Kijun midpoints, forward-shifted spans', () => {
  const bars = Array.from({ length: 80 }, (_, i) => bar(i, i, i + 1, i - 1, i));
  const r = I.INDICATORS.ichimoku.compute(bars, I.defaultParams('ichimoku'));
  const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
  near(by.tenkan.values[20], ((21) + (12 - 1)) / 2);   // HH9 = 21, LL9 = 11
  assert.equal(by.spanA.shift, 25);
  assert.equal(by.chikou.shift, -25);
  assert.equal(r.fill, 'cloud');
});

test('PSAR and SuperTrend sit below price in a steady uptrend', () => {
  const bars = Array.from({ length: 50 }, (_, i) => bar(i, 100 + i, 101.5 + i, 99.5 + i, 101 + i));
  const s = I.psar(bars);
  assert.ok(s[49] < bars[49].l);
  const st = I.supertrend(bars, 10, 3);
  assert.ok(st.up[49] != null && st.up[49] < bars[49].c);
  assert.equal(st.down[49], null);
});

test('relativeStrength joins on t and rebases to 1', () => {
  const A = [bar(0, 0, 0, 0, 10), bar(1, 0, 0, 0, 12), bar(2, 0, 0, 0, 15)];
  const B = [bar(0, 0, 0, 0, 5), bar(2, 0, 0, 0, 5)];
  const rs = I.relativeStrength(A, B);
  assert.deepEqual(rs, [1, null, 1.5]);
});

test('returns, maxDrawdown, drawdownSeries', () => {
  const r = I.returns([100, 110, 99]);
  assert.equal(r[0], null); near(r[1], 0.1); near(r[2], -0.1);
  near(I.maxDrawdown([100, 120, 90, 130, 65]), -0.5);
  assert.equal(I.maxDrawdown([1, 2, 3]), 0);
  assert.equal(I.maxDrawdown([]), null);
  assert.deepEqual(I.drawdownSeries([100, 50, 100]), [0, -0.5, 0]);
});

test('edge cases: every registry indicator survives empty, short, flat, null and v=null input', () => {
  const t = (i) => i * 86400000;
  const cases = {
    empty: [],
    one: [bar(0, 1, 1, 1, 1)],
    short: fromCloses([1, 2, 3]),
    flat: Array.from({ length: 120 }, (_, i) => bar(i, 5, 5, 5, 5)),
    holes: Array.from({ length: 120 }, (_, i) => (i % 17 === 5 ? { t: t(i), o: null, h: null, l: null, c: null, v: null } : bar(i, 10 + Math.sin(i), 11 + Math.sin(i), 9 + Math.sin(i), 10.5 + Math.sin(i)))),
    novol: Array.from({ length: 120 }, (_, i) => ({ ...bar(i, 10, 11, 9, 10 + (i % 5)), v: null })),
  };
  for (const [name, bars] of Object.entries(cases)) {
    for (const id of Object.keys(I.INDICATORS)) {
      const r = I.computeIndicator(id, bars, {});
      assert.ok(r && Array.isArray(r.lines), `${id}/${name} returned lines`);
      for (const line of r.lines) {
        assert.equal(line.values.length, bars.length, `${id}/${name}/${line.key} aligned`);
        for (const v of line.values) assert.ok(v === null || Number.isFinite(v), `${id}/${name}/${line.key} has no NaN (${v})`);
      }
    }
  }
});

test('registry shape matches the shared contract', () => {
  const need = ['sma', 'ema', 'wma', 'vwap', 'bb', 'keltner', 'donchian', 'ichimoku', 'psar', 'supertrend', 'rsi', 'macd', 'stoch',
    'stochrsi', 'atr', 'adx', 'obv', 'mfi', 'cci', 'willr', 'roc', 'cmf', 'volma'];
  for (const id of need) {
    const d = I.INDICATORS[id];
    assert.ok(d, id + ' present');
    assert.equal(d.id, id);
    assert.ok(d.kind === 'overlay' || d.kind === 'pane');
    assert.ok(typeof d.label === 'string' && typeof d.learn === 'string');
    assert.ok(Array.isArray(d.params) && typeof d.compute === 'function');
  }
  assert.equal(I.computeIndicator('nope', [], {}), null);
});
