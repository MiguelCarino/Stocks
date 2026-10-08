/* chart.js — the canvas chart engine (candles, panes, drawings, levels).

   One component for every chart in the app: the workspace chart widget, the
   detail drawer and the popout all mount createChart() and feed it bars. It
   never fetches and never stores — the host owns data, persistence and the
   toolbar; this module owns pixels and pointer gestures, and reports what the
   user did through callbacks (onDrawingsChange, onLevelDrag, onRequestAlert…).

   Coordinate model. The x axis is BAR-INDEX based, not time based: bar i sits
   at x(i) = plotR − (rightIdx − i)·barW. That is what compresses nights,
   weekends and holidays out of the picture (session-gap compression) and keeps
   candles evenly spaced. Anything stored — drawings, synced crosshairs — is in
   DATA space ({t, p}) and mapped through idxOfT(), so a trendline drawn on the
   daily chart lands on the same dates on the hourly one.

   Each pane maps its values through a "space" before the linear y mapping:
   identity, ln() for log scale, or ratio-to-first-visible-bar for compare/
   percent mode. Autoscale, ticks and hit-testing all work in that space, so log
   and percent cost one function rather than a second renderer.

   One canvas, fully redrawn per animation frame. A frame with ~1,000 visible
   candles and a few indicators costs a couple of milliseconds; a second
   "overlay" canvas for the crosshair would save that and cost a second sizing,
   hit-testing and DPR path, which is where chart bugs actually live. All work
   is coalesced into one requestAnimationFrame. Indicators are computed when the
   bars or the indicator list change, never per frame.

   Colours come from CSS custom properties on the chart root (css/chart.css),
   read at draw time and parsed with viz.js toRGB, so a theme in hex, rgb() or
   oklch() all work. There are no animations; prefers-reduced-motion has nothing
   to turn off. */

import { fmtNum, fmtPct, fmtVolume, priceDecimals } from './format.js';
import { hexA, toRGB } from './viz.js';
import { INDICATORS, computeIndicator, heikinAshi, barSpacing } from './indicators.js';

const i18nT = (s) => (typeof window !== 'undefined' && window.CarinoI18n ? window.CarinoI18n.t(s) : s);

const AXIS_H = 24;          // time axis height
const MIN_PANE = 46;        // smallest indicator pane, px
const SUB_WEIGHT = 0.3;     // default sub-pane height relative to the main pane (1)
const HIT = 6;              // drawing hit tolerance, px
const LONG_PRESS = 520;     // ms
const DAY = 86400000;
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const INTERVAL_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '1d': DAY, '1w': 7 * DAY, '1M': 30 * DAY };
const INTERVAL_LABEL = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': 'Daily', '1w': 'Weekly', '1M': 'Monthly' };
const TOOLS = ['hline', 'trend', 'ray', 'rect', 'fib', 'text', 'measure'];
const ONE_CLICK = { hline: true, text: true };
const MAX_DRAWINGS = 200;
const SOURCE_LABEL = { twelvedata: 'Twelve Data', polygon: 'Polygon', alpaca: 'Alpaca', alphavantage: 'Alpha Vantage', coingecko: 'CoinGecko', finnhub: 'Finnhub' };

const fin = (x) => x != null && Number.isFinite(x);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const setText = (node, s) => { if (node.textContent !== s) node.textContent = s; };

