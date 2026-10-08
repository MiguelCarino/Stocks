/* alerttypes.js — the registry of alert conditions.

   Every condition a rule can watch is one entry here: what it measures, which
   comparisons make sense for it, what it needs to be measured at all, and how to
   say it back in a sentence. engine.js owns WHEN a rule fires (session gate,
   confirmation, latch, cooldown, once/rearm, expiry); this file owns only WHAT
   the number is. Keeping the two apart is what lets a new condition be one
   object instead of another branch in the evaluation loop.

   The contract every metric honours: return a finite number, or null when an
   input is missing. Null is "cannot tell", never zero — the old engine read a
   missing changePct as 0% and fired 'below 1%' rules on fresh listings that had
   no change data at all.

   The indicator math is restated here, small and deliberately duplicated rather
   than imported from indicators.js. The alert path runs on every leader tick, in
   every window that leads, and must not break because a charting module changed
   shape; the handful of formulas it needs are the standard textbook ones and are
   pinned by tests/alerts.test.mjs.

   Pure: no DOM, no storage, no imports. The one ambient read is the optional
   window.CarinoI18n, guarded so this file runs under node --test. */

const i18nT = (s) => (typeof window !== 'undefined' && window.CarinoI18n ? window.CarinoI18n.t(s) : s);

// The symbol a portfolio-level rule carries. '@' cannot appear in a normalized
// ticker, so it can never collide with a real instrument.
export const PORTFOLIO_SYMBOL = '@PORTFOLIO';

export const ALERT_OPS = ['above', 'below', 'crossAbove', 'crossBelow'];
const LEVEL_OPS = ALERT_OPS;
const BAND_OPS = ['above', 'below'];

// English is the i18n key; the engine and the UI both print these.
export const OP_LABEL = {
  above: 'at or above', below: 'at or below',
  crossAbove: 'crosses above', crossBelow: 'crosses below',
};

export function isCrossOp(op) { return op === 'crossAbove' || op === 'crossBelow'; }

/* ---- small math -------------------------------------------------------------
   All of it null-safe and oldest-first, like the bars it reads. */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function smaAt(values, n, end = values.length) {
  if (!(n >= 1) || end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) { if (!fin(values[i])) return null; s += values[i]; }
  return s / n;
}

