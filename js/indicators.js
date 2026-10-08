/* indicators.js — the one place technical indicators are defined.

   Charts, the screener and technical alerts all read the same numbers, so the
   formulas live here once and are unit-tested (tests/indicators.test.mjs)
   against textbook values rather than against whatever a chart looked like.

   Conventions every function keeps:
   - Input is Bar[] ({t,o,h,l,c,v}, oldest first) or number[] where noted.
   - Output arrays are ALIGNED to the input: same length, null during warm-up
     and wherever an input value was missing. Callers index by bar, never by
     "the nth computed value", so a 200-period average lines up with its bar.
   - A null/NaN input never propagates NaN: it yields null at that index and,
     for recursive averages (EMA/RMA), leaves the running state untouched so a
     single missing tick does not reset a 200-bar warm-up.
   - Smoothing follows the originals: Wilder's RMA for RSI/ATR/ADX, EMA seeded
     with the SMA of its first window, population stdev for Bollinger.

   Pure. No imports, no DOM, no clock. Descriptive analytics only — nothing in
   here says what anyone should do with a reading. */

/* ---- primitives ----------------------------------------------------------- */

const fin = (x) => (x == null ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
const nulls = (n) => new Array(n).fill(null);

export const closes = (bars) => (bars || []).map((b) => fin(b && b.c));
const highs = (bars) => bars.map((b) => fin(b && b.h));
const lows = (bars) => bars.map((b) => fin(b && b.l));
const vols = (bars) => bars.map((b) => fin(b && b.v));
export const typical = (bars) => bars.map((b) => {
  const h = fin(b && b.h), l = fin(b && b.l), c = fin(b && b.c);
  return h == null || l == null || c == null ? null : (h + l + c) / 3;
});

// Simple moving average. A window containing a missing value is itself missing:
// averaging 19 numbers and calling it a 20-period mean is a quiet lie.
export function sma(values, n) {
  const len = values.length, out = nulls(len);
  n = Math.max(1, Math.floor(n));
  let sum = 0, valid = 0;
  for (let i = 0; i < len; i++) {
    const v = fin(values[i]);
    if (v != null) { sum += v; valid++; }
    if (i >= n) { const o = fin(values[i - n]); if (o != null) { sum -= o; valid--; } }
    if (i >= n - 1 && valid === n) out[i] = sum / n;
  }
  return out;
}

// Weighted moving average, weights 1..n (newest heaviest).
export function wma(values, n) {
  const len = values.length, out = nulls(len);
  n = Math.max(1, Math.floor(n));
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < len; i++) {
    let s = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const v = fin(values[i - n + 1 + k]);
      if (v == null) { ok = false; break; }
      s += v * (k + 1);
    }
    if (ok) out[i] = s / den;
  }
  return out;
}

/* Shared recursive average. alpha = 2/(n+1) for EMA, 1/n for Wilder's RMA.
   Seeded with the SMA of the first n finite values, which is the textbook
   definition and what every charting package uses; seeding with the first
   value instead makes the first ~3n bars wrong. */
function recursive(values, n, alpha) {
  const len = values.length, out = nulls(len);
  n = Math.max(1, Math.floor(n));
  let state = null, seedSum = 0, seedCount = 0;
  for (let i = 0; i < len; i++) {
    const v = fin(values[i]);
    if (v == null) continue;
    if (state == null) {
      seedSum += v; seedCount++;
      if (seedCount === n) { state = seedSum / n; out[i] = state; }
      continue;
    }
    state = v * alpha + state * (1 - alpha);
    out[i] = state;
  }
  return out;
}

export const ema = (values, n) => recursive(values, n, 2 / (Math.max(1, Math.floor(n)) + 1));
export const rma = (values, n) => recursive(values, n, 1 / Math.max(1, Math.floor(n)));

/* stdev(values) -> one number: the SAMPLE standard deviation (n-1) of the finite
   values, which is what risk statistics on returns want.
   stdev(values, n) -> aligned rolling POPULATION stdev over n, which is what
   Bollinger defined his bands with. Two meanings, one name, because the contract
   names one helper; the arity decides. */