export function createChart(container, opts = {}) {
  /* ---- DOM ---------------------------------------------------------------- */
  const root = el('div', 'cc-root');
  const canvas = el('canvas', 'cc-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', i18nT('Price chart'));
  const legends = el('div', 'cc-legends');
  const chips = el('div', 'cc-chips');
  const stateEl = el('div', 'cc-state');
  stateEl.hidden = true;
  const menu = el('div', 'cc-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  root.append(canvas, legends, chips, stateEl, menu);
  container.appendChild(root);
  const ctx = canvas.getContext('2d');

  /* ---- state -------------------------------------------------------------- */
  let bars = [], disp = [], spacing = DAY;
  let meta = { symbol: '', currency: 'USD', interval: '1d', isDemo: false, source: '' };
  let type = 'candle', logScale = false, showVolume = true, pctMode = false;
  let readOnly = !!opts.readOnly;
  let specs = [];          // [{id, params, color}]
  let computed = [];       // [{spec, def, res, color, paneKey}]
  let levels = [], compare = [], drawings = [];
  let tool = null, selectedId = null, draft = null, measure = null, textEdit = null;
  let rightIdx = 0, barW = 8, followLive = true;
  let hover = null;        // {x, y} in CSS px, mouse/touch crosshair
  let pinned = false;      // touch: crosshair stays after a tap
  let syncedIdx = null;
  let levelDrag = null;    // {level, price}
  const weights = new Map(), manual = new Map();
  let W = 0, H = 0, dpr = 1, L = null;   // L = last layout
  let state = 'ready', stateMsg = '';
  let raf = 0, destroyed = false, lastView = '';
  let gesture = null;      // active pointer interaction
  const touches = new Map();
  let longTimer = 0;

  /* ---- scheduling ----------------------------------------------------------- */
  function schedule() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => { raf = 0; try { draw(); } catch (e) { console.error('chart draw', e); } });
  }

  /* ---- data-space helpers ---------------------------------------------------- */
  const last = () => bars.length - 1;
  function idxOfT(t) {
    const n = bars.length;
    if (!n) return 0;
    if (t <= bars[0].t) return (t - bars[0].t) / spacing;
    if (t >= bars[n - 1].t) return n - 1 + (t - bars[n - 1].t) / spacing;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bars[m].t <= t) lo = m; else hi = m; }
    const span = bars[hi].t - bars[lo].t;
    return lo + (span > 0 ? (t - bars[lo].t) / span : 0);
  }
  function tOfIdx(i) {
    const n = bars.length;
    if (!n) return 0;
    if (i <= 0) return Math.round(bars[0].t + i * spacing);
    if (i >= n - 1) return Math.round(bars[n - 1].t + (i - (n - 1)) * spacing);
    const lo = Math.floor(i), f = i - lo;
    return Math.round(bars[lo].t + f * (bars[lo + 1].t - bars[lo].t));
  }
  const xOf = (i) => L.plotR - (rightIdx - i) * barW;
  const idxAt = (x) => rightIdx - (L.plotR - x) / barW;

  /* ---- theme ---------------------------------------------------------------- */
  function theme() {
    const cs = getComputedStyle(root);
    const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const t = {
      bg: v('--chart-bg', v('--bg-card', '#0b0b0b')),
      grid: v('--chart-grid', v('--border', '#262626')),
      axis: v('--chart-axis', v('--text-muted', '#666')),
      text: v('--text', '#fff'), textSec: v('--text-sec', '#a3a3a3'),
      accent: v('--accent', '#eab308'), up: v('--ok', '#22c55e'), down: v('--err', '#ef4444'),
      cross: v('--chart-cross', v('--text-sec', '#a3a3a3')),
      font: v('--mono', 'ui-monospace, monospace'),
      series: [1, 2, 3, 4, 5, 6].map((k) => v('--chart-s' + k, '')).filter(Boolean),
    };
    if (!t.series.length) t.series = [t.accent, '#60a5fa', '#c084fc', '#f472b6', '#2dd4bf', '#fb923c'];
    return t;
  }
  // Black or white text for a filled tag, by the fill's luminance.
  function inkOn(color) {
    const c = toRGB(color);
    if (!c) return '#000';
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return lum > 0.55 ? '#000' : '#fff';
  }

  /* ---- indicators ------------------------------------------------------------ */
  function recompute() {
    let k = 0;
    computed = specs.map((spec) => {
      const def = INDICATORS[spec.id];
      if (!def) return null;
      const res = computeIndicator(spec.id, bars, spec.params || {});
      if (!res) return null;
      const paneKey = def.kind === 'overlay' ? 'main'
        : def.target === 'volume' && showVolume ? 'main' : spec.id + ':' + (k++);
      return { spec, def, res, paneKey, colorIdx: computedColorIdx(spec) };
    }).filter(Boolean);
  }
  let colorCounter = 0;
  const colorIdxBySpec = new WeakMap();
  function computedColorIdx(spec) {
    if (!colorIdxBySpec.has(spec)) colorIdxBySpec.set(spec, colorCounter++);
    return colorIdxBySpec.get(spec);
  }

  /* ---- view ------------------------------------------------------------------ */
  function resetView() {
    followLive = true;
    manual.clear();
    if (!L) { measureBox(); }
    const plotW = Math.max(50, (L ? L.plotR : W - 60));
    const n = bars.length;
    // opts.fitAll: a period chart (compare, performance) shows the whole period
    // it reports a return for, not the last few months of it.
    const want = opts.fitAll ? Math.max(n, 2) : Math.min(Math.max(n, 20), Math.max(40, Math.round(plotW / 7)));
    barW = clamp(plotW / (want + 4), opts.fitAll ? 0.3 : 1.5, 24);
    rightIdx = Math.max(0, n - 1) + Math.max(2, Math.round(30 / barW)) + 0.5;
    schedule();
  }
  function clampView() {
    const n = Math.max(1, bars.length), plotW = L ? L.plotR : 400;
    // Zoomed all the way out, every bar fits with a little air; no further.
    barW = clamp(barW, Math.max(0.3, plotW / (n + 24)), 60);
    const vis = plotW / barW;
    // Future space is allowed (the Ichimoku cloud and drawings live there) but
    // capped, so a zoomed-out chart cannot end up mostly empty on the right.
    rightIdx = clamp(rightIdx, Math.min(vis * 0.25, n - 1) + 2, n - 1 + Math.max(8, Math.min(vis * 0.5, 120)));
  }
  function zoomAt(x, factor) {
    if (!L) return;
    const anchor = idxAt(x);
    barW *= factor;
    clampView();
    rightIdx = anchor + (L.plotR - x) / barW;
    clampView();
    followLive = rightIdx >= last();
    schedule();
  }
  function panBy(dxPx) {
    rightIdx -= dxPx / barW;
    clampView();
    followLive = rightIdx >= last();
    schedule();
  }

  /* ---- spaces / scales --------------------------------------------------------- */
  // main pane: price -> space value
  function mainSpace(p, base) {
    if (!fin(p)) return null;
    if (pctMode || compare.length) {
      if (!fin(base) || base <= 0) return null;
      return logScale ? (p > 0 ? Math.log(p / base) : null) : p / base - 1;
    }
    return logScale ? (p > 0 ? Math.log(p) : null) : p;
  }
  function mainInv(s, base) {
    if (pctMode || compare.length) return logScale ? Math.exp(s) * base : (s + 1) * base;
    return logScale ? Math.exp(s) : s;
  }
  const isPct = () => pctMode || compare.length > 0;

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const e = Math.floor(Math.log10(raw)), f = raw / Math.pow(10, e);
    const nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
    return nf * Math.pow(10, e);
  }
  function linTicks(lo, hi, count) {
    const step = niceStep((hi - lo) / Math.max(1, count));
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && out.length < 50; v += step) out.push(+v.toPrecision(12));
    return { ticks: out, step };
  }

  /* ---- layout ------------------------------------------------------------------ */
  function measureBox() {
    const r = root.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio || 1, 3);
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    root.classList.toggle('cc-narrow', W < 520);
  }

  function layout(T) {
    const sub = [];
    const seen = new Set();
    for (const c of computed) if (c.paneKey !== 'main' && !seen.has(c.paneKey)) { seen.add(c.paneKey); sub.push(c.paneKey); }
    // Axis width: measured from the widest label this frame will print.
    ctx.font = '11px ' + T.font;
    const ref = disp.length ? disp[disp.length - 1].c : 100;
    let widest = ctx.measureText(isPct() ? '+888.88%' : fmtNum(ref * 1.1, priceDecimals(ref))).width;
    widest = Math.max(widest, ctx.measureText(isPct() ? '−88.88%' : fmtNum(ref * 0.9, priceDecimals(ref))).width);
    if (sub.length) widest = Math.max(widest, ctx.measureText('−888.88M').width);
    // Room for an off-range level tag ('▼ 190.05'), the widest thing the axis prints.
    if (levels.length) widest = Math.max(widest, ctx.measureText('▼ ' + (isPct() ? '−88.88%' : fmtNum(ref * 0.9, priceDecimals(ref)))).width);
    const axisW = clamp(Math.ceil(widest) + 18, 52, Math.max(52, W * 0.32));
    const plotR = Math.max(10, W - axisW);
    const avail = Math.max(40, H - AXIS_H);
    let ws = [weights.get('main') || 1].concat(sub.map((k) => weights.get(k) || SUB_WEIGHT));
    const sum = ws.reduce((a, b) => a + b, 0);
    let hs = ws.map((w) => (avail * w) / sum);
    // keep every sub-pane readable; the main pane gives up the height
    for (let i = 1; i < hs.length; i++) if (hs[i] < MIN_PANE) { hs[0] -= MIN_PANE - hs[i]; hs[i] = MIN_PANE; }
    if (hs[0] < 60) { const f = avail / hs.reduce((a, b) => a + b, 0); hs = hs.map((h) => h * f); }
    let top = 0;
    const panes = [{ key: 'main', top, h: hs[0] }];
    top += hs[0];
    sub.forEach((key, i) => { panes.push({ key, top, h: hs[i + 1] }); top += hs[i + 1]; });
    return { axisW, plotR, panes, timeTop: avail };
  }

  /* ---- drawing primitives -------------------------------------------------------- */
  const crisp = (v) => Math.round(v) + 0.5;
  function hLine(x0, x1, y, color, dash, width = 1) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); ctx.stroke(); ctx.restore();
  }
  function tag(x, y, text, fill, ink, align, T) { return drawTag(x, y, text, fill, ink, align, T); }
  function drawTag(x, y, text, fill, ink, align = 'left', T) {
    ctx.font = '600 11px ' + T.font;
    const w = ctx.measureText(text).width + 10, h = 17;
    const x0 = align === 'left' ? x : x - w;
    const y0 = Math.round(y - h / 2);
    ctx.fillStyle = fill;
    roundRect(x0, y0, w, h, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, x0 + 5, y0 + h / 2 + 0.5);
    return { x0, y0, w, h };
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  // Polyline over aligned values (with shift), breaking on nulls.
  function polyline(values, from, to, shift, yOf, step, breaks) {
    let open = false;
    ctx.beginPath();
    for (let i = Math.max(0, from - shift - 1); i <= Math.min(values.length - 1, to - shift + 1); i++) {
      if (breaks && breaks.has(i)) open = false;
      const v = values[i];
      const y = fin(v) ? yOf(v) : null;
      if (y == null) { open = false; continue; }
      const x = xOf(i + shift);
      if (step) {
        const prev = i > 0 ? values[i - 1] : null;
        if (!open || prev !== v) { ctx.moveTo(x - barW / 2, y); open = true; }
        ctx.lineTo(x + barW / 2, y);
        continue;
      }
      if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /* ---- time axis labels ------------------------------------------------------------ */
  const utcTime = () => (INTERVAL_MS[meta.interval] || spacing) >= DAY;
  function dparts(t) {
    const d = new Date(t);
    return utcTime()
      ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
      : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
  const fmtCache = new Map();
  function dtf(o) {
    const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
    const key = lang + JSON.stringify(o) + utcTime();
    if (!fmtCache.has(key)) {
      try { fmtCache.set(key, new Intl.DateTimeFormat(lang, { ...o, ...(utcTime() ? { timeZone: 'UTC' } : {}) })); }
      catch (e) { fmtCache.set(key, new Intl.DateTimeFormat('en', o)); }
    }
    return fmtCache.get(key);
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function timeLabels(from, to, T) {
    const out = [];
    if (to < from) return out;
    const intraday = !utcTime();
    let prev = from > 0 ? dparts(bars[from - 1].t) : null;
    const cands = [];
    for (let i = from; i <= to; i++) {
      const p = dparts(bars[i].t);
      let score = 0, text = '';
      if (!prev || p.y !== prev.y) { score = 50; text = String(p.y); }
      else if (p.mo !== prev.mo) { score = 40; text = dtf({ month: 'short' }).format(bars[i].t); }
      else if (p.d !== prev.d) { score = 30; text = intraday ? dtf({ day: 'numeric', month: 'short' }).format(bars[i].t) : String(p.d); }
      else if (p.h !== prev.h) { score = 20 + (p.h % 6 === 0 ? 3 : p.h % 3 === 0 ? 2 : 0); text = pad2(p.h) + ':' + pad2(p.mi); }
      else if (p.mi !== prev.mi) { score = 10 + (p.mi % 30 === 0 ? 3 : p.mi % 15 === 0 ? 2 : p.mi % 5 === 0 ? 1 : 0); text = pad2(p.h) + ':' + pad2(p.mi); }
      if (!prev && i === from && from > 0) score = 0;   // the first visible bar is not a boundary
      prev = p;
      if (score) cands.push({ i, score, text });
    }
    ctx.font = '11px ' + T.font;
    cands.sort((a, b) => b.score - a.score || a.i - b.i);
    const placed = [];
    for (const c of cands) {
      const x = xOf(c.i), w = ctx.measureText(c.text).width;
      if (x - w / 2 < 2 || x + w / 2 > L.plotR - 2) continue;
      if (placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 18)) continue;
      placed.push({ x, w, ...c });
    }
    return placed;
  }
  function fullTime(t) {
    try {
      return utcTime()
        ? dtf({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(t)
        : dtf({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
    } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* ---- value formatting -------------------------------------------------------- */
  const refPrice = () => (disp.length ? disp[disp.length - 1].c : 1);
  const fmtP = (v) => (fin(v) ? fmtNum(v, priceDecimals(Math.abs(refPrice()) || v)) : '—');
  // Price-axis label: the instrument's precision, trimmed to what the tick step
  // needs ('0.50', not '0.5000') but never below two places for prices under
  // 1,000, which is how every quote elsewhere in the app reads.
  function fmtAxisPrice(v, step) {
    const ref = Math.abs(refPrice()) || Math.abs(v) || 1, pd = priceDecimals(ref);
    let need = 0;
    while (need < 8 && Math.abs(Math.round(step * Math.pow(10, need)) - step * Math.pow(10, need)) > 1e-6) need++;
    const d = Math.max(Math.min(need, pd), ref >= 1000 ? 0 : Math.min(2, pd));
    return fmtNum(v, d);
  }
  // Oscillator / indicator values: magnitude-based, compact above 100k.
  function fmtInd(v) {
    if (!fin(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e5) return (v < 0 ? '−' : '') + fmtVolume(a);
    return (v < 0 ? '−' : '') + fmtNum(a, a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 3 : 4);
  }
  function fmtPane(v, step) {
    if (!fin(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e5) return (v < 0 ? '−' : '') + fmtVolume(a);
    const s = step || a;
    const d = s >= 10 ? 0 : s >= 1 ? 1 : s >= 0.1 ? 2 : s >= 0.01 ? 3 : 4;
    return (v < 0 ? '−' : '') + fmtNum(a, d);
  }

  /* ---- the frame ----------------------------------------------------------------- */
  function draw() {
    measureBox();
    const T = theme();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    L = layout(T);
    clampView();
    const n = bars.length;
    const from = Math.max(0, Math.floor(idxAt(0)));
    const to = Math.min(n - 1, Math.ceil(idxAt(L.plotR)));
    L.from = from; L.to = to;

    // percent/compare base = close of the first visible bar
    L.base = n && from <= to ? (disp[from] && disp[from].c) : null;
    L.cmpBase = compare.map((c) => { for (let i = from; i <= to; i++) if (fin(c.values[i])) return c.values[i]; return null; });

    const crossIdx = hoverIdx();
    const tl = n ? timeLabels(from, to, T) : [];

    // grid: vertical at time labels across all panes
    ctx.strokeStyle = hexA(T.grid, 0.55); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of tl) { const x = crisp(p.x); ctx.moveTo(x, 0); ctx.lineTo(x, L.timeTop); }
    ctx.stroke();

    for (const pane of L.panes) drawPane(pane, T, from, to);

    // separators + axis border
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.beginPath();
    for (const p of L.panes.slice(1)) { ctx.moveTo(0, crisp(p.top)); ctx.lineTo(W, crisp(p.top)); }
    ctx.moveTo(crisp(L.plotR), 0); ctx.lineTo(crisp(L.plotR), L.timeTop);
    ctx.moveTo(0, crisp(L.timeTop)); ctx.lineTo(W, crisp(L.timeTop));
    ctx.stroke();

    // time axis
    ctx.fillStyle = T.axis; ctx.font = '11px ' + T.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of tl) {
      ctx.fillStyle = p.score >= 40 ? T.textSec : T.axis;
      ctx.font = (p.score >= 40 ? '600 ' : '') + '11px ' + T.font;
      ctx.fillText(p.text, p.x, L.timeTop + AXIS_H / 2);
    }

    drawCrosshair(T, crossIdx);
    paintLegends(T, crossIdx);
    paintChips();
    emitView(from, to);
  }

  function hoverIdx() {
    if (!bars.length) return null;
    if (hover && L && hover.x <= L.plotR) return clamp(Math.round(idxAt(hover.x)), 0, last());
    if (syncedIdx != null) return syncedIdx;
    return null;
  }

  /* ---- panes --------------------------------------------------------------------- */
  function drawPane(pane, T, from, to) {
    const main = pane.key === 'main';
    const items = computed.filter((c) => c.paneKey === pane.key);
    const padT = main ? 14 : 8, padB = main ? (showVolume && hasVolume() ? Math.max(18, pane.h * 0.2) : 10) : 6;
    const innerTop = pane.top + padT, innerH = Math.max(10, pane.h - padT - padB);

    // ---- scale
    let lo = Infinity, hi = -Infinity;
    const take = (s) => { if (fin(s)) { if (s < lo) lo = s; if (s > hi) hi = s; } };
    const space = main ? (p) => mainSpace(p, L.base) : (v) => v;
    if (main) {
      for (let i = from; i <= to; i++) {
        const b = disp[i];
        if (!b) continue;
        if (type === 'candle' || type === 'ohlc' || type === 'heikin') { take(space(b.h)); take(space(b.l)); }
        else take(space(b.c));
      }
      compare.forEach((c, k) => { for (let i = from; i <= to; i++) take(mainSpace(c.values[i], L.cmpBase[k])); });
      if (type === 'baseline') take(space(baselinePrice(from)));
    }
    for (const it of items) {
      if (it.def.target === 'volume' && main) continue;   // drawn on the volume strip
      for (const ln of it.res.lines) {
        const sh = ln.shift || 0;
        if (!main && ln.style === 'histogram') take(0);
        for (let i = from - sh; i <= to - sh; i++) take(space(ln.values[i]));
      }
    }
    if (!main) {
      const def = items[0] && items[0].def;
      if (def && def.range) { take(def.range[0]); take(def.range[1]); }
    }
    if (!fin(lo) || !fin(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12) { const m = Math.abs(hi) * 0.01 || 1; lo -= m; hi += m; }
    const padF = main ? 0.06 : 0.08;
    let span = hi - lo;
    lo -= span * padF; hi += span * padF;
    const man = manual.get(pane.key);
    if (man) { lo = man.lo; hi = man.hi; }
    const y = (s) => innerTop + (1 - (s - lo) / (hi - lo)) * innerH;
    const yv = (v) => { const s = space(v); return fin(s) ? y(s) : null; };
    pane.lo = lo; pane.hi = hi; pane.y = y; pane.yv = yv; pane.innerTop = innerTop; pane.innerH = innerH;
    pane.inv = (py) => { const s = lo + (1 - (py - innerTop) / innerH) * (hi - lo); return main ? mainInv(s, L.base) : s; };

    // ---- y ticks + grid
    const count = Math.max(2, Math.floor(innerH / (main ? 46 : 30)));
    const ticks = [];
    if (main && logScale) {
      const seen = new Set();
      for (let k = 0; k <= count; k++) {
        const s = lo + ((hi - lo) * k) / count;
        const v = isPct() ? Math.exp(s) - 1 : Math.exp(s);
        const stepV = niceStep(Math.abs(isPct() ? Math.exp(s) : v) * (Math.exp((hi - lo) / count) - 1));
        const r = Math.round(v / stepV) * stepV;
        const key = r.toPrecision(8);
        if (seen.has(key)) continue;
        seen.add(key);
        const sv = isPct() ? (r + 1 > 0 ? Math.log(r + 1) : null) : (r > 0 ? Math.log(r) : null);
        if (fin(sv) && sv >= lo && sv <= hi) ticks.push({ s: sv, v: r, step: stepV });
      }
    } else {
      const lt = linTicks(lo, hi, count);
      for (const s of lt.ticks) ticks.push({ s, v: s, step: lt.step });
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, pane.top, W, pane.h); ctx.clip();
    ctx.strokeStyle = hexA(T.grid, 0.55); ctx.lineWidth = 1; ctx.beginPath();
    for (const t of ticks) { const yy = crisp(y(t.s)); if (yy < pane.top + 2 || yy > pane.top + pane.h - 2) continue; ctx.moveTo(0, yy); ctx.lineTo(L.plotR, yy); }
    ctx.stroke();
    // tick labels are printed after the tags (below) so a label half-hidden
    // behind a tag can be skipped instead of peeking out from under it
    const tickLabels = [];
    for (const t of ticks) {
      const yy = y(t.s);
      if (yy < pane.top + 7 || yy > pane.top + pane.h - 7) continue;
      tickLabels.push({ yy, text: main ? (isPct() ? fmtPct(t.v * 100) : fmtAxisPrice(t.v, t.step)) : fmtPane(t.v, t.step) });
    }

    // ---- plot content, clipped to the plot area
    ctx.save();
    ctx.beginPath(); ctx.rect(0, pane.top, L.plotR, pane.h); ctx.clip();
    if (!main) {
      const def = items[0] && items[0].def;
      if (def && def.levels) {
        if (def.levels.length >= 2 && def.range) {
          const a = yv(def.levels[0]), b = yv(def.levels[def.levels.length - 1]);
          ctx.fillStyle = hexA(T.accent, 0.05);
          ctx.fillRect(0, Math.min(a, b), L.plotR, Math.abs(a - b));
        }
        for (const lv of def.levels) hLine(0, L.plotR, yv(lv), hexA(T.axis, 0.8), [3, 4]);
      }
    }
    if (main) {
      if (showVolume && hasVolume()) drawVolume(pane, T, from, to, items);
      for (const it of items) if (it.def.target !== 'volume') drawIndicator(it, pane, T, from, to, true);
      drawSeries(pane, T, from, to);
      compare.forEach((c, k) => {
        ctx.strokeStyle = T.series[(k + 1) % T.series.length]; ctx.lineWidth = 1.6; ctx.setLineDash([]);
        polyline(c.values, from, to, 0, (v) => { const s = mainSpace(v, L.cmpBase[k]); return fin(s) ? y(s) : null; });
      });
      drawDrawings(pane, T);
    } else {
      for (const it of items) drawIndicator(it, pane, T, from, to, false);
    }
    ctx.restore();

    // ---- axis tags (outside the plot clip, inside the pane clip)
    const tagYs = main ? drawMainTags(pane, T, from, to) : drawPaneTags(pane, T, items, to);
    ctx.fillStyle = T.axis; ctx.font = '11px ' + T.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const t of tickLabels) if (!tagYs.some((ty) => Math.abs(ty - t.yy) < 15)) ctx.fillText(t.text, L.plotR + 7, t.yy);
    ctx.restore();
  }

  function hasVolume() {
    for (let i = Math.max(0, bars.length - 50); i < bars.length; i++) if (fin(bars[i].v) && bars[i].v > 0) return true;
    return false;
  }

  function baselinePrice(from) {
    const pc = levels.find((l) => l.kind === 'prevClose' && fin(l.price));
    if (pc) return pc.price;
    return disp[from] ? disp[from].c : null;
  }

  function drawVolume(pane, T, from, to, items) {
    let vmax = 0;
    for (let i = from; i <= to; i++) if (fin(bars[i].v) && bars[i].v > vmax) vmax = bars[i].v;
    if (!(vmax > 0)) return;
    const bottom = pane.top + pane.h - 1, hgt = pane.h * 0.2;
    const w = Math.max(1, barW * 0.7);
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = hexA(pass ? T.down : T.up, 0.3);
      for (let i = from; i <= to; i++) {
        const b = bars[i];
        if (!fin(b.v)) continue;
        const dn = i > 0 ? b.c < bars[i - 1].c : b.c < b.o;
        if (dn !== !!pass) continue;
        const h = (b.v / vmax) * hgt;
        ctx.fillRect(xOf(i) - w / 2, bottom - h, w, h);
      }
    }
    // volume-targeted indicators (Vol MA) ride on the same scale
    for (const it of items) {
      if (it.def.target !== 'volume') continue;
      const ma = it.res.lines.find((l) => l.style !== 'histogram');
      if (!ma) continue;
      ctx.strokeStyle = colorOf(it, 0, T); ctx.lineWidth = 1.2; ctx.setLineDash([]);
      polyline(ma.values, from, to, 0, (v) => bottom - (v / vmax) * hgt);
    }
  }

  function colorOf(it, j, T) {
    if (it.spec.color) return j === 0 ? it.spec.color : T.series[(it.colorIdx + j) % T.series.length];
    return T.series[(it.colorIdx + j) % T.series.length];
  }

  function drawIndicator(it, pane, T, from, to, onMain) {
    const lines = it.res.lines;
    const yv = pane.yv;
    const base = colorOf(it, 0, T);
    // fills first
    if (it.res.fill) {
      const up = lines.find((l) => l.style === 'band-upper'), dn = lines.find((l) => l.style === 'band-lower');
      if (up && dn) {
        const sh = up.shift || 0;
        for (let i = Math.max(1, from - sh - 1); i <= Math.min(up.values.length - 1, to - sh + 1); i++) {
          const a0 = up.values[i - 1], a1 = up.values[i], b0 = dn.values[i - 1], b1 = dn.values[i];
          if (![a0, a1, b0, b1].every(fin)) continue;
          if (up.breaks && breakSet(up.breaks).has(i)) continue;
          ctx.fillStyle = it.res.fill === 'cloud' ? hexA(a1 >= b1 ? T.up : T.down, 0.13) : hexA(base, 0.07);
          const x0 = xOf(i - 1 + sh), x1 = xOf(i + sh);
          ctx.beginPath(); ctx.moveTo(x0, yv(a0)); ctx.lineTo(x1, yv(a1)); ctx.lineTo(x1 + 0.5, yv(b1)); ctx.lineTo(x0, yv(b0)); ctx.closePath(); ctx.fill();
        }
      }
    }
    let j = 0;
    for (const ln of lines) {
      const sh = ln.shift || 0;
      const style = ln.style || 'line';
      if (style === 'histogram') {
        if (onMain) continue;
        const w = Math.max(1, barW * 0.62), y0 = yv(0);
        for (let i = Math.max(0, from - sh); i <= Math.min(ln.values.length - 1, to - sh); i++) {
          const v = ln.values[i];
          if (!fin(v)) continue;
          let col;
          if (ln.key === 'vol') { const b = bars[i]; col = hexA(i > 0 && b.c < bars[i - 1].c ? T.down : T.up, 0.45); }
          else { const pv = ln.values[i - 1]; const rising = fin(pv) ? Math.abs(v) >= Math.abs(pv) : true; col = hexA(v >= 0 ? T.up : T.down, rising ? 0.85 : 0.45); }
          ctx.fillStyle = col;
          const yy = yv(v);
          ctx.fillRect(xOf(i + sh) - w / 2, Math.min(y0, yy), w, Math.max(1, Math.abs(y0 - yy)));
        }
        continue;
      }
      let col;
      if (ln.tone === 'up') col = T.up;
      else if (ln.tone === 'down') col = T.down;
      else if (style === 'band-upper' || style === 'band-lower') col = hexA(base, 0.6);
      else if (ln.step) col = /^R/.test(ln.key) ? hexA(T.down, 0.75) : /^S/.test(ln.key) ? hexA(T.up, 0.75) : hexA(T.textSec, 0.9);
      else if (ln.key === 'chikou') col = hexA(T.textSec, 0.7);
      else { col = j === 0 ? base : colorOf(it, j, T); j++; }
      if (style === 'dots') {
        const r = clamp(barW * 0.16, 1.1, 2.4);
        for (let i = Math.max(0, from - sh); i <= Math.min(ln.values.length - 1, to - sh); i++) {
          const v = ln.values[i];
          if (!fin(v)) continue;
          ctx.fillStyle = bars[i] && v < bars[i].c ? T.up : T.down;
          ctx.beginPath(); ctx.arc(xOf(i + sh), yv(v), r, 0, Math.PI * 2); ctx.fill();
        }
        continue;
      }
      ctx.strokeStyle = col; ctx.lineWidth = ln.step ? 1 : style === 'line' ? 1.4 : 1; ctx.setLineDash(ln.step ? [5, 3] : []);
      ctx.lineJoin = 'round';
      polyline(ln.values, from, to, sh, yv, !!ln.step, ln.breaks && ln.breaks.length ? breakSet(ln.breaks) : null);
      ctx.setLineDash([]);
      if (ln.step) {
        // label the visible run at its right end
        for (let i = Math.min(to, ln.values.length - 1); i >= from; i--) {
          if (!fin(ln.values[i])) continue;
          ctx.fillStyle = col; ctx.font = '10px ' + T.font; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          ctx.fillText(ln.label, Math.min(L.plotR - 4, xOf(i) + barW / 2), yv(ln.values[i]) - 2);
          break;
        }
      }
    }
  }

  const breakCache = new WeakMap();
  function breakSet(arr) { if (!breakCache.has(arr)) breakCache.set(arr, new Set(arr)); return breakCache.get(arr); }

  function drawSeries(pane, T, from, to) {
    const y = pane.yv;
    if (!disp.length) return;
    if (type === 'line' || type === 'area' || type === 'baseline') {
      const closes = disp.map((b) => b.c);
      if (type === 'baseline') {
        const bp = baselinePrice(from), by = y(bp);
        if (fin(by)) {
          for (const [col, clipTop, clipH] of [[T.up, pane.top, by - pane.top], [T.down, by, pane.top + pane.h - by]]) {
            if (clipH <= 0) continue;
            ctx.save(); ctx.beginPath(); ctx.rect(0, clipTop, L.plotR, clipH); ctx.clip();
            areaPath(closes, from, to, y, by); ctx.fillStyle = hexA(col, 0.12); ctx.fill();
            ctx.strokeStyle = col; ctx.lineWidth = 1.6; polyline(closes, from, to, 0, y);
            ctx.restore();
          }
          hLine(0, L.plotR, by, hexA(T.axis, 0.9), [2, 3]);
        }
        return;
      }
      if (type === 'area') {
        const g = ctx.createLinearGradient(0, pane.innerTop, 0, pane.top + pane.h);
        g.addColorStop(0, hexA(T.accent, 0.24)); g.addColorStop(1, hexA(T.accent, 0));
        areaPath(closes, from, to, y, pane.top + pane.h); ctx.fillStyle = g; ctx.fill();
      }
      ctx.strokeStyle = compare.length ? T.series[0] : T.accent; ctx.lineWidth = 1.7; ctx.lineJoin = 'round';
      polyline(closes, from, to, 0, y);
      return;
    }
    const bw = barW;
    const body = Math.max(1, Math.floor(bw * 0.72));
    const thin = bw < 2.2;
    for (let pass = 0; pass < 2; pass++) {
      const col = pass ? T.down : T.up;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();
      const bodies = [];
      for (let i = from; i <= to; i++) {
        const b = disp[i];
        if (!b || !fin(b.o) || !fin(b.c) || !fin(b.h) || !fin(b.l)) continue;
        const down = b.c < b.o;
        if (down !== !!pass) continue;
        const x = xOf(i), cx = crisp(x);
        const yo = y(b.o), yc = y(b.c), yh = y(b.h), yl = y(b.l);
        if (!fin(yo) || !fin(yc) || !fin(yh) || !fin(yl)) continue;
        if (type === 'ohlc') {
          const tick = Math.max(1, Math.floor(bw * 0.35));
          ctx.moveTo(cx, yh); ctx.lineTo(cx, yl);
          ctx.moveTo(cx - tick, crisp(yo)); ctx.lineTo(cx, crisp(yo));
          ctx.moveTo(cx, crisp(yc)); ctx.lineTo(cx + tick, crisp(yc));
          continue;
        }
        ctx.moveTo(cx, yh); ctx.lineTo(cx, yl);
        if (!thin) bodies.push([Math.round(x - body / 2), Math.min(yo, yc), body, Math.max(1, Math.abs(yc - yo))]);
      }
      ctx.lineWidth = type === 'ohlc' && bw > 6 ? 1.5 : 1;
      ctx.stroke();
      for (const r of bodies) ctx.fillRect(r[0], Math.round(r[1]), r[2], Math.max(1, Math.round(r[3])));
    }
  }
  function areaPath(values, from, to, y, floorY) {
    let first = null, lastX = null;
    ctx.beginPath();
    for (let i = Math.max(0, from - 1); i <= Math.min(values.length - 1, to + 1); i++) {
      const yy = fin(values[i]) ? y(values[i]) : null;
      if (!fin(yy)) continue;
      const x = xOf(i);
      if (first == null) { ctx.moveTo(x, floorY); ctx.lineTo(x, yy); first = x; } else ctx.lineTo(x, yy);
      lastX = x;
    }
    if (first != null) { ctx.lineTo(lastX, floorY); ctx.closePath(); }
  }

  /* ---- levels, last price, axis tags ------------------------------------------------ */
  const LEVEL_STYLE = {
    alert: { color: 'accent', dash: [6, 4] }, cost: { color: 'textSec', dash: [2, 3] }, prevClose: { color: 'axis', dash: [2, 3] },
    high52: { color: 'axis', dash: [8, 4] }, low52: { color: 'axis', dash: [8, 4] }, pivot: { color: 'axis', dash: [4, 4] },
    target: { color: 'up', dash: [6, 4] }, stop: { color: 'down', dash: [6, 4] },
  };
  function levelColor(l, T) { return l.color || T[(LEVEL_STYLE[l.kind] || LEVEL_STYLE.pivot).color] || T.accent; }
  function shownLevels() {
    return levels.map((l) => (levelDrag && levelDrag.level === l ? { ...l, price: levelDrag.price } : l));
  }

  function drawMainTags(pane, T, from, to) {
    const tagX = L.plotR + 1;
    const top = pane.top + 2, bottom = pane.top + pane.h - 2;
    const pin = (yy) => clamp(yy, top + 9, bottom - 9);
    // Tags are queued and laid out together: several levels near the price
    // (alert, cost, prev close, last) would otherwise print on top of each
    // other. The last price wins its exact spot; the rest step aside.
    const queue = [];
    const tag = (x, y, text, fill, ink, align, T2, prio = 0) => queue.push({ y, text, fill, ink, prio });
    // level lines (drawn here so they sit above the series)
    const labelYs = [];
    const offEdge = { up: null, down: null };
    for (const l of shownLevels()) {
      if (!fin(l.price)) continue;
      const col = levelColor(l, T), yy = pane.yv(l.price);
      if (!fin(yy)) continue;
      const inside = yy >= pane.top && yy <= pane.top + pane.h;
      if (inside) {
        ctx.save(); ctx.beginPath(); ctx.rect(0, pane.top, L.plotR, pane.h); ctx.clip();
        hLine(0, L.plotR, yy, col, (LEVEL_STYLE[l.kind] || LEVEL_STYLE.pivot).dash, l.draggable ? 1.3 : 1);
        if (l.label && !labelYs.some((ly) => Math.abs(ly - yy) < 14)) {
          labelYs.push(yy);
          ctx.font = '10px ' + T.font;
          const text = l.label + (l.draggable ? ' ⇕' : '');
          const w = ctx.measureText(text).width + 8;
          ctx.fillStyle = hexA(T.bg, 0.82);
          roundRect(L.plotR - 6 - w, yy - 15, w, 13, 3); ctx.fill();
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = col;
          ctx.fillText(text, L.plotR - 10, yy - 8);
        }
        ctx.restore();
      }
      const fill = hexA(col, l.kind === 'alert' || l.kind === 'target' || l.kind === 'stop' ? 0.95 : 0.75);
      const txt = isPct() ? fmtPct((l.price / L.base - 1) * 100) : fmtP(l.price);
      // Off-range levels all pin to the same edge; stacking every one of them
      // there printed an unreadable pile of tags. Only the nearest per edge is
      // shown; the rest come into view as the chart is panned or zoomed.
      if (yy < top || yy > bottom) {
        const side = yy < top ? 'up' : 'down', d = yy < top ? top - yy : yy - bottom;
        if (!offEdge[side] || d < offEdge[side].d) offEdge[side] = { d, txt, fill, ink: inkOn(col) };
        continue;
      }
      tag(tagX, pin(yy), txt, fill, inkOn(col), 'left', T);
    }
    for (const side of ['up', 'down']) {
      const o = offEdge[side];
      if (!o) continue;
      tag(tagX, side === 'up' ? top + 9 : bottom - 9, (side === 'up' ? '▲ ' : '▼ ') + o.txt, o.fill, o.ink, 'left', T);
    }
    // horizontal-line drawings get an axis tag too
    for (const d of drawings) {
      if (d.type !== 'hline' || !d.points[0]) continue;
      const yy = pane.yv(d.points[0].p);
      if (!fin(yy) || yy < top || yy > bottom) continue;
      const col = d.color || T.accent;
      tag(tagX, yy, fmtP(d.points[0].p), hexA(col, 0.9), inkOn(col), 'left', T);
    }
    // last price
    const n = disp.length;
    if (n) {
      const b = disp[n - 1], prev = n > 1 ? disp[n - 2].c : b.o;
      const col = b.c >= prev ? T.up : T.down;
      const yy = pane.yv(b.c);
      if (fin(yy)) {
        if (yy >= pane.top && yy <= pane.top + pane.h) {
          ctx.save(); ctx.beginPath(); ctx.rect(0, pane.top, L.plotR, pane.h); ctx.clip();
          hLine(0, L.plotR, yy, hexA(col, 0.7), [1, 2]);
          ctx.restore();
        }
        const text = isPct() ? fmtPct((b.c / L.base - 1) * 100) : fmtP(bars[n - 1].c);
        tag(tagX, pin(yy), text, col, inkOn(col), 'left', T, 2);
      }
      // compare series' last values
      compare.forEach((c, k) => {
        const v = c.values[Math.min(to, c.values.length - 1)];
        const s = mainSpace(v, L.cmpBase[k]);
        if (!fin(s)) return;
        const colc = T.series[(k + 1) % T.series.length];
        tag(tagX, pin(pane.y(s)), fmtPct((v / L.cmpBase[k] - 1) * 100), colc, inkOn(colc), 'left', T, 1);
      });
    }
    const laid = layoutTags(queue, top + 9, bottom - 9);
    laid.forEach((q) => drawTag(tagX, q.y, q.text, q.fill, q.ink, 'left', T));
    return laid.map((q) => q.y);
  }
  // Resolve overlaps: anchor the highest-priority tag, then push the others
  // apart in y order (17px = one tag height).
  function layoutTags(q, minY, maxY) {
    const G = 18;
    const sorted = q.slice().sort((a, b) => a.y - b.y);
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        const overlap = a.y + G - b.y;
        if (overlap <= 0) continue;
        if (a.prio > b.prio) b.y += overlap;
        else if (b.prio > a.prio) a.y -= overlap;
        else { a.y -= overlap / 2; b.y += overlap / 2; }
      }
      for (const t of sorted) t.y = clamp(t.y, minY, maxY);
    }
    return sorted.sort((a, b) => a.prio - b.prio);
  }

  function drawPaneTags(pane, T, items, to) {
    const it = items[0];
    if (!it) return [];
    const ln = it.res.lines.find((l) => l.style !== 'histogram') || it.res.lines[0];
    if (!ln) return [];
    for (let i = Math.min(to, ln.values.length - 1); i >= Math.max(0, to - 3); i--) {
      if (!fin(ln.values[i])) continue;
      const col = colorOf(it, 0, T), yy = pane.yv(ln.values[i]);
      if (!fin(yy)) return [];
      const ty = clamp(yy, pane.top + 9, pane.top + pane.h - 9);
      tag(L.plotR + 1, ty, fmtInd(ln.values[i]), col, inkOn(col), 'left', T);
      return [ty];
    }
    return [];
  }

  /* ---- drawings ---------------------------------------------------------------------- */
  function ptXY(pt) { return { x: xOf(idxOfT(pt.t)), y: L.panes[0].yv(pt.p) }; }
  function drawDrawings(pane, T) {
    const list = draft ? drawings.concat([draft]) : drawings;
    for (const d of list) drawOne(d, pane, T, d.id === selectedId || d === draft);
    if (measure) drawMeasure(measure, pane, T);
  }
  function drawOne(d, pane, T, sel) {
    const col = d.color || T.accent;
    const pts = d.points.map(ptXY);
    if (pts.some((p) => !fin(p.x) || !fin(p.y))) return;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 1.8 : 1.4; ctx.setLineDash([]);
    const [a, b] = pts;
    switch (d.type) {
      case 'hline':
        hLine(0, L.plotR, a.y, col, [], sel ? 1.8 : 1.2);
        break;
      case 'trend':
        if (!b) break;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        break;
      case 'ray': {
        if (!b) break;
        const e = extend(a, b);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(e.x, e.y); ctx.stroke();
        break;
      }
      case 'rect':
        if (!b) break;
        ctx.fillStyle = hexA(col, 0.1);
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        break;
      case 'fib': {
        if (!b) break;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x, x0 + 40);
        const pA = d.points[0].p, pB = d.points[1].p;
        ctx.font = '10px ' + T.font; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        let prevY = null;
        FIB_LEVELS.forEach((lv, k) => {
          const price = pB + (pA - pB) * lv;
          const yy = pane.yv(price);
          if (!fin(yy)) return;
          if (prevY != null) { ctx.fillStyle = hexA(T.series[k % T.series.length], 0.06); ctx.fillRect(x0, Math.min(prevY, yy), x1 - x0, Math.abs(yy - prevY)); }
          prevY = yy;
          hLine(x0, x1, yy, hexA(col, lv === 0 || lv === 1 ? 0.95 : 0.65), [], 1);
          ctx.fillStyle = col;
          ctx.fillText(lv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '  ' + fmtP(price), x0 + 3, yy - 1);
        });
        ctx.setLineDash([3, 3]); ctx.strokeStyle = hexA(col, 0.5);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'text': {
        const text = d.text || i18nT('Note');
        ctx.font = '12px ' + (theme().font);
        const w = ctx.measureText(text).width + 12;
        ctx.fillStyle = hexA(T.bg, 0.85);
        roundRect(a.x, a.y - 20, w, 20, 4); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = sel ? 1.6 : 1; ctx.stroke();
        ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        ctx.fillText(text, a.x + 6, a.y - 10);
        break;
      }
    }
    if (sel && d.type !== 'text') {
      for (const p of pts) {
        ctx.fillStyle = T.bg; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.rect(Math.round(p.x) - 4.5, Math.round(p.y) - 4.5, 9, 9); ctx.fill(); ctx.stroke();
      }
    }
  }
  function extend(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 1e-6) return { x: a.x, y: dy > 0 ? H : 0 };
    const tEdge = ((dx > 0 ? L.plotR : 0) - a.x) / dx;
    return { x: a.x + dx * tEdge, y: a.y + dy * tEdge };
  }
  function drawMeasure(m, pane, T) {
    const [a, b] = m.points.map(ptXY);
    if (!b || ![a.x, a.y, b.x, b.y].every(fin)) return;
    const up = m.points[1].p >= m.points[0].p, col = up ? T.up : T.down;
    ctx.fillStyle = hexA(col, 0.12);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    const dp = m.points[1].p - m.points[0].p, pct = m.points[0].p ? (dp / m.points[0].p) * 100 : null;
    const nb = Math.round(idxOfT(m.points[1].t) - idxOfT(m.points[0].t));
    const text = (dp >= 0 ? '+' : '−') + fmtP(Math.abs(dp)) + '  (' + fmtPct(pct) + ')  ·  ' + nb + ' ' + i18nT('bars') + '  ·  ' + fmtDur(Math.abs(m.points[1].t - m.points[0].t));
    ctx.font = '600 11px ' + T.font;
    const w = ctx.measureText(text).width + 14;
    const bx = clamp((a.x + b.x) / 2 - w / 2, 4, L.plotR - w - 4), by = clamp(Math.min(a.y, b.y) - 26, pane.top + 4, pane.top + pane.h - 24);
    ctx.fillStyle = col; roundRect(bx, by, w, 20, 4); ctx.fill();
    ctx.fillStyle = inkOn(col); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(text, bx + 7, by + 10.5);
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    const d = Math.round(h / 24);
    return d < 60 ? d + 'd' : d < 730 ? Math.round(d / 30.4) + 'mo' : (d / 365.25).toFixed(1) + 'y';
  }

  // distance from point to segment
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function hitDrawing(p) {
    if (!L || !L.panes[0].yv) return null;
    for (let k = drawings.length - 1; k >= 0; k--) {
      const d = drawings[k];
      const pts = d.points.map(ptXY);
      if (pts.some((q) => !fin(q.x) || !fin(q.y))) continue;
      // handles first, so a selected endpoint can be grabbed
      if (d.id === selectedId) for (let h = 0; h < pts.length; h++) if (Math.abs(p.x - pts[h].x) <= HIT && Math.abs(p.y - pts[h].y) <= HIT) return { d, handle: h };
      const [a, b] = pts;
      let hit = false;
      switch (d.type) {
        case 'hline': hit = Math.abs(p.y - a.y) <= HIT; break;
        case 'trend': hit = b && segDist(p, a, b) <= HIT; break;
        case 'ray': hit = b && segDist(p, a, extend(a, b)) <= HIT; break;
        case 'rect': hit = b && p.x >= Math.min(a.x, b.x) - HIT && p.x <= Math.max(a.x, b.x) + HIT && p.y >= Math.min(a.y, b.y) - HIT && p.y <= Math.max(a.y, b.y) + HIT; break;
        case 'fib': hit = b && p.x >= Math.min(a.x, b.x) - HIT && p.x <= Math.max(a.x, b.x, Math.min(a.x, b.x) + 40) + HIT
          && FIB_LEVELS.some((lv) => Math.abs(p.y - L.panes[0].yv(d.points[1].p + (d.points[0].p - d.points[1].p) * lv)) <= HIT); break;
        case 'text': { ctx.font = '12px ' + theme().font; const w = ctx.measureText(d.text || 'Note').width + 12; hit = p.x >= a.x && p.x <= a.x + w && p.y >= a.y - 20 && p.y <= a.y; break; }
      }
      if (hit) return { d, handle: null };
    }
    return null;
  }
  function hitLevel(p) {
    if (!L || !L.panes[0].yv || p.x > L.plotR) return null;
    for (const l of levels) {
      if (!l.draggable || !fin(l.price)) continue;
      if (Math.abs(L.panes[0].yv(l.price) - p.y) <= HIT) return l;
    }
    return null;
  }
  function emitDrawings() { if (opts.onDrawingsChange) opts.onDrawingsChange(drawings.map((d) => JSON.parse(JSON.stringify(d)))); }
  function dataPoint(p, snap = true) {
    const idx = snap ? clamp(Math.round(idxAt(p.x)), -50, last() + 500) : idxAt(p.x);
    return { t: tOfIdx(idx), p: +L.panes[0].inv(p.y).toPrecision(10) };
  }

  /* ---- crosshair ----------------------------------------------------------------------- */
  function drawCrosshair(T, idx) {
    if (idx == null || !L) return;
    const x = crisp(xOf(idx));
    const syncedOnly = !hover;
    ctx.save();
    ctx.strokeStyle = hexA(T.cross, syncedOnly ? 0.45 : 0.75); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.timeTop); ctx.stroke();
    if (hover && hover.y < L.timeTop && hover.x <= L.plotR) {
      const yy = crisp(hover.y);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(L.plotR, yy); ctx.stroke();
      ctx.setLineDash([]);
      const pane = paneAt(hover.y);
      if (pane && pane.inv) {
        const v = pane.inv(hover.y);
        const text = pane.key === 'main' ? (isPct() ? fmtPct((v / L.base - 1) * 100) : fmtP(v)) : fmtInd(v);
        tag(L.plotR + 1, hover.y, text, T.textSec, inkOn(T.textSec), 'left', T);
      }
    }
    ctx.setLineDash([]);
    // time tag
    const t = bars[idx] ? bars[idx].t : tOfIdx(idx);
    ctx.font = '600 11px ' + T.font;
    const text = fullTime(t), w = ctx.measureText(text).width + 12;
    const bx = clamp(x - w / 2, 0, L.plotR - w);
    ctx.fillStyle = T.textSec; roundRect(bx, L.timeTop + 3, w, AXIS_H - 6, 3); ctx.fill();
    ctx.fillStyle = inkOn(T.textSec); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + w / 2, L.timeTop + AXIS_H / 2 + 0.5);
    ctx.restore();
  }
  function paneAt(y) { return L && L.panes.find((p) => y >= p.top && y < p.top + p.h); }

  /* ---- legends (DOM; patched, not rebuilt) ---------------------------------------------- */
  let legendSig = '', legendRefs = new Map();
  function paintLegends(T, crossIdx) {
    const sig = L.panes.map((p) => p.key).join('|') + '#' + computed.map((c) => c.spec.id + JSON.stringify(c.spec.params || {}) + c.paneKey).join('|') + '#' + compare.map((c) => c.symbol).join(',');
    if (sig !== legendSig) {
      legendSig = sig;
      legends.textContent = '';
      legendRefs = new Map();
      for (const pane of L.panes) {
        const box = el('div', 'cc-legend' + (pane.key === 'main' ? ' cc-legend-main' : ''));
        const ref = { box, rows: [] };
        if (pane.key === 'main') {
          const head = el('div', 'cc-lg-head');
          ref.sym = el('span', 'cc-lg-sym'); ref.meta = el('span', 'cc-lg-meta');
          head.append(ref.sym, ref.meta);
          const ohlc = el('div', 'cc-lg-ohlc');
          ref.ohlc = {};
          for (const k of ['O', 'H', 'L', 'C']) {
            const lab = el('span', 'cc-lg-k', k), val = el('span', 'cc-lg-v');
            ohlc.append(lab, val); ref.ohlc[k] = val;
          }
          ref.chg = el('span', 'cc-lg-chg');
          const vk = el('span', 'cc-lg-k', 'V'); ref.vol = el('span', 'cc-lg-v');
          ohlc.append(ref.chg, vk, ref.vol);
          ref.volK = vk;
          box.append(head, ohlc);
          compare.forEach((c) => {
            const row = el('div', 'cc-lg-row');
            const sw = el('i', 'cc-sw'), name = el('span', 'cc-lg-name', c.symbol), val = el('span', 'cc-lg-v');
            row.append(sw, name, val); box.append(row);
            ref.rows.push({ kind: 'cmp', c, sw, vals: [val] });
          });
        }
        for (const it of computed.filter((c) => c.paneKey === pane.key)) {
          const row = el('div', 'cc-lg-row');
          const sw = el('i', 'cc-sw');
          const params = it.def.params.map((p) => (it.spec.params && it.spec.params[p.key] != null ? it.spec.params[p.key] : p.def)).join(' ');
          const name = el('span', 'cc-lg-name', it.def.short + (params ? ' ' + params : ''));
          name.title = i18nT(it.def.label);
          row.append(sw, name);
          const vals = it.res.lines.filter((l) => !(l.step)).slice(0, 5).map((l) => { const v = el('span', 'cc-lg-v'); row.append(v); return { l, v }; });
          box.append(row);
          ref.rows.push({ kind: 'ind', it, sw, vals });
        }
        legends.append(box);
        legendRefs.set(pane.key, ref);
      }
    }
    const idx = crossIdx != null ? crossIdx : bars.length - 1;
    for (const pane of L.panes) {
      const ref = legendRefs.get(pane.key);
      if (!ref) continue;
      ref.box.style.top = Math.round(pane.top + (pane.key === 'main' ? 6 : 3)) + 'px';
      ref.box.style.maxWidth = Math.max(80, L.plotR - 16) + 'px';
      if (pane.key === 'main') {
        setText(ref.sym, meta.symbol || '');
        setText(ref.meta, [i18nT(INTERVAL_LABEL[meta.interval] || meta.interval || ''), meta.source].filter(Boolean).join(' · '));
        const b = bars[idx];
        const prevC = idx > 0 && bars[idx - 1] ? bars[idx - 1].c : b ? b.o : null;
        for (const k of ['O', 'H', 'L', 'C']) setText(ref.ohlc[k], b ? fmtNum(b[k.toLowerCase()], priceDecimals(b.c)) : '—');
        if (b && fin(prevC) && prevC) {
          const ch = b.c - prevC;
          setText(ref.chg, (ch >= 0 ? '+' : '−') + fmtNum(Math.abs(ch), priceDecimals(b.c)) + ' (' + fmtPct((ch / prevC) * 100) + ')');
          ref.chg.dataset.dir = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat';
        } else setText(ref.chg, '');
        const hv = b && fin(b.v);
        ref.volK.hidden = !hv; ref.vol.hidden = !hv;
        if (hv) setText(ref.vol, fmtVolume(b.v));
      }
      for (const r of ref.rows) {
        if (r.kind === 'cmp') {
          const k = compare.indexOf(r.c);
          r.sw.style.background = T.series[(k + 1) % T.series.length];
          const v = r.c.values[idx], base = L.cmpBase[k];
          setText(r.vals[0], fin(v) && fin(base) ? fmtPct((v / base - 1) * 100) : '—');
          continue;
        }
        r.sw.style.background = colorOf(r.it, 0, T);
        let j = 0;
        for (const { l, v } of r.vals) {
          const sh = l.shift || 0;
          const val = l.values[idx - sh];
          const isPrice = r.it.def.kind === 'overlay';
          setText(v, fin(val) ? (isPrice ? fmtP(val) : l.key === 'vol' ? fmtVolume(val) : fmtInd(val)) : '—');
          v.style.color = l.tone === 'up' ? T.up : l.tone === 'down' ? T.down : l.style === 'histogram' ? (fin(val) && val < 0 ? T.down : T.up)
            : (l.style === 'band-upper' || l.style === 'band-lower') ? hexA(colorOf(r.it, 0, T), 0.75) : colorOf(r.it, j++, T);
        }
      }
    }
  }

  let chipSig = '';
  function paintChips() {
    const list = [];
    if (meta.isDemo) list.push(['demo', i18nT('Demo data'), i18nT('Synthetic prices for trying the tool — not market data.')]);
    if (meta.stale) list.push(['stale', i18nT('Stale'), i18nT('The provider could not refresh these bars, so the last good copy is shown.')]);
    if (meta.partial) list.push(['partial', i18nT('Partial'), meta.note || i18nT('The provider returned less history or detail than this range asks for.')]);
    else if (meta.note) list.push(['note', i18nT('Note'), meta.note]);
    if (meta.feed === 'iex') list.push(['feed', 'IEX', i18nT('Bars from the IEX exchange only — a small share of US volume, so highs, lows and volume can differ from the consolidated tape.')]);
    else if (meta.source && meta.source !== 'demo') {
      // The source names itself; its timeliness is the tooltip, because "Delayed"
      // on a feed that is real-time for some symbols would itself be a guess.
      list.push(['src', SOURCE_LABEL[meta.source] || meta.source, i18nT('Bars from') + ' ' + (SOURCE_LABEL[meta.source] || meta.source) + (meta.delayed ? ' · ' + meta.delayed : '')]);
    }
    if (type === 'heikin') list.push(['ha', i18nT('Heikin-Ashi'), i18nT('Smoothed candles — not traded prices. The legend shows real OHLC.')]);
    if (logScale) list.push(['mode', i18nT('Log'), i18nT('Logarithmic price scale')]);
    if (isPct()) list.push(['mode', '%', i18nT('Percent change from the first visible bar')]);
    if (readOnly) list.push(['mode', i18nT('Read-only'), '']);
    const sig = JSON.stringify(list);
    if (sig === chipSig) { chips.style.right = (L ? L.axisW + 8 : 60) + 'px'; return; }
    chipSig = sig;
    chips.textContent = '';
    for (const [kind, text, title] of list) {
      const c = el('span', 'cc-chip cc-chip-' + kind, text);
      if (title) c.title = title;
      chips.append(c);
    }
    chips.style.right = (L ? L.axisW + 8 : 60) + 'px';
  }

  function emitView(from, to) {
    if (!opts.onViewChange || !bars.length || to < from) return;
    const sig = bars[from].t + ':' + bars[to].t;
    if (sig === lastView) return;
    lastView = sig;
    try { opts.onViewChange({ from: bars[from].t, to: bars[to].t }); } catch (e) { /* host error is not a chart error */ }
  }

  function ariaSummary() {
    const n = bars.length;
    if (!n) { canvas.setAttribute('aria-label', i18nT('Price chart') + (meta.symbol ? ' — ' + meta.symbol : '') + ': ' + i18nT('no data')); return; }
    const a = bars[0], b = bars[n - 1];
    const ch = a.c ? (b.c / a.c - 1) * 100 : null;
    const d = (t) => { try { return dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(t); } catch (e) { return ''; } };
    let hi = -Infinity, lo = Infinity;
    for (const x of bars) { if (fin(x.h) && x.h > hi) hi = x.h; if (fin(x.l) && x.l < lo) lo = x.l; }
    const parts = [
      (meta.symbol || '') + ' ' + i18nT(INTERVAL_LABEL[meta.interval] || '') + ' ' + i18nT('chart') + ':',
      n + ' ' + i18nT('bars from') + ' ' + d(a.t) + ' ' + i18nT('to') + ' ' + d(b.t) + '.',
      i18nT('Last') + ' ' + fmtNum(b.c, priceDecimals(b.c)) + ', ' + fmtPct(ch) + ' ' + i18nT('over the period') + '.',
      i18nT('Range') + ' ' + fmtNum(lo, priceDecimals(lo)) + '–' + fmtNum(hi, priceDecimals(hi)) + '.',
    ];
    if (meta.isDemo) parts.push(i18nT('Demo data, not market prices.'));
    canvas.setAttribute('aria-label', parts.join(' '));
  }

  /* ---- context menu ---------------------------------------------------------------------- */
  function openMenu(p) {
    if (!L || !bars.length) return;
    const pane = paneAt(p.y);
    menu.textContent = '';
    const items = [];
    const hit = hitDrawing(p);
    if (pane && pane.key === 'main' && p.x <= L.plotR) {
      const price = pane.inv(p.y);
      const ptxt = fmtP(price);
      if (opts.onRequestAlert) items.push([i18nT('Alert at') + ' ' + ptxt, () => opts.onRequestAlert(+price.toPrecision(10))]);
      if (!readOnly) items.push([i18nT('Add horizontal line'), () => addDrawing({ id: uid(), type: 'hline', points: [{ t: tOfIdx(Math.round(idxAt(p.x))), p: +price.toPrecision(10) }] })]);
    }
    if (hit && !readOnly) items.push([i18nT('Delete drawing'), () => deleteDrawing(hit.d.id)]);
    if (drawings.length && !readOnly) items.push([i18nT('Remove all drawings'), () => { drawings = []; selectedId = null; emitDrawings(); schedule(); }]);
    items.push([i18nT('Reset view'), resetView]);
    for (const [label, fn] of items) {
      const b = el('button', 'cc-menu-item', label);
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => { closeMenu(); fn(); canvas.focus({ preventScroll: true }); });
      menu.append(b);
    }
    menu.hidden = false;
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 120;
    menu.style.left = clamp(p.x, 4, W - mw - 4) + 'px';
    menu.style.top = clamp(p.y, 4, H - mh - 4) + 'px';
    const first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() { menu.hidden = true; }
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button')], i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); canvas.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
  });
  const onDocDown = (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); };
  document.addEventListener('pointerdown', onDocDown, true);

  /* ---- drawing edits -------------------------------------------------------------------- */
  function addDrawing(d) {
    if (drawings.length >= MAX_DRAWINGS) drawings.shift();
    drawings.push(d);
    selectedId = d.id;
    emitDrawings();
    schedule();
  }
  function deleteDrawing(id) {
    const n = drawings.length;
    drawings = drawings.filter((d) => d.id !== id);
    if (selectedId === id) selectedId = null;
    if (drawings.length !== n) emitDrawings();
    schedule();
  }
  function setToolInternal(t, notify) {
    tool = TOOLS.includes(t) && !readOnly ? t : null;
    draft = null;
    root.classList.toggle('cc-drawing', !!tool);
    if (notify && opts.onToolChange) opts.onToolChange(tool);
    schedule();
  }
  function editText(d, isNew) {
    if (textEdit) textEdit.remove();
    const p = ptXY(d.points[0]);
    const input = el('input', 'cc-text-edit');
    input.type = 'text'; input.maxLength = 120; input.value = d.text || '';
    input.placeholder = i18nT('Note');
    input.setAttribute('aria-label', i18nT('Note text'));
    input.style.left = clamp(p.x, 0, W - 160) + 'px';
    input.style.top = clamp(p.y - 22, 0, H - 24) + 'px';
    root.append(input);
    textEdit = input;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove(); textEdit = null;
      if (commit && v) { d.text = v; if (isNew) addDrawing(d); else emitDrawings(); }
      else if (!isNew && commit && !v) deleteDrawing(d.id);
      schedule();
      canvas.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.focus({ preventScroll: true });
    setTimeout(() => { if (textEdit === input) input.focus({ preventScroll: true }); }, 0);
  }

  /* ---- pointer input ---------------------------------------------------------------------- */
  function local(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function sepAt(p) {
    if (!L) return null;
    for (let i = 1; i < L.panes.length; i++) if (Math.abs(p.y - L.panes[i].top) <= 4) return i;
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!L || state !== 'ready' && !bars.length) return;
    if (e.button === 2) return;   // contextmenu handles it
    const p = local(e);
    touches.set(e.pointerId, p);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is best effort */ }
    canvas.focus({ preventScroll: true });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      clearTimeout(longTimer);
      gesture = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: (a.x + b.x) / 2 };
      return;
    }
    measure = null;
    const isTouch = e.pointerType === 'touch';
    // Touch has no right button: a long press that has not moved opens the
    // context menu, whether it started on empty chart, a drawing or a level.
    if (isTouch) {
      clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        const g = gesture;
        const still = g && ((g.mode === 'pan' && g.moved < 8) || ((g.mode === 'move' || g.mode === 'handle') && !g.moved)
          || (g.mode === 'level' && levelDrag && levelDrag.price === g.level.price));
        if (!still) return;
        gesture = null; levelDrag = null; hover = p; schedule(); openMenu(p);
      }, LONG_PRESS);
    }
    const sep = sepAt(p);
    if (sep != null) { gesture = { mode: 'sep', i: sep, y0: p.y, h0: [L.panes[sep - 1].h, L.panes[sep].h] }; return; }
    const pane = paneAt(p.y);
    if (pane && p.x > L.plotR) {
      gesture = { mode: 'axis', pane, y0: p.y, lo: pane.lo, hi: pane.hi };
      return;
    }
    if (p.y >= L.timeTop) { gesture = { mode: 'pan', x0: p.x, last: p.x, moved: 0 }; return; }
    if (tool && pane && pane.key === 'main') {
      const pt = dataPoint(p, tool !== 'measure');
      if (draft && draft.pendingSecond) {
        draft.points[1] = pt;
        commitDraft();
        return;
      }
      if (ONE_CLICK[tool]) {
        // the note's input takes focus; the mousedown that would hand it back
        // to the canvas is suppressed
        if (tool === 'text') e.preventDefault();
        const d = { id: uid(), type: tool, points: [pt] };
        if (tool === 'text') editText(d, true); else addDrawing(d);
        setToolInternal(opts.stickyTools ? tool : null, true);
        return;
      }
      draft = { id: uid(), type: tool, points: [pt, { ...pt }] };
      gesture = { mode: 'draw', x0: p.x, y0: p.y };
      schedule();
      return;
    }
    if (!readOnly && pane && pane.key === 'main') {
      const hit = hitDrawing(p);
      // On touch a finger brushing past a line must not drag it: an unselected
      // drawing is selected by a tap, and only a selected one moves.
      if (hit && isTouch && hit.d.id !== selectedId) {
        gesture = { mode: 'pan', x0: p.x, y0: p.y, last: p.x, lastY: p.y, moved: 0, touch: true, tapSelect: hit.d.id };
        return;
      }
      if (hit) {
        selectedId = hit.d.id;
        gesture = { mode: hit.handle != null ? 'handle' : 'move', d: hit.d, handle: hit.handle, start: dataPoint(p, false), orig: JSON.parse(JSON.stringify(hit.d.points)), moved: false, p0: p };
        schedule();
        return;
      }
      const lv = hitLevel(p);
      if (lv) { gesture = { mode: 'level', level: lv }; levelDrag = { level: lv, price: lv.price }; return; }
    }
    if (selectedId) { selectedId = null; schedule(); }

    gesture = { mode: 'pan', x0: p.x, y0: p.y, last: p.x, lastY: p.y, moved: 0, touch: isTouch };
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
    if (!L) return;
    const g = gesture;
    if (g && g.mode === 'pinch' && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(Math.min(L.plotR, (a.x + b.x) / 2), dist / g.dist);
      g.dist = dist;
      return;
    }
    if (!g) {
      if (e.pointerType !== 'touch' || pinned) { hover = p; emitCrosshair(); }
      updateCursor(p);
      if (draft && draft.pendingSecond) draft.points[1] = dataPoint(p, tool !== 'measure');
      schedule();
      return;
    }
    switch (g.mode) {
      case 'pan': {
        const dx = p.x - g.last;
        g.moved += Math.abs(dx) + Math.abs(p.y - (g.lastY || p.y));
        g.last = p.x;
        if (dx) panBy(dx);
        const man = manual.get('main');
        if (man && g.lastY != null && paneAt(g.y0) === L.panes[0]) {
          const ds = ((p.y - g.lastY) / L.panes[0].innerH) * (man.hi - man.lo);
          manual.set('main', { lo: man.lo + ds, hi: man.hi + ds });
        }
        g.lastY = p.y;
        if (e.pointerType !== 'touch') hover = p;
        schedule();
        break;
      }
      case 'draw':
        draft.points[1] = dataPoint(p, tool !== 'measure');
        schedule();
        break;
      case 'handle': case 'move': {
        const now = dataPoint(p, false);
        if (Math.abs(p.x - g.p0.x) + Math.abs(p.y - g.p0.y) > 2) g.moved = true;
        if (!g.moved) break;
        if (g.mode === 'handle') {
          g.d.points[g.handle] = dataPoint(p, true);
        } else {
          const dIdx = Math.round(idxOfT(now.t) - idxOfT(g.start.t)), dp = now.p - g.start.p;
          g.d.points = g.orig.map((q) => ({ t: tOfIdx(Math.round(idxOfT(q.t)) + dIdx), p: +(q.p + dp).toPrecision(10) }));
        }
        schedule();
        break;
      }
      case 'level':
        levelDrag.price = +L.panes[0].inv(p.y).toPrecision(10);
        schedule();
        break;
      case 'sep': {
        const dy = p.y - g.y0, i = g.i;
        const a = clamp(g.h0[0] + dy, MIN_PANE, g.h0[0] + g.h0[1] - MIN_PANE), b = g.h0[0] + g.h0[1] - a;
        // convert to weights relative to the main pane's current weight
        const mainH = i - 1 === 0 ? a : L.panes[0].h;
        const mw = weights.get('main') || 1;
        const keyA = L.panes[i - 1].key, keyB = L.panes[i].key;
        if (keyA === 'main') { weights.set(keyB, (b / a) * mw); }
        else { weights.set(keyA, (a / mainH) * mw); weights.set(keyB, (b / mainH) * mw); }
        schedule();
        break;
      }
      case 'axis': {
        const f = Math.exp((p.y - g.y0) / 120);
        const mid = (g.lo + g.hi) / 2, half = ((g.hi - g.lo) / 2) * f;
        manual.set(g.pane.key, { lo: mid - half, hi: mid + half });
        schedule();
        break;
      }
    }
  });

  function endPointer(e) {
    touches.delete(e.pointerId);
    clearTimeout(longTimer);
    const g = gesture;
    if (g && g.mode === 'pinch') { if (touches.size < 2) gesture = null; return; }
    gesture = null;
    if (!g) return;
    const p = local(e);
    if (g.mode === 'draw' && draft) {
      if (Math.hypot(p.x - g.x0, p.y - g.y0) > 6) commitDraft();
      else { draft.pendingSecond = true; schedule(); }
    } else if ((g.mode === 'handle' || g.mode === 'move') && g.moved) emitDrawings();
    else if (g.mode === 'level' && levelDrag) {
      const { level, price } = levelDrag;
      levelDrag = null;
      if (opts.onLevelDrag && price !== level.price) { try { opts.onLevelDrag(level, price); } catch (err) { console.error(err); } }
      schedule();
    } else if (g.mode === 'pan' && g.tapSelect && g.moved < 8) {
      selectedId = g.tapSelect;
      schedule();
    } else if (g.mode === 'pan' && g.touch && g.moved < 8) {
      // a tap toggles a pinned crosshair on touch screens
      pinned = !pinned || !hover;
      hover = pinned ? p : null;
      emitCrosshair();
      schedule();
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' || gesture) return;
    hover = null; emitCrosshair(); schedule();
  });

  function commitDraft() {
    const d = draft;
    draft = null;
    if (!d) return;
    delete d.pendingSecond;
    if (d.type === 'measure') measure = d;
    else addDrawing(d);
    setToolInternal(opts.stickyTools ? tool : null, true);
  }

  function updateCursor(p) {
    let c = tool ? 'crosshair' : 'crosshair';
    if (!tool && L) {
      if (sepAt(p) != null) c = 'row-resize';
      else if (p.x > L.plotR && p.y < L.timeTop) c = 'ns-resize';
      else if (p.y >= L.timeTop) c = 'ew-resize';
      else if (!readOnly && paneAt(p.y) === L.panes[0]) {
        const hit = hitDrawing(p);
        if (hit) c = hit.handle != null ? 'grab' : 'move';
        else if (hitLevel(p)) c = 'ns-resize';
      }
    }
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  }

  canvas.addEventListener('dblclick', (e) => {
    const p = local(e);
    if (!L) return;
    if (p.x > L.plotR) { const pane = paneAt(p.y); if (pane) manual.delete(pane.key); schedule(); return; }
    const hit = !readOnly && hitDrawing(p);
    if (hit && hit.d.type === 'text') { editText(hit.d, false); return; }
    resetView();
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = local(e);
    hover = p;
    openMenu(p);
  });

  canvas.addEventListener('wheel', (e) => {
    if (!L || !bars.length) return;
    const p = local(e);
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { panBy(-e.deltaX); return; }
    if (p.x > L.plotR) {
      const pane = paneAt(p.y);
      if (!pane) return;
      const f = Math.exp(e.deltaY / 500), mid = (pane.lo + pane.hi) / 2, half = ((pane.hi - pane.lo) / 2) * f;
      manual.set(pane.key, { lo: mid - half, hi: mid + half });
      schedule();
      return;
    }
    const factor = Math.exp(-e.deltaY / (e.deltaMode === 1 ? 20 : 400));
    zoomAt(Math.min(p.x, L.plotR), factor);
  }, { passive: false });

  canvas.addEventListener('keydown', (e) => {
    if (!bars.length) return;
    const k = e.key;
    let handled = true;
    if (k === '+' || k === '=') zoomAt(L ? L.plotR * 0.75 : 0, 1.25);
    else if (k === '-' || k === '_') zoomAt(L ? L.plotR * 0.75 : 0, 0.8);
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (e.shiftKey) panBy((k === 'ArrowLeft' ? 1 : -1) * (L ? L.plotR / 4 : 100));
      else {
        let i = hoverIdx();
        if (i == null) i = last(); else i = clamp(i + (k === 'ArrowLeft' ? -1 : 1), 0, last());
        const vis = L ? L.plotR / barW : 50;
        if (i > rightIdx - 1) rightIdx = i + 1;
        if (i < rightIdx - vis + 1) rightIdx = i + vis - 1;
        hover = null; syncedIdx = i; keyCross = true;
        emitCrosshairIdx(i);
        schedule();
      }
    } else if (k === 'Home') { rightIdx = (L ? L.plotR / barW : 50) - 1; clampView(); followLive = false; schedule(); }
    else if (k === 'End') { resetView(); }
    else if (k === 'Escape') {
      if (!menu.hidden) closeMenu();
      else if (draft || tool) { draft = null; setToolInternal(null, true); }
      else if (measure) measure = null;
      else if (selectedId) selectedId = null;
      else if (keyCross) { keyCross = false; syncedIdx = null; emitCrosshairIdx(null); }
      else handled = false;
      schedule();
    } else if ((k === 'Delete' || k === 'Backspace') && selectedId && !readOnly) deleteDrawing(selectedId);
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      const i = hoverIdx() != null ? hoverIdx() : last();
      const yv = L && L.panes[0].yv ? L.panes[0].yv(bars[i].c) : H / 2;
      openMenu({ x: L ? xOf(i) : W / 2, y: yv });
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });
  let keyCross = false;

  function emitCrosshair() { emitCrosshairIdx(hoverIdx()); }
  let lastCross = undefined;
  function emitCrosshairIdx(i) {
    if (!opts.onCrosshair || i === lastCross) return;
    lastCross = i;
    if (i == null || !bars[i]) { try { opts.onCrosshair(null); } catch (e) { /* host */ } return; }
    const values = {};
    for (const it of computed) {
      const o = {};
      for (const l of it.res.lines) o[l.key] = l.values[i - (l.shift || 0)] ?? null;
      values[it.spec.id + (it.paneKey !== 'main' ? ':' + it.paneKey.split(':')[1] : '')] = o;
    }
    try { opts.onCrosshair({ t: bars[i].t, bar: bars[i], values }); } catch (e) { /* host */ }
  }

  /* ---- observers ----------------------------------------------------------------------------- */
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => schedule()); ro.observe(root); }
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = () => schedule();
  if (mq && mq.addEventListener) mq.addEventListener('change', onScheme);

  /* ---- public API ------------------------------------------------------------------------------ */
  function setState(s, msg) {
    state = s || 'ready';
    stateMsg = msg || '';
    stateEl.hidden = state === 'ready';
    stateEl.dataset.state = state;
    stateEl.textContent = '';
    if (state !== 'ready') {
      if (state === 'loading') stateEl.append(el('span', 'cc-spinner'));
      stateEl.append(el('span', 'cc-state-msg', stateMsg || i18nT(state === 'loading' ? 'Loading chart…' : state === 'error' ? 'Chart data could not be loaded.' : 'No data for this range.')));
    }
    root.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  const api = {
    setData(d = {}) {
      const prevSym = meta.symbol, prevInt = meta.interval, prevLen = bars.length, wasLive = followLive;
      const clean = [];
      for (const b of Array.isArray(d.bars) ? d.bars : []) {
        if (!b || !fin(Number(b.t)) || !fin(Number(b.c))) continue;
        const c = Number(b.c);
        const o = fin(Number(b.o)) && b.o != null ? Number(b.o) : c;
        const h = fin(Number(b.h)) && b.h != null ? Number(b.h) : Math.max(o, c);
        const l = fin(Number(b.l)) && b.l != null ? Number(b.l) : Math.min(o, c);
        clean.push({ t: Number(b.t), o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: b.v == null || !fin(Number(b.v)) ? null : Number(b.v) });
      }
      clean.sort((a, b) => a.t - b.t);
      bars = clean;
      meta = { symbol: d.symbol || '', currency: d.currency || 'USD', interval: d.interval || '1d', isDemo: !!d.isDemo, source: d.source || '',
        // Provenance flags from market.candles(): shown as chips, never hidden.
        stale: !!d.stale, partial: !!d.partial, note: d.note ? String(d.note) : '', feed: d.feed || null, delayed: d.delayed || null };
      spacing = barSpacing(bars) || INTERVAL_MS[meta.interval] || DAY;
      disp = type === 'heikin' ? heikinAshi(bars) : bars;
      recompute();
      setCompareInternal(rawCompare);
      const same = prevSym === meta.symbol && prevInt === meta.interval && prevLen > 0;
      if (!same) { resetView(); }
      else if (wasLive) rightIdx += bars.length - prevLen;
      if (state === 'empty' || state === 'loading' || state === 'error') setState(bars.length ? 'ready' : 'empty');
      else if (!bars.length) setState('empty');
      ariaSummary();
      schedule();
    },
    // Merge a live tick into the last bar, or append a new one. Cheaper than
    // setData for the host and keeps the view following the live edge.
    updateBar(b) {
      if (!b || !fin(Number(b.c))) return;
      const n = bars.length;
      if (n && Number(b.t) === bars[n - 1].t) bars[n - 1] = { ...bars[n - 1], ...b };
      else if (!n || Number(b.t) > bars[n - 1].t) { bars.push({ o: b.c, h: b.c, l: b.c, v: null, ...b }); if (followLive) rightIdx += 1; }
      else return;
      disp = type === 'heikin' ? heikinAshi(bars) : bars;
      recompute();
      setCompareInternal(rawCompare);
      schedule();
    },
    setType(t) {
      type = ['candle', 'ohlc', 'heikin', 'line', 'area', 'baseline'].includes(t) ? t : 'candle';
      disp = type === 'heikin' ? heikinAshi(bars) : bars;
      schedule();
    },
    setIndicators(list) {
      specs = (Array.isArray(list) ? list : []).filter((s) => s && INDICATORS[s.id]).map((s) => ({ id: s.id, params: s.params || {}, color: s.color || null }));
      colorCounter = 0;
      recompute();
      schedule();
    },
    setLevels(list) { levels = (Array.isArray(list) ? list : []).filter((l) => l && fin(Number(l.price))).map((l) => ({ ...l, price: Number(l.price) })); schedule(); },
    setCompare(list) { rawCompare = Array.isArray(list) ? list.slice(0, 6) : []; setCompareInternal(rawCompare); manual.delete('main'); schedule(); },
    setLog(on) { logScale = !!on; manual.delete('main'); schedule(); },
    setPercent(on) { pctMode = !!on; manual.delete('main'); schedule(); },
    setVolume(on) { showVolume = !!on; recompute(); schedule(); },
    setDrawings(arr) {
      drawings = (Array.isArray(arr) ? arr : []).filter((d) => d && TOOLS.includes(d.type) && d.type !== 'measure' && Array.isArray(d.points) && d.points.length)
        .map((d) => JSON.parse(JSON.stringify(d)));
      if (selectedId && !drawings.some((d) => d.id === selectedId)) selectedId = null;
      schedule();
    },
    getDrawings() { return drawings.map((d) => JSON.parse(JSON.stringify(d))); },
    setTool(t) { setToolInternal(t, false); },
    setReadOnly(on) { readOnly = !!on; if (readOnly) setToolInternal(null, false); schedule(); },
    syncCrosshair(t) {
      if (t == null || !bars.length) syncedIdx = null;
      else { const i = Math.floor(idxOfT(t) + 1e-9); syncedIdx = i >= 0 && i <= last() ? i : null; }
      schedule();
    },
    setState(s, msg) { setState(s, msg); schedule(); },
    resetView,
    getView() { return L && bars.length ? { from: bars[L.from] && bars[L.from].t, to: bars[L.to] && bars[L.to].t } : null; },
    resize() { schedule(); },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onScheme);
      document.removeEventListener('pointerdown', onDocDown, true);
      clearTimeout(longTimer);
      root.remove();
    },
    element: root,
  };

  let rawCompare = [];
  function setCompareInternal(list) {
    const idxByT = new Map(bars.map((b, i) => [b.t, i]));
    compare = list.filter((c) => c && Array.isArray(c.bars) && c.bars.length).map((c) => {
      const values = new Array(bars.length).fill(null);
      for (const b of c.bars) { const i = idxByT.get(b.t); if (i != null && fin(Number(b.c))) values[i] = Number(b.c); }
      // forward-fill a single missing bar (one exchange's holiday), no more
      for (let i = 1; i < values.length; i++) if (values[i] == null && values[i - 1] != null && (i < 2 || values[i - 2] != null)) values[i] = values[i - 1];
      return { symbol: String(c.symbol || ''), values };
    });
  }

  setState('ready');
  ariaSummary();
  if (opts.data) api.setData(opts.data);
  schedule();
  return api;
}

// Exposed for hosts building toolbars: what exists, and its label for the UI.
export const CHART_TYPES = [
  { id: 'candle', label: 'Candles' }, { id: 'ohlc', label: 'OHLC bars' }, { id: 'heikin', label: 'Heikin-Ashi' },
  { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' }, { id: 'baseline', label: 'Baseline' },
];
export const DRAW_TOOLS = [
  { id: 'hline', label: 'Horizontal line' }, { id: 'trend', label: 'Trend line' }, { id: 'ray', label: 'Ray' },
  { id: 'rect', label: 'Rectangle' }, { id: 'fib', label: 'Fibonacci retracement' }, { id: 'text', label: 'Text note' },
  { id: 'measure', label: 'Measure' },
];