// EMA seeded with the SMA of the first n values, aligned to the input with null
// during warm-up. Leading nulls (an EMA of a MACD line) are skipped, not zeroed.
export function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let start = 0;
  while (start < values.length && !fin(values[start])) start++;
  if (!(n >= 1) || values.length - start < n) return out;
  let e = 0;
  for (let i = start; i < start + n; i++) { if (!fin(values[i])) return out; e += values[i]; }
  e /= n;
  out[start + n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = start + n; i < values.length; i++) {
    if (!fin(values[i])) return out;   // a hole ends the series rather than bridging it
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Wilder RSI: averages seeded with the simple mean of the first n changes, then
// smoothed avg = (prev·(n−1) + cur) / n. 100 when there were no losses at all.
export function rsiLast(closes, n = 14) {
  if (!(n >= 1) || closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (!fin(d)) return null;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (!fin(d)) return null;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// MACD line, signal and histogram at the last index.
export function macdLast(closes, fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const sig = emaSeries(line, signal);
  const i = closes.length - 1;
  if (i < 0 || line[i] == null || sig[i] == null) return null;
  return { macd: line[i], signal: sig[i], hist: line[i] - sig[i] };
}

// Bollinger: SMA ± k·σ with the population standard deviation, as Bollinger
// specified it.
export function bbLast(closes, n = 20, k = 2) {
  const mid = smaAt(closes, n);
  if (mid == null) return null;
  let v = 0;
  for (let i = closes.length - n; i < closes.length; i++) v += (closes[i] - mid) ** 2;
  const sd = Math.sqrt(v / n);
  return { mid, upper: mid + k * sd, lower: mid - k * sd };
}

// Wilder ATR: true range smoothed with an RMA seeded by the simple mean.
export function atrLast(bars, n = 14) {
  if (!(n >= 1) || bars.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    if (!fin(b.h) || !fin(b.l) || !fin(pc)) return null;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/* ---- live series ------------------------------------------------------------
   Rules read DAILY bars, and the provider's last bar may be today's (still
   forming) or yesterday's (today not yet published). Getting that wrong either
   counts the same close twice or drops today entirely, so the quote's own
   prevClose is the arbiter: if it matches the last bar's close, the last bar is
   yesterday and the live print becomes a new bar; if it matches the bar before,
   the last bar is today and the live print replaces its close. Only when the
   quote carries no prevClose does the clock decide (bar t is the bar's open). */

const DAY_MS = 86400000;
const near = (a, b) => fin(a) && fin(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

function cleanBars(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.filter((b) => b && fin(b.c) && fin(b.t));
}

export function liveSeries(rawBars, quote, now = Date.now()) {
  const bars = cleanBars(rawBars);
  const price = quote && fin(quote.price) ? quote.price : null;
  const n = bars.length;
  if (!n) return null;
  const last = bars[n - 1];
  let todayIsLast;
  const pc = quote && fin(quote.prevClose) ? quote.prevClose : null;
  if (pc != null && near(pc, last.c)) todayIsLast = false;
  else if (pc != null && n >= 2 && near(pc, bars[n - 2].c)) todayIsLast = true;
  else todayIsLast = now - last.t < DAY_MS;

  const prior = todayIsLast ? bars.slice(0, -1) : bars.slice();
  let eff = bars.slice();
  if (price != null) {
    const hi = quote && fin(quote.high) ? Math.max(quote.high, price) : price;
    const lo = quote && fin(quote.low) ? Math.min(quote.low, price) : price;
    const vol = quote && fin(quote.volume) ? quote.volume : null;
    if (todayIsLast) {
      eff[n - 1] = {
        ...last, c: price,
        h: fin(last.h) ? Math.max(last.h, hi) : hi,
        l: fin(last.l) ? Math.min(last.l, lo) : lo,
        v: vol != null ? Math.max(vol, fin(last.v) ? last.v : 0) : last.v,
      };
    } else {
      eff.push({ t: now, o: quote && fin(quote.open) ? quote.open : price, h: hi, l: lo, c: price, v: vol });
    }
  }
  return { bars: eff, prior, closes: eff.map((b) => b.c), price: price != null ? price : eff[eff.length - 1].c };
}

/* ---- 52-week range -----------------------------------------------------------
   From bars when they plausibly cover a year, otherwise from fundamentals, and
   otherwise not at all: the high of the last thirty bars a provider happened to
   return is not a 52-week high, and calling it one would fire 'new 52-week high'
   on any ordinary monthly high. `prior` excludes today, so a new high can be
   detected against the range it is breaking. */

const YEAR_BARS = 252;

function priorRange(series, fundamentals) {
  const p = series ? series.prior : [];
  const span = p.length ? p[p.length - 1].t - p[0].t : 0;
  if (p.length >= 240 || span >= 340 * DAY_MS) {
    const win = p.slice(-YEAR_BARS);
    let hi = -Infinity, lo = Infinity;
    for (const b of win) {
      const h = fin(b.h) ? b.h : b.c, l = fin(b.l) ? b.l : b.c;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    if (Number.isFinite(hi) && Number.isFinite(lo)) return { high: hi, low: lo };
  }
  const f = fundamentals;
  if (f && fin(f.high52) && fin(f.low52)) return { high: f.high52, low: f.low52 };
  return null;
}

function avgVolume(series, fundamentals, n) {
  if (series) {
    const vols = series.prior.map((b) => b.v);
    const a = smaAt(vols, n);
    if (a != null && a > 0) return a;
  }
  const f = fundamentals;
  if (f && fin(f.avgVolume10d) && f.avgVolume10d > 0) return f.avgVolume10d;
  if (f && fin(f.avgVolume3m) && f.avgVolume3m > 0) return f.avgVolume3m;
  return null;
}

/* ---- formatting --------------------------------------------------------------
   Kept local and dependency-free; engine.js formats the live "now" value with
   format.js. Thresholds the user typed are echoed at the precision they imply. */

function num(v, dp) {
  if (!fin(v)) return '—';
  try { return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  catch (e) { return v.toFixed(dp); }
}
function priceDp(v) { const a = Math.abs(v); return a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8; }
const SIGN = (v) => (v >= 0 ? '+' : '−');
export const FORMATTERS = {
  // Trailing zeros past the cents go: a $96.44 threshold reads 96.44, not
  // 96.4400, while an FX rate or a coin keeps the places it actually uses.
  price: (v) => num(v, priceDp(v || 0)).replace(/(\.\d\d\d*?)0+$/, '$1'),
  pct: (v) => (fin(v) ? SIGN(v) + num(Math.abs(v), 2) + '%' : '—'),
  pctAbs: (v) => (fin(v) ? num(v, 2) + '%' : '—'),
  x: (v) => (fin(v) ? num(v, 2) + '×' : '—'),
  value: (v) => num(v, 2),
  rsi: (v) => num(v, 1),
  volume: (v) => {
    if (!fin(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    return num(v, 0);
  },
};

function fill(tpl, vars) {
  return i18nT(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}
function symOf(rule) { return rule.symbol === PORTFOLIO_SYMBOL ? i18nT('Portfolio') : rule.symbol; }

// Generic sentence: "AAPL price crosses above 190.00".
function sentence(what, fmtKey) {
  return (rule) => fill('{sym} {what} {op} {value}', {
    sym: symOf(rule), what: i18nT(what), op: i18nT(OP_LABEL[rule.op] || rule.op),
    value: FORMATTERS[fmtKey](Number(rule.value)),
  });
}

/* ---- the registry --------------------------------------------------------------
   Beyond the shared contract each entry may carry:
     defValue   — the threshold a new rule starts from;
     fixedValue — the threshold is implied by the condition (a new 52-week high is
                  "above the old one"), so the UI hides the value field and the
                  engine ignores rule.value;
     fmt        — which FORMATTERS key prints this metric;
     fundamentals — the metric can use ctx.fundamentals when bars are short. */

function p(key, label, def, min, max) { return { key, label, def, min, max }; }

const DEF = [
  /* Price */
  {
    id: 'price', label: 'Price', group: 'Price', needs: 'quote', ops: LEVEL_OPS, params: [],
    unit: 'price', fmt: 'price', level: 'beginner', learn: 'price-alert', defValue: null,
    metric: ({ quote }) => (quote && fin(quote.price) ? quote.price : null),
    describe: sentence('price', 'price'),
  },
  {
    id: 'trailStop', label: 'Trailing drop from peak', group: 'Price', needs: 'quote', ops: ['above'], params: [],
    unit: 'pct', fmt: 'pctAbs', level: 'standard', learn: 'trailing-stop', defValue: 8,
    // The peak is the highest price seen since the rule was armed. It lives on the
    // rule (runtime, underscore-prefixed, never exported) so it survives a reload
    // but not a re-arm or an import.
    metric: ({ quote, rule, touch }) => {
      if (!quote || !fin(quote.price) || quote.price <= 0) return null;
      const peak = fin(rule._peak) ? rule._peak : null;
      if (peak == null || quote.price > peak) { rule._peak = quote.price; touch(); }
      return (rule._peak - quote.price) / rule._peak * 100;
    },
    describe: (rule) => fill('{sym} falls {value} from its peak since armed', {
      sym: symOf(rule), value: FORMATTERS.pctAbs(Number(rule.value)),
    }),
  },

  /* Change */
  {
    id: 'pct', label: 'Day change %', group: 'Change', needs: 'quote', ops: LEVEL_OPS, params: [],
    unit: 'pct', fmt: 'pct', level: 'beginner', learn: 'percent-change', defValue: 5,
    metric: ({ quote }) => (quote && fin(quote.changePct) ? quote.changePct : null),
    describe: sentence('day change', 'pct'),
  },
  {
    id: 'pctFromOpen', label: 'Change from open %', group: 'Change', needs: 'quote', ops: LEVEL_OPS, params: [],
    unit: 'pct', fmt: 'pct', level: 'standard', learn: 'open-price', defValue: 3,
    metric: ({ quote }) => (quote && fin(quote.price) && fin(quote.open) && quote.open
      ? (quote.price - quote.open) / quote.open * 100 : null),
    describe: sentence('change since the open', 'pct'),
  },
  {
    id: 'gap', label: 'Opening gap %', group: 'Change', needs: 'quote', ops: BAND_OPS, params: [],
    unit: 'pct', fmt: 'pct', level: 'standard', learn: 'gap', defValue: 2,
    metric: ({ quote }) => (quote && fin(quote.open) && fin(quote.prevClose) && quote.prevClose
      ? (quote.open - quote.prevClose) / quote.prevClose * 100 : null),
    describe: sentence('opening gap', 'pct'),
  },

  /* Volume */
  {
    id: 'volume', label: 'Volume', group: 'Volume', needs: 'quote', ops: BAND_OPS, params: [],
    unit: 'value', fmt: 'volume', level: 'standard', learn: 'volume', defValue: 1000000,
    metric: ({ quote }) => (quote && fin(quote.volume) ? quote.volume : null),
    describe: sentence('volume today', 'volume'),
  },
  {
    // Raw ratio of today's volume so far to the average day. Not adjusted for
    // time of day: at 10:00 a normal day reads well below 1×, which is why the
    // default threshold is 2×.
    id: 'relVolume', label: 'Relative volume', group: 'Volume', needs: 'bars', ops: BAND_OPS,
    params: [p('period', 'Average over (days)', 20, 2, 200)],
    unit: 'x', fmt: 'x', level: 'standard', learn: 'relative-volume', defValue: 2, fundamentals: true,
    metric: ({ quote, series, fundamentals, params }) => {
      if (!quote || !fin(quote.volume)) return null;
      const avg = avgVolume(series, fundamentals, params.period);
      return avg ? quote.volume / avg : null;
    },
    describe: sentence('volume vs average', 'x'),
  },

  /* Range */
  {
    id: 'high52Prox', label: '% below 52-week high', group: 'Range', needs: 'bars', ops: BAND_OPS, params: [],
    unit: 'pct', fmt: 'pctAbs', level: 'standard', learn: '52-week-high', defValue: 5, fundamentals: true,
    metric: ({ series, quote, fundamentals }) => {
      const r = priorRange(series, fundamentals);
      const px = quote && fin(quote.price) ? quote.price : null;
      if (!r || px == null || !(r.high > 0)) return null;
      const hi = Math.max(r.high, px);
      return (hi - px) / hi * 100;
    },
    describe: (rule) => fill(rule.op === 'below' ? '{sym} within {value} of its 52-week high' : '{sym} more than {value} below its 52-week high', {
      sym: symOf(rule), value: FORMATTERS.pctAbs(Number(rule.value)),
    }),
  },
  {
    id: 'low52Prox', label: '% above 52-week low', group: 'Range', needs: 'bars', ops: BAND_OPS, params: [],
    unit: 'pct', fmt: 'pctAbs', level: 'standard', learn: '52-week-low', defValue: 5, fundamentals: true,
    metric: ({ series, quote, fundamentals }) => {
      const r = priorRange(series, fundamentals);
      const px = quote && fin(quote.price) ? quote.price : null;
      if (!r || px == null || !(r.low > 0)) return null;
      const lo = Math.min(r.low, px);
      return (px - lo) / lo * 100;
    },
    describe: (rule) => fill(rule.op === 'below' ? '{sym} within {value} of its 52-week low' : '{sym} more than {value} above its 52-week low', {
      sym: symOf(rule), value: FORMATTERS.pctAbs(Number(rule.value)),
    }),
  },
  {
    // Percent beyond the PRIOR 52-week high (today excluded). ≥ 0 means today's
    // price has reached or broken it.
    id: 'newHigh52', label: 'New 52-week high', group: 'Range', needs: 'bars', ops: ['above'], params: [],
    unit: 'pct', fmt: 'pct', level: 'beginner', learn: '52-week-high', defValue: 0, fixedValue: 0, fundamentals: true,
    metric: ({ series, quote, fundamentals }) => {
      const r = priorRange(series, fundamentals);
      const px = quote && fin(quote.price) ? quote.price : null;
      return r && px != null && r.high > 0 ? (px / r.high - 1) * 100 : null;
    },
    describe: (rule) => fill('{sym} reaches a new 52-week high', { sym: symOf(rule) }),
  },
  {
    id: 'newLow52', label: 'New 52-week low', group: 'Range', needs: 'bars', ops: ['above'], params: [],
    unit: 'pct', fmt: 'pct', level: 'beginner', learn: '52-week-low', defValue: 0, fixedValue: 0, fundamentals: true,
    metric: ({ series, quote, fundamentals }) => {
      const r = priorRange(series, fundamentals);
      const px = quote && fin(quote.price) ? quote.price : null;
      return r && px != null && r.low > 0 ? (1 - px / r.low) * 100 : null;
    },
    describe: (rule) => fill('{sym} reaches a new 52-week low', { sym: symOf(rule) }),
  },

  /* Technical — all on daily bars with today's live print as the last close. */
  {
    // Percent distance of price from its SMA; 0 is the average itself, so
    // 'crosses above 0' is the classic "price crossed above its 50-day".
    id: 'smaCross', label: 'Price vs simple moving average', group: 'Technical', needs: 'bars', ops: LEVEL_OPS,
    params: [p('period', 'Period (days)', 50, 2, 400)],
    unit: 'pct', fmt: 'pct', level: 'standard', learn: 'sma', defValue: 0,
    metric: ({ series, params }) => {
      if (!series) return null;
      const ma = smaAt(series.closes, params.period);
      return ma ? (series.price / ma - 1) * 100 : null;
    },
    describe: (rule) => maSentence(rule, 'SMA'),
  },
  {
    id: 'emaCross', label: 'Price vs exponential moving average', group: 'Technical', needs: 'bars', ops: LEVEL_OPS,
    params: [p('period', 'Period (days)', 21, 2, 400)],
    unit: 'pct', fmt: 'pct', level: 'standard', learn: 'ema', defValue: 0,
    metric: ({ series, params }) => {
      if (!series) return null;
      const e = emaSeries(series.closes, params.period);
      const ma = e[e.length - 1];
      return ma ? (series.price / ma - 1) * 100 : null;
    },
    describe: (rule) => maSentence(rule, 'EMA'),
  },
  {
    // Fast SMA vs slow SMA as a percent spread; crossing 0 upward is what is
    // commonly called a golden cross, downward a death cross. Named neutrally in
    // the text: this is a description of two averages, not a signal.
    id: 'maCross', label: 'Moving-average crossover', group: 'Technical', needs: 'bars', ops: LEVEL_OPS,
    params: [p('fast', 'Fast period', 50, 2, 400), p('slow', 'Slow period', 200, 3, 400)],
    unit: 'pct', fmt: 'pct', level: 'pro', learn: 'golden-cross', defValue: 0,
    metric: ({ series, params }) => {
      if (!series || params.fast >= params.slow) return null;
      const f = smaAt(series.closes, params.fast), s = smaAt(series.closes, params.slow);
      return f != null && s ? (f / s - 1) * 100 : null;
    },
    describe: (rule) => {
      const pr = paramsFor(rule);
      const v = Number(rule.value);
      if (isCrossOp(rule.op) && v === 0) {
        return fill(rule.op === 'crossAbove' ? '{sym} SMA{fast} crosses above SMA{slow}' : '{sym} SMA{fast} crosses below SMA{slow}',
          { sym: symOf(rule), fast: pr.fast, slow: pr.slow });
      }
      return fill('{sym} SMA{fast} vs SMA{slow} spread {op} {value}', {
        sym: symOf(rule), fast: pr.fast, slow: pr.slow, op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.pct(v),
      });
    },
  },
  {
    id: 'rsi', label: 'RSI', group: 'Technical', needs: 'bars', ops: LEVEL_OPS,
    params: [p('period', 'Period (days)', 14, 2, 100)],
    unit: 'value', fmt: 'rsi', level: 'standard', learn: 'rsi', defValue: 70,
    metric: ({ series, params }) => (series ? rsiLast(series.closes, params.period) : null),
    describe: (rule) => fill('{sym} RSI({n}) {op} {value}', {
      sym: symOf(rule), n: paramsFor(rule).period, op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.rsi(Number(rule.value)),
    }),
  },
  {
    // MACD histogram (line − signal). Crossing 0 is the line crossing its signal.
    id: 'macdCross', label: 'MACD vs signal', group: 'Technical', needs: 'bars', ops: LEVEL_OPS,
    params: [p('fast', 'Fast EMA', 12, 2, 100), p('slow', 'Slow EMA', 26, 3, 200), p('signal', 'Signal EMA', 9, 2, 100)],
    unit: 'value', fmt: 'price', level: 'pro', learn: 'macd', defValue: 0,
    metric: ({ series, params }) => {
      if (!series || params.fast >= params.slow) return null;
      const m = macdLast(series.closes, params.fast, params.slow, params.signal);
      return m ? m.hist : null;
    },
    describe: (rule) => {
      const v = Number(rule.value);
      if (isCrossOp(rule.op) && v === 0) {
        return fill(rule.op === 'crossAbove' ? '{sym} MACD crosses above its signal line' : '{sym} MACD crosses below its signal line', { sym: symOf(rule) });
      }
      return fill('{sym} MACD histogram {op} {value}', { sym: symOf(rule), op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.price(v) });
    },
  },
  {
    // %B × 100: 100 is the upper band, 0 the lower. 'above 100' = price outside
    // the upper band, 'below 0' = outside the lower one.
    id: 'bbBreak', label: 'Bollinger Band break', group: 'Technical', needs: 'bars', ops: BAND_OPS,
    params: [p('period', 'Period (days)', 20, 2, 200), p('mult', 'Width (σ)', 2, 0.5, 5)],
    unit: 'value', fmt: 'value', level: 'pro', learn: 'bollinger-bands', defValue: 100,
    metric: ({ series, params }) => {
      if (!series) return null;
      const b = bbLast(series.closes, params.period, params.mult);
      if (!b || b.upper === b.lower) return null;
      return (series.price - b.lower) / (b.upper - b.lower) * 100;
    },
    describe: (rule) => {
      const v = Number(rule.value);
      if (rule.op === 'above' && v === 100) return fill('{sym} moves above the upper Bollinger Band', { sym: symOf(rule) });
      if (rule.op === 'below' && v === 0) return fill('{sym} moves below the lower Bollinger Band', { sym: symOf(rule) });
      return fill('{sym} Bollinger %B {op} {value}', { sym: symOf(rule), op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.value(v) });
    },
  },
  {
    // Today's move from the previous close in multiples of ATR measured on
    // completed days — "an unusually large day for this instrument".
    id: 'atrMove', label: 'Move vs average true range', group: 'Technical', needs: 'bars', ops: ['above'],
    params: [p('period', 'ATR period (days)', 14, 2, 100)],
    unit: 'x', fmt: 'x', level: 'pro', learn: 'atr', defValue: 1.5,
    metric: ({ series, quote, params }) => {
      if (!series || !quote || !fin(quote.price)) return null;
      const atr = atrLast(series.prior, params.period);
      const pc = fin(quote.prevClose) ? quote.prevClose : (series.prior.length ? series.prior[series.prior.length - 1].c : null);
      return atr && fin(pc) ? Math.abs(quote.price - pc) / atr : null;
    },
    describe: (rule) => fill('{sym} moves more than {value} ATR from the previous close', {
      sym: symOf(rule), value: FORMATTERS.x(Number(rule.value)),
    }),
  },

  /* Portfolio — rule.symbol is PORTFOLIO_SYMBOL; ctx.portfolio is the totals
     object portfolio.js builds (netWorth, marketValue, dayPL). */
  {
    id: 'portfolioValue', label: 'Portfolio value', group: 'Portfolio', needs: 'portfolio', ops: LEVEL_OPS, params: [],
    unit: 'value', fmt: 'value', level: 'standard', learn: 'net-worth', defValue: null,
    metric: ({ portfolio }) => {
      if (!portfolio) return null;
      if (fin(portfolio.netWorth)) return portfolio.netWorth;
      return fin(portfolio.marketValue) ? portfolio.marketValue : null;
    },
    describe: (rule) => fill('Portfolio value {op} {value}', { op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.value(Number(rule.value)) }),
  },
  {
    id: 'portfolioDayPL', label: 'Portfolio day P/L', group: 'Portfolio', needs: 'portfolio', ops: LEVEL_OPS, params: [],
    unit: 'value', fmt: 'value', level: 'standard', learn: 'day-pl', defValue: null,
    metric: ({ portfolio }) => (portfolio && fin(portfolio.dayPL) ? portfolio.dayPL : null),
    describe: (rule) => fill('Portfolio day P/L {op} {value}', { op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.value(Number(rule.value)) }),
  },
  {
    // Day P/L over yesterday's value of today's holdings (value − dayPL).
    id: 'portfolioDayPct', label: 'Portfolio day change %', group: 'Portfolio', needs: 'portfolio', ops: LEVEL_OPS, params: [],
    unit: 'pct', fmt: 'pct', level: 'standard', learn: 'day-pl', defValue: -2,
    metric: ({ portfolio }) => {
      if (!portfolio || !fin(portfolio.dayPL) || !fin(portfolio.marketValue)) return null;
      const base = portfolio.marketValue - portfolio.dayPL;
      return base > 0 ? portfolio.dayPL / base * 100 : null;
    },
    describe: (rule) => fill('Portfolio day change {op} {value}', { op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.pct(Number(rule.value)) }),
  },
];

function maSentence(rule, kind) {
  const n = paramsFor(rule).period;
  const v = Number(rule.value);
  if (isCrossOp(rule.op) && v === 0) {
    return fill(rule.op === 'crossAbove' ? '{sym} price crosses above its {kind}({n})' : '{sym} price crosses below its {kind}({n})',
      { sym: symOf(rule), kind, n });
  }
  return fill('{sym} price vs {kind}({n}) {op} {value}', {
    sym: symOf(rule), kind, n, op: i18nT(OP_LABEL[rule.op] || rule.op), value: FORMATTERS.pct(v),
  });
}

export const ALERT_TYPES = Object.freeze(Object.fromEntries(DEF.map((d) => [d.id, Object.freeze(d)])));
export const ALERT_GROUPS = ['Price', 'Change', 'Volume', 'Range', 'Technical', 'Portfolio'];

// Defaults merged with the rule's own params, each clamped to its declared range.
// A rule with a hand-edited period of 1e6 asks for a year of bars it will never
// get, which is a rule that silently never fires.
export function paramsFor(rule) {
  const def = rule && ALERT_TYPES[rule.type];
  const out = {};
  if (!def) return out;
  const raw = rule.params && typeof rule.params === 'object' ? rule.params : {};
  for (const prm of def.params) {
    const n = Number(raw[prm.key]);
    let v = Number.isFinite(n) ? n : prm.def;
    if (prm.min != null) v = Math.max(prm.min, v);
    if (prm.max != null) v = Math.min(prm.max, v);
    out[prm.key] = v;
  }
  return out;
}

export function describeRule(rule) {
  const def = rule && ALERT_TYPES[rule.type];
  if (!def) return fill('{sym} {type} (not supported by this version)', { sym: rule ? rule.symbol : '?', type: rule ? rule.type : '?' });
  try { return def.describe(rule); } catch (e) { return `${rule.symbol} ${def.label}`; }
}

export function formatMetric(rule, v) {
  const def = rule && ALERT_TYPES[rule.type];
  const f = FORMATTERS[(def && def.fmt) || 'value'];
  return f(v);
}

// The types a given experience level is offered. Existing rules of a higher
// level keep working; this only narrows the picker.
const RANK = { beginner: 0, standard: 1, pro: 2 };
export function typesForLevel(level) {
  const cap = RANK[level] != null ? RANK[level] : 2;
  return DEF.filter((d) => RANK[d.level] <= cap).map((d) => d.id);
}