export function stdev(values, n) {
  if (n == null) {
    const xs = (values || []).map(fin).filter((x) => x != null);
    if (xs.length < 2) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
  }
  const len = values.length, out = nulls(len), mean = sma(values, n);
  for (let i = n - 1; i < len; i++) {
    if (mean[i] == null) continue;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) { const d = values[k] - mean[i]; s += d * d; }
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

const rollMax = (values, n) => roll(values, n, Math.max);
const rollMin = (values, n) => roll(values, n, Math.min);
function roll(values, n, fn) {
  const len = values.length, out = nulls(len);
  for (let i = n - 1; i < len; i++) {
    let r = null;
    for (let k = i - n + 1; k <= i; k++) {
      const v = fin(values[k]);
      if (v == null) { r = null; break; }
      r = r == null ? v : fn(r, v);
    }
    out[i] = r;
  }
  return out;
}

const sub = (a, b) => a.map((x, i) => (x == null || b[i] == null ? null : x - b[i]));

/* ---- building blocks shared by several indicators ------------------------- */

// True range. The first bar has no previous close, so it is high − low.
export function trueRange(bars) {
  return bars.map((b, i) => {
    const h = fin(b && b.h), l = fin(b && b.l);
    if (h == null || l == null) return null;
    const pc = i > 0 ? fin(bars[i - 1] && bars[i - 1].c) : null;
    if (pc == null) return h - l;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
}

export const atr = (bars, n = 14) => rma(trueRange(bars), n);

// Wilder RSI over any number series (used directly and by Stoch RSI).
export function rsiOf(values, n = 14) {
  const len = values.length, out = nulls(len);
  let ag = null, al = null, sg = 0, sl = 0, cnt = 0, prev = null;
  for (let i = 0; i < len; i++) {
    const v = fin(values[i]);
    if (v == null) continue;
    if (prev == null) { prev = v; continue; }
    const ch = v - prev; prev = v;
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    if (ag == null) {
      sg += g; sl += l; cnt++;
      if (cnt < n) continue;
      ag = sg / n; al = sl / n;
    } else {
      ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n;
    }
    out[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function macdOf(values, fast = 12, slow = 26, signal = 9) {
  const m = sub(ema(values, fast), ema(values, slow));
  const s = ema(m, signal);
  return { macd: m, signal: s, hist: sub(m, s) };
}

export function bollinger(bars, n = 20, k = 2) {
  const c = closes(bars), mid = sma(c, n), sd = stdev(c, n);
  const upper = mid.map((m, i) => (m == null ? null : m + k * sd[i]));
  const lower = mid.map((m, i) => (m == null ? null : m - k * sd[i]));
  const pctB = c.map((x, i) => (upper[i] == null || x == null || upper[i] === lower[i] ? null : (x - lower[i]) / (upper[i] - lower[i])));
  const width = mid.map((m, i) => (m == null || m === 0 ? null : (upper[i] - lower[i]) / m));
  return { upper, mid, lower, pctB, width };
}

export function stochastic(bars, n = 14, smoothK = 3, d = 3) {
  const hh = rollMax(highs(bars), n), ll = rollMin(lows(bars), n), c = closes(bars);
  const raw = c.map((x, i) => {
    if (x == null || hh[i] == null || ll[i] == null) return null;
    const r = hh[i] - ll[i];
    return r === 0 ? 50 : (100 * (x - ll[i])) / r;
  });
  const k = smoothK > 1 ? sma(raw, smoothK) : raw;
  return { k, d: sma(k, d) };
}

// Directional movement (Wilder). DI lines start at bar n, ADX at bar 2n−1.
export function dmi(bars, n = 14) {
  const len = bars.length;
  const pdm = nulls(len), mdm = nulls(len), tr = nulls(len);
  for (let i = 1; i < len; i++) {
    const h = fin(bars[i].h), l = fin(bars[i].l), ph = fin(bars[i - 1].h), pl = fin(bars[i - 1].l), pc = fin(bars[i - 1].c);
    if (h == null || l == null || ph == null || pl == null || pc == null) continue;
    const up = h - ph, dn = pl - l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const sTR = rma(tr, n), sP = rma(pdm, n), sM = rma(mdm, n);
  const plus = sTR.map((t, i) => (t == null || sP[i] == null ? null : t === 0 ? 0 : (100 * sP[i]) / t));
  const minus = sTR.map((t, i) => (t == null || sM[i] == null ? null : t === 0 ? 0 : (100 * sM[i]) / t));
  const dx = plus.map((p, i) => {
    if (p == null || minus[i] == null) return null;
    const s = p + minus[i];
    return s === 0 ? 0 : (100 * Math.abs(p - minus[i])) / s;
  });
  return { plus, minus, adx: rma(dx, n) };
}

/* ---- helpers named by the contract ---------------------------------------- */

/* Heikin-Ashi: smoothed candles. These are NOT traded prices — the chart says
   so — and the readout keeps the real OHLC. Volume and time pass through. */
export function heikinAshi(bars) {
  const out = [];
  let po = null, pc = null;
  for (const b of bars || []) {
    const o = fin(b && b.o), h = fin(b && b.h), l = fin(b && b.l), c = fin(b && b.c);
    if (o == null || h == null || l == null || c == null) { out.push({ ...b }); continue; }
    const hc = (o + h + l + c) / 4;
    const ho = po == null ? (o + c) / 2 : (po + pc) / 2;
    out.push({ t: b.t, o: ho, h: Math.max(h, ho, hc), l: Math.min(l, ho, hc), c: hc, v: b.v == null ? null : b.v });
    po = ho; pc = hc;
  }
  return out;
}

/* Floor pivots from one completed bar (normally the previous session or week).
   Returns {P, R1..R3|R4, S1..S3|S4}; null when the bar is incomplete. */
export function pivots(prev, method = 'classic') {
  const H = fin(prev && prev.h), L = fin(prev && prev.l), C = fin(prev && prev.c);
  if (H == null || L == null || C == null) return null;
  const P = (H + L + C) / 3, R = H - L;
  if (method === 'fibonacci') {
    return { P, R1: P + 0.382 * R, R2: P + 0.618 * R, R3: P + R, S1: P - 0.382 * R, S2: P - 0.618 * R, S3: P - R };
  }
  if (method === 'camarilla') {
    return { P, R1: C + (R * 1.1) / 12, R2: C + (R * 1.1) / 6, R3: C + (R * 1.1) / 4, R4: C + (R * 1.1) / 2,
      S1: C - (R * 1.1) / 12, S2: C - (R * 1.1) / 6, S3: C - (R * 1.1) / 4, S4: C - (R * 1.1) / 2 };
  }
  return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + R, S2: P - R, R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
}

/* Relative strength of A against B: close(A)/close(B), rebased to 1.0 on the
   first timestamp both have. Aligned to barsA; a bar of A with no matching t in
   B (holiday on one exchange) is null rather than borrowed from a neighbour. */
export function relativeStrength(barsA, barsB) {
  const byT = new Map();
  for (const b of barsB || []) { const c = fin(b && b.c); if (c != null && c !== 0) byT.set(b.t, c); }
  let base = null;
  return (barsA || []).map((a) => {
    const ca = fin(a && a.c), cb = byT.get(a && a.t);
    if (ca == null || cb == null) return null;
    const r = ca / cb;
    if (base == null) base = r;
    return base === 0 ? null : r / base;
  });
}

// Simple period returns as fractions, aligned (index 0 is null).
export function returns(values) {
  const v = (values || []).map(fin);
  return v.map((x, i) => (i === 0 || x == null || v[i - 1] == null || v[i - 1] === 0 ? null : x / v[i - 1] - 1));
}

/* Largest peak-to-trough decline, as a NEGATIVE fraction (−0.25 = −25%); 0 for
   a series that never fell, null for one with no data. */
export function maxDrawdown(values) {
  let peak = null, mdd = null;
  for (const raw of values || []) {
    const x = fin(raw);
    if (x == null) continue;
    if (peak == null || x > peak) peak = x;
    const dd = peak > 0 ? x / peak - 1 : 0;
    if (mdd == null || dd < mdd) mdd = dd;
  }
  return mdd;
}

// Aligned drawdown-from-running-peak series (fractions ≤ 0), for an underwater chart.
export function drawdownSeries(values) {
  let peak = null;
  return (values || []).map((raw) => {
    const x = fin(raw);
    if (x == null) return null;
    if (peak == null || x > peak) peak = x;
    return peak > 0 ? x / peak - 1 : 0;
  });
}

/* Median bar spacing in ms; < 1 day means intraday. Used by VWAP (session
   anchoring) and by the chart's time axis. */
export function barSpacing(bars) {
  const d = [];
  for (let i = 1; i < (bars || []).length && d.length < 200; i++) {
    const g = bars[i].t - bars[i - 1].t;
    if (g > 0) d.push(g);
  }
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
const DAY = 86400000;
const utcDay = (t) => Math.floor(t / DAY);

/* ---- the registry ---------------------------------------------------------- */

/* Each entry: {id, label, kind, params, levels?, range?, learn, compute}.
   compute(bars, params) -> {lines:[{key, label, values, style?, shift?}], fill?}
   Extensions over the shared contract (all optional, documented here):
   - line.shift: plot values[i] at bar i+shift (Ichimoku: +26 cloud, −26 lag line).
   - line.breaks: indices where a new segment starts (VWAP session resets).
   - line.step: draw as horizontal steps (pivot levels).
   - result.fill: 'band' (shade between band-upper/lower) or 'cloud' (shade
     green/red by which band is on top).
   - entry.target: 'volume' — prefers to draw on the volume pane when visible.
   - param.options: a fixed list of choices instead of a numeric range. */

const P = (key, label, def, min, max, step = 1) => ({ key, label, def, min, max, step });
const num = (params, key, def) => {
  const v = Number(params && params[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const L = (key, label, values, style, extra) => ({ key, label, values, ...(style ? { style } : {}), ...(extra || {}) });

export const INDICATORS = {
  sma: {
    id: 'sma', label: 'Simple moving average', short: 'SMA', kind: 'overlay', learn: 'sma',
    params: [P('period', 'Period', 20, 2, 400)],
    compute(bars, p) { const n = num(p, 'period', 20); return { lines: [L('sma', 'SMA ' + n, sma(closes(bars), n))] }; },
  },
  ema: {
    id: 'ema', label: 'Exponential moving average', short: 'EMA', kind: 'overlay', learn: 'ema',
    params: [P('period', 'Period', 20, 2, 400)],
    compute(bars, p) { const n = num(p, 'period', 20); return { lines: [L('ema', 'EMA ' + n, ema(closes(bars), n))] }; },
  },
  wma: {
    id: 'wma', label: 'Weighted moving average', short: 'WMA', kind: 'overlay', learn: 'wma',
    params: [P('period', 'Period', 20, 2, 400)],
    compute(bars, p) { const n = num(p, 'period', 20); return { lines: [L('wma', 'WMA ' + n, wma(closes(bars), n))] }; },
  },
  vwap: {
    id: 'vwap', label: 'VWAP (volume-weighted average price)', short: 'VWAP', kind: 'overlay', learn: 'vwap',
    params: [P('bands', 'Band width (σ, 0 = off)', 0, 0, 3, 0.5)],
    compute(bars, p) {
      const k = Number(p && p.bands) || 0;
      const intraday = barSpacing(bars) > 0 && barSpacing(bars) < DAY;
      const len = bars.length, vw = nulls(len), up = nulls(len), lo = nulls(len), tp = typical(bars);
      let day = null, spv = 0, sv = 0, sp2v = 0;
      const breaks = [];
      for (let i = 0; i < len; i++) {
        const d = intraday ? utcDay(bars[i].t) : 0;
        if (d !== day) { if (day != null) breaks.push(i); day = d; spv = 0; sv = 0; sp2v = 0; }
        const v = fin(bars[i].v);
        if (tp[i] == null || v == null) continue;
        spv += tp[i] * v; sv += v; sp2v += tp[i] * tp[i] * v;
        if (sv <= 0) continue;
        vw[i] = spv / sv;
        if (k > 0) { const sd = Math.sqrt(Math.max(0, sp2v / sv - vw[i] * vw[i])); up[i] = vw[i] + k * sd; lo[i] = vw[i] - k * sd; }
      }
      // `breaks`: a new session starts here, so the chart lifts the pen instead
      // of drawing a vertical jump from yesterday's VWAP to today's first print.
      const x = { breaks };
      const lines = [L('vwap', intraday ? 'VWAP' : 'VWAP (anchored)', vw, 'line', x)];
      if (k > 0) lines.push(L('upper', '+' + k + 'σ', up, 'band-upper', x), L('lower', '−' + k + 'σ', lo, 'band-lower', x));
      return { lines, fill: k > 0 ? 'band' : undefined };
    },
  },
  bb: {
    id: 'bb', label: 'Bollinger Bands', short: 'BB', kind: 'overlay', learn: 'bollinger-bands',
    params: [P('period', 'Period', 20, 2, 200), P('mult', 'Std. deviations', 2, 0.5, 5, 0.1)],
    compute(bars, p) {
      const n = num(p, 'period', 20), k = num(p, 'mult', 2), b = bollinger(bars, n, k);
      return { fill: 'band', lines: [L('upper', 'Upper', b.upper, 'band-upper'), L('mid', 'BB ' + n + ' ' + k, b.mid), L('lower', 'Lower', b.lower, 'band-lower')] };
    },
  },
  keltner: {
    id: 'keltner', label: 'Keltner Channels', short: 'KC', kind: 'overlay', learn: 'keltner-channel',
    params: [P('period', 'EMA period', 20, 2, 200), P('atr', 'ATR period', 10, 2, 100), P('mult', 'ATR multiple', 2, 0.5, 5, 0.1)],
    compute(bars, p) {
      const n = num(p, 'period', 20), a = num(p, 'atr', 10), k = num(p, 'mult', 2);
      const mid = ema(closes(bars), n), r = atr(bars, a);
      const upper = mid.map((m, i) => (m == null || r[i] == null ? null : m + k * r[i]));
      const lower = mid.map((m, i) => (m == null || r[i] == null ? null : m - k * r[i]));
      return { fill: 'band', lines: [L('upper', 'Upper', upper, 'band-upper'), L('mid', 'KC ' + n, mid), L('lower', 'Lower', lower, 'band-lower')] };
    },
  },
  donchian: {
    id: 'donchian', label: 'Donchian Channels', short: 'DC', kind: 'overlay', learn: 'donchian-channel',
    params: [P('period', 'Period', 20, 2, 300)],
    compute(bars, p) {
      const n = num(p, 'period', 20), upper = rollMax(highs(bars), n), lower = rollMin(lows(bars), n);
      const mid = upper.map((u, i) => (u == null || lower[i] == null ? null : (u + lower[i]) / 2));
      return { fill: 'band', lines: [L('upper', 'Upper', upper, 'band-upper'), L('mid', 'DC ' + n, mid), L('lower', 'Lower', lower, 'band-lower')] };
    },
  },
  ichimoku: {
    id: 'ichimoku', label: 'Ichimoku Cloud', short: 'Ichimoku', kind: 'overlay', learn: 'ichimoku',
    params: [P('conv', 'Conversion (Tenkan)', 9, 2, 100), P('base', 'Base (Kijun)', 26, 2, 200), P('spanB', 'Span B', 52, 2, 300), P('disp', 'Displacement', 26, 1, 100)],
    compute(bars, p) {
      const c = num(p, 'conv', 9), b = num(p, 'base', 26), s = num(p, 'spanB', 52), d = Math.round(num(p, 'disp', 26));
      const H = highs(bars), Lw = lows(bars);
      const mid = (n) => { const hh = rollMax(H, n), ll = rollMin(Lw, n); return hh.map((x, i) => (x == null || ll[i] == null ? null : (x + ll[i]) / 2)); };
      const tenkan = mid(c), kijun = mid(b), spanB = mid(s);
      const spanA = tenkan.map((x, i) => (x == null || kijun[i] == null ? null : (x + kijun[i]) / 2));
      // spanA/spanB are aligned to the bar they were COMPUTED on; `shift` tells
      // the chart to draw them d bars ahead (the cloud runs past the last bar).
      return {
        fill: 'cloud',
        lines: [
          L('tenkan', 'Conversion', tenkan), L('kijun', 'Base', kijun),
          L('spanA', 'Span A', spanA, 'band-upper', { shift: d - 1 }), L('spanB', 'Span B', spanB, 'band-lower', { shift: d - 1 }),
          L('chikou', 'Lagging', closes(bars), 'line', { shift: -(d - 1) }),
        ],
      };
    },
  },
  psar: {
    id: 'psar', label: 'Parabolic SAR', short: 'PSAR', kind: 'overlay', learn: 'parabolic-sar',
    params: [P('step', 'Step', 0.02, 0.001, 0.2, 0.001), P('max', 'Maximum', 0.2, 0.01, 1, 0.01)],
    compute(bars, p) { return { lines: [L('psar', 'PSAR', psar(bars, num(p, 'step', 0.02), num(p, 'max', 0.2)), 'dots')] }; },
  },
  supertrend: {
    id: 'supertrend', label: 'SuperTrend', short: 'ST', kind: 'overlay', learn: 'supertrend',
    params: [P('period', 'ATR period', 10, 2, 100), P('mult', 'ATR multiple', 3, 0.5, 10, 0.1)],
    compute(bars, p) {
      const st = supertrend(bars, num(p, 'period', 10), num(p, 'mult', 3));
      return { lines: [L('up', 'ST up', st.up, 'line', { tone: 'up' }), L('down', 'ST down', st.down, 'line', { tone: 'down' })] };
    },
  },
  pivots: {
    id: 'pivots', label: 'Pivot points', short: 'Pivots', kind: 'overlay', learn: 'pivot-points',
    params: [{ key: 'method', label: 'Method', def: 'classic', options: ['classic', 'fibonacci', 'camarilla'] }],
    compute(bars, p) { return { lines: pivotLines(bars, (p && p.method) || 'classic') }; },
  },
  rsi: {
    id: 'rsi', label: 'Relative Strength Index', short: 'RSI', kind: 'pane', learn: 'rsi', levels: [30, 70], range: [0, 100],
    params: [P('period', 'Period', 14, 2, 100)],
    compute(bars, p) { const n = num(p, 'period', 14); return { lines: [L('rsi', 'RSI ' + n, rsiOf(closes(bars), n))] }; },
  },
  macd: {
    id: 'macd', label: 'MACD', short: 'MACD', kind: 'pane', learn: 'macd', levels: [0],
    params: [P('fast', 'Fast', 12, 2, 100), P('slow', 'Slow', 26, 2, 200), P('signal', 'Signal', 9, 2, 100)],
    compute(bars, p) {
      const m = macdOf(closes(bars), num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9));
      return { lines: [L('hist', 'Histogram', m.hist, 'histogram'), L('macd', 'MACD', m.macd), L('signal', 'Signal', m.signal)] };
    },
  },
  stoch: {
    id: 'stoch', label: 'Stochastic oscillator', short: 'Stoch', kind: 'pane', learn: 'stochastic', levels: [20, 80], range: [0, 100],
    params: [P('k', '%K period', 14, 2, 100), P('smooth', '%K smoothing', 3, 1, 20), P('d', '%D period', 3, 1, 20)],
    compute(bars, p) {
      const s = stochastic(bars, num(p, 'k', 14), num(p, 'smooth', 3), num(p, 'd', 3));
      return { lines: [L('k', '%K', s.k), L('d', '%D', s.d)] };
    },
  },
  stochrsi: {
    id: 'stochrsi', label: 'Stochastic RSI', short: 'StochRSI', kind: 'pane', learn: 'stoch-rsi', levels: [20, 80], range: [0, 100],
    params: [P('rsi', 'RSI period', 14, 2, 100), P('stoch', 'Stoch period', 14, 2, 100), P('k', '%K smoothing', 3, 1, 20), P('d', '%D period', 3, 1, 20)],
    compute(bars, p) {
      const r = rsiOf(closes(bars), num(p, 'rsi', 14)), n = num(p, 'stoch', 14);
      const hh = rollMax(r, n), ll = rollMin(r, n);
      const raw = r.map((x, i) => (x == null || hh[i] == null ? null : hh[i] === ll[i] ? 50 : (100 * (x - ll[i])) / (hh[i] - ll[i])));
      const k = sma(raw, num(p, 'k', 3));
      return { lines: [L('k', '%K', k), L('d', '%D', sma(k, num(p, 'd', 3)))] };
    },
  },
  atr: {
    id: 'atr', label: 'Average True Range', short: 'ATR', kind: 'pane', learn: 'atr',
    params: [P('period', 'Period', 14, 2, 100)],
    compute(bars, p) { const n = num(p, 'period', 14); return { lines: [L('atr', 'ATR ' + n, atr(bars, n))] }; },
  },
  adx: {
    id: 'adx', label: 'ADX / DMI', short: 'ADX', kind: 'pane', learn: 'adx', levels: [25], range: [0, 100],
    params: [P('period', 'Period', 14, 2, 100)],
    compute(bars, p) {
      const d = dmi(bars, num(p, 'period', 14));
      return { lines: [L('adx', 'ADX', d.adx), L('plus', '+DI', d.plus, 'line', { tone: 'up' }), L('minus', '−DI', d.minus, 'line', { tone: 'down' })] };
    },
  },
  obv: {
    id: 'obv', label: 'On-Balance Volume', short: 'OBV', kind: 'pane', learn: 'obv', params: [],
    compute(bars) { return { lines: [L('obv', 'OBV', obv(bars))] }; },
  },
  mfi: {
    id: 'mfi', label: 'Money Flow Index', short: 'MFI', kind: 'pane', learn: 'mfi', levels: [20, 80], range: [0, 100],
    params: [P('period', 'Period', 14, 2, 100)],
    compute(bars, p) { const n = num(p, 'period', 14); return { lines: [L('mfi', 'MFI ' + n, mfi(bars, n))] }; },
  },
  cci: {
    id: 'cci', label: 'Commodity Channel Index', short: 'CCI', kind: 'pane', learn: 'cci', levels: [-100, 100],
    params: [P('period', 'Period', 20, 2, 100)],
    compute(bars, p) { const n = num(p, 'period', 20); return { lines: [L('cci', 'CCI ' + n, cci(bars, n))] }; },
  },
  willr: {
    id: 'willr', label: 'Williams %R', short: '%R', kind: 'pane', learn: 'williams-r', levels: [-80, -20], range: [-100, 0],
    params: [P('period', 'Period', 14, 2, 100)],
    compute(bars, p) {
      const n = num(p, 'period', 14), hh = rollMax(highs(bars), n), ll = rollMin(lows(bars), n), c = closes(bars);
      return { lines: [L('willr', '%R ' + n, c.map((x, i) => (x == null || hh[i] == null ? null : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - x)) / (hh[i] - ll[i]))))] };
    },
  },
  roc: {
    id: 'roc', label: 'Rate of Change', short: 'ROC', kind: 'pane', learn: 'roc', levels: [0],
    params: [P('period', 'Period', 12, 1, 200)],
    compute(bars, p) {
      const n = num(p, 'period', 12), c = closes(bars);
      return { lines: [L('roc', 'ROC ' + n, c.map((x, i) => (i < n || x == null || c[i - n] == null || c[i - n] === 0 ? null : 100 * (x / c[i - n] - 1))))] };
    },
  },
  cmf: {
    id: 'cmf', label: 'Chaikin Money Flow', short: 'CMF', kind: 'pane', learn: 'cmf', levels: [0],
    params: [P('period', 'Period', 20, 2, 100)],
    compute(bars, p) { const n = num(p, 'period', 20); return { lines: [L('cmf', 'CMF ' + n, cmf(bars, n), 'histogram')] }; },
  },
  volma: {
    id: 'volma', label: 'Volume moving average', short: 'Vol MA', kind: 'pane', target: 'volume', learn: 'volume',
    params: [P('period', 'Period', 20, 2, 200)],
    compute(bars, p) {
      const n = num(p, 'period', 20), v = vols(bars);
      return { lines: [L('vol', 'Volume', v, 'histogram'), L('volma', 'Vol MA ' + n, sma(v, n))] };
    },
  },
};

/* ---- implementations too long for the table -------------------------------- */

export function obv(bars) {
  const out = nulls(bars.length);
  let acc = 0, started = false;
  for (let i = 0; i < bars.length; i++) {
    const v = fin(bars[i].v), c = fin(bars[i].c);
    if (v == null || c == null) continue;
    if (!started) { started = true; out[i] = 0; continue; }
    const pc = fin(bars[i - 1] && bars[i - 1].c);
    if (pc != null) acc += c > pc ? v : c < pc ? -v : 0;
    out[i] = acc;
  }
  return out;
}

export function mfi(bars, n = 14) {
  const tp = typical(bars), len = bars.length, out = nulls(len);
  const pos = nulls(len), neg = nulls(len);
  for (let i = 1; i < len; i++) {
    const v = fin(bars[i].v);
    if (tp[i] == null || tp[i - 1] == null || v == null) continue;
    const flow = tp[i] * v;
    pos[i] = tp[i] > tp[i - 1] ? flow : 0;
    neg[i] = tp[i] < tp[i - 1] ? flow : 0;
  }
  const sp = sma(pos, n), sn = sma(neg, n);
  for (let i = 0; i < len; i++) {
    if (sp[i] == null || sn[i] == null) continue;
    out[i] = sn[i] === 0 ? (sp[i] === 0 ? 50 : 100) : 100 - 100 / (1 + sp[i] / sn[i]);
  }
  return out;
}

export function cci(bars, n = 20) {
  const tp = typical(bars), m = sma(tp, n), out = nulls(bars.length);
  for (let i = n - 1; i < bars.length; i++) {
    if (m[i] == null) continue;
    let md = 0;
    for (let k = i - n + 1; k <= i; k++) md += Math.abs(tp[k] - m[i]);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

export function cmf(bars, n = 20) {
  const mfv = bars.map((b) => {
    const h = fin(b.h), l = fin(b.l), c = fin(b.c), v = fin(b.v);
    if (h == null || l == null || c == null || v == null) return null;
    return h === l ? 0 : (((c - l) - (h - c)) / (h - l)) * v;
  });
  const a = sma(mfv, n), b = sma(vols(bars), n);
  return a.map((x, i) => (x == null || b[i] == null || b[i] === 0 ? null : x / b[i]));
}

/* Parabolic SAR (Wilder). Starts long if the second close is higher. The SAR is
   never placed inside the previous two bars' range — the rule people forget. */
export function psar(bars, step = 0.02, max = 0.2) {
  const len = bars.length, out = nulls(len);
  if (len < 2) return out;
  let long = fin(bars[1].c) >= fin(bars[0].c);
  let sar = long ? fin(bars[0].l) : fin(bars[0].h);
  let ep = long ? fin(bars[0].h) : fin(bars[0].l);
  let af = step;
  if (sar == null || ep == null) return out;
  for (let i = 1; i < len; i++) {
    const h = fin(bars[i].h), l = fin(bars[i].l);
    if (h == null || l == null) continue;
    sar = sar + af * (ep - sar);
    const p1 = bars[i - 1], p2 = i > 1 ? bars[i - 2] : p1;
    if (long) {
      sar = Math.min(sar, p1.l, p2.l);
      if (l < sar) { long = false; sar = ep; ep = l; af = step; }
      else if (h > ep) { ep = h; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, p1.h, p2.h);
      if (h > sar) { long = true; sar = ep; ep = h; af = step; }
      else if (l < ep) { ep = l; af = Math.min(max, af + step); }
    }
    out[i] = sar;
  }
  return out;
}

/* SuperTrend: a trailing band at median ± mult·ATR that only ratchets in the
   trend's direction. Returns separate `up` (below price) and `down` lines so a
   chart can colour them without guessing; `trend` is +1/−1. */
export function supertrend(bars, n = 10, mult = 3) {
  const len = bars.length, a = atr(bars, n);
  const up = nulls(len), down = nulls(len), trend = nulls(len);
  let fu = null, fl = null, dir = 1;
  for (let i = 0; i < len; i++) {
    const h = fin(bars[i].h), l = fin(bars[i].l), c = fin(bars[i].c);
    if (a[i] == null || h == null || l == null || c == null) continue;
    const mid = (h + l) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i];
    const pc = i > 0 ? fin(bars[i - 1].c) : null;
    const nfu = fu == null || bu < fu || (pc != null && pc > fu) ? bu : fu;
    const nfl = fl == null || bl > fl || (pc != null && pc < fl) ? bl : fl;
    if (fu != null) {
      if (dir === 1 && c < nfl) dir = -1;
      else if (dir === -1 && c > nfu) dir = 1;
    } else dir = c >= mid ? 1 : -1;
    fu = nfu; fl = nfl;
    trend[i] = dir;
    if (dir === 1) up[i] = fl; else down[i] = fu;
  }
  return { up, down, trend };
}

/* Pivot lines across a series. The pivot period is one step up from the bars:
   intraday bars use the previous UTC day's H/L/C, daily bars the previous week
   (Monday-anchored), weekly bars the previous month, monthly bars the previous
   year. Each level is a step line, null on the first period (nothing before it
   to read). */
function pivotLines(bars, method) {
  const len = bars.length;
  if (!len) return [];
  const sp = barSpacing(bars) || DAY;
  const keyOf = sp < DAY * 0.9 ? (t) => utcDay(t)
    : sp < 5 * DAY ? (t) => Math.floor((utcDay(t) + 3) / 7)                 // epoch day 0 was a Thursday
      : sp < 25 * DAY ? (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
        : (t) => new Date(t).getUTCFullYear();
  const periods = [];
  for (let i = 0; i < len; i++) {
    const k = keyOf(bars[i].t), b = bars[i];
    let cur = periods[periods.length - 1];
    if (!cur || cur.k !== k) { cur = { k, h: -Infinity, l: Infinity, c: null, from: i }; periods.push(cur); }
    if (fin(b.h) != null) cur.h = Math.max(cur.h, b.h);
    if (fin(b.l) != null) cur.l = Math.min(cur.l, b.l);
    if (fin(b.c) != null) cur.c = b.c;
  }
  const names = method === 'camarilla' ? ['R4', 'R3', 'R2', 'R1', 'S1', 'S2', 'S3', 'S4'] : ['R3', 'R2', 'R1', 'P', 'S1', 'S2', 'S3'];
  const lines = names.map((n) => L(n, n, nulls(len), 'line', { step: true }));
  for (let p = 1; p < periods.length; p++) {
    const prev = periods[p - 1];
    const lv = pivots({ h: prev.h, l: prev.l, c: prev.c }, method);
    if (!lv) continue;
    const end = p + 1 < periods.length ? periods[p + 1].from : len;
    for (const line of lines) for (let i = periods[p].from; i < end; i++) line.values[i] = lv[line.key];
  }
  return lines;
}

/* Compute one indicator by id. Unknown ids answer null rather than throw, so a
   stale saved chart layout naming a removed indicator still renders. */
export function computeIndicator(id, bars, params) {
  const def = INDICATORS[id];
  if (!def || !Array.isArray(bars)) return null;
  const merged = {};
  for (const p of def.params) merged[p.key] = p.def;
  Object.assign(merged, params || {});
  try { return def.compute(bars, merged); } catch (e) { return null; }
}

// Default params for an id: {key: def}.
export function defaultParams(id) {
  const def = INDICATORS[id], out = {};
  if (def) for (const p of def.params) out[p.key] = p.def;
  return out;
}
