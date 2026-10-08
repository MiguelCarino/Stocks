/* chartpanel.js — the toolbar-and-chart unit shared by the chart widget and the
   detail drawer.

   chart.js owns pixels and gestures and deliberately knows nothing about where
   bars come from or where drawings go. Everything between that engine and the
   app lives here, once, so the drawer and every chart tile offer the same
   controls and cannot drift: range and interval, chart type, the indicator
   picker, volume and log toggles, drawing tools, compare symbols, the level
   lines (alert rules, average cost, previous close, 52-week range, pivots), the
   live last bar, and crosshair sync between linked charts.

   It still never fetches on its own account. Every request goes through the
   deps the host hands it (deps().candles, which in the main window is the
   provider facade and in a detached panel is a cache reader), and every write
   goes back through deps too (saveDrawings, onLevelDrag), so the widget rule —
   readers that do not touch storage — holds for the code underneath it.

   An async load is guarded by a token: a range click, a symbol change or a
   destroy while a request is in flight makes its answer land nowhere, which is
   what stops a slow 1Y response from painting over the 1D chart the user
   switched to. */

import { createChart, CHART_TYPES, DRAW_TOOLS } from './chart.js';
import { INDICATORS, defaultParams, pivots } from './indicators.js';
import { RANGES, INTERVALS } from './providers/index.js';
import { levelAllows, levelLimit, helpIcon, learnIdFor } from './learn.js';

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);

const RANGE_IDS = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'];
const RANGE_BY_ID = Object.fromEntries(RANGES.map((r) => [r.id, r]));
const INTERVAL_BY_ID = Object.fromEntries(INTERVALS.map((i) => [i.id, i]));
const INTERVAL_SHORT = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1D', '1w': '1W', '1M': '1Mo' };
const TOOL_GLYPH = { hline: '─', trend: '╱', ray: '↗', rect: '▭', fib: 'Fib', text: 'T', measure: '⇕' };
const MAX_INDICATORS = 12;
const MAX_COMPARE = 8;

/* Presets are starting points that show what a family of indicators looks like,
   not a recommended setup — the picker says so in the same breath. */
export const INDICATOR_PRESETS = [
  { id: 'trend', label: 'Trend', list: [{ id: 'ema', params: { period: 20 } }, { id: 'ema', params: { period: 50 } }, { id: 'sma', params: { period: 200 } }] },
  { id: 'momentum', label: 'Momentum', list: [{ id: 'rsi', params: {} }, { id: 'macd', params: {} }] },
  { id: 'volatility', label: 'Volatility', list: [{ id: 'bb', params: {} }, { id: 'atr', params: {} }] },
  { id: 'clean', label: 'Clean', list: [] },
];

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { return fb; } };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const isIntraday = (iv) => !!(INTERVAL_BY_ID[iv] && INTERVAL_BY_ID[iv].intraday);
let panelSeq = 0;

/* Persisted state, with short keys because a widget's whole saved state must
   fit in 4000 characters alongside everything else it keeps. */
export function normalizeChartState(raw, defaults) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const ind = (Array.isArray(s.ind) ? s.ind : Array.isArray(d.indicators) ? d.indicators.map((x) => ({ id: x.id, p: x.params })) : [])
    .filter((x) => x && INDICATORS[x.id]).slice(0, MAX_INDICATORS)
    .map((x) => {
      const p = {};
      for (const def of INDICATORS[x.id].params) {
        const v = x.p && x.p[def.key];
        if (def.options) { if (def.options.some((o) => (o.id ?? o) === v)) p[def.key] = v; }
        else if (fin(Number(v))) p[def.key] = Number(v);
      }
      return { id: x.id, p };
    });
  const types = CHART_TYPES.map((t) => t.id);
  return {
    r: RANGE_BY_ID[s.r] ? s.r : '1D',
    i: INTERVAL_BY_ID[s.i] ? s.i : null,
    t: types.includes(s.t) ? s.t : (types.includes(d.type) ? d.type : 'candle'),
    ind,
    v: typeof s.v === 'boolean' ? s.v : (typeof d.volume === 'boolean' ? d.volume : true),
    lg: !!s.lg,
    cmp: (Array.isArray(s.cmp) ? s.cmp : []).filter((x) => typeof x === 'string' && /^[A-Z0-9.\-]{1,15}$/.test(x)).slice(0, MAX_COMPARE),
  };
}

/* mountChartPanel(host, {getDeps, state, onState, variant, compact})
   getDeps() is re-read on every call, so the host can hand in a fresh ctx per
   tick without the panel holding on to an old one. */
export function mountChartPanel(host, opts = {}) {
  const getDeps = typeof opts.getDeps === 'function' ? opts.getDeps : () => ({});
  const deps = () => safe(getDeps, {}) || {};
  const level = () => safe(() => deps().level, 'standard') || 'standard';
  const variant = opts.variant || 'widget';
  const id = 'cp' + (++panelSeq);
  let st = normalizeChartState(opts.state, opts.defaults);
  let sym = null;
  let token = 0, loadedAt = 0, lastRes = null, lastQuoteSig = '', lastLevelSig = '', drawSig = '', cmpSig = '';
  let destroyed = false, askedDaily = null;

  /* ---- DOM ------------------------------------------------------------------ */
  const root = el('div', 'cp-root cp-' + variant);
  const bar = el('div', 'cp-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', i18nT('Chart controls'));

  const rangeSeg = el('div', 'cp-seg');
  rangeSeg.setAttribute('role', 'group');
  rangeSeg.setAttribute('aria-label', i18nT('Range'));
  const rangeBtns = new Map();
  for (const r of RANGE_IDS) {
    const b = el('button', 'cp-btn cp-range', r);
    b.type = 'button';
    b.title = i18nT(RANGE_BY_ID[r] ? RANGE_BY_ID[r].label : r);
    b.addEventListener('click', () => { if (st.r === r) return; st.r = r; st.i = null; save(); paintBar(); load(); });
    rangeBtns.set(r, b);
    rangeSeg.appendChild(b);
  }

  const ivSel = el('select', 'cp-sel');
  ivSel.title = i18nT('Bar interval — how much time each candle covers');
  ivSel.setAttribute('aria-label', i18nT('Interval'));
  ivSel.addEventListener('change', () => { st.i = ivSel.value || null; save(); load(); });

  const typeSel = el('select', 'cp-sel');
  typeSel.title = i18nT('Chart type');
  typeSel.setAttribute('aria-label', i18nT('Chart type'));
  typeSel.addEventListener('change', () => { st.t = typeSel.value; save(); chart.setType(st.t); });

  const fxBtn = el('button', 'cp-btn cp-fx', 'ƒx');
  fxBtn.type = 'button';
  fxBtn.title = i18nT('Indicators');
  fxBtn.setAttribute('aria-haspopup', 'true');
  fxBtn.setAttribute('aria-expanded', 'false');
  const fxCount = el('span', 'cp-count', '');
  fxBtn.appendChild(fxCount);

  const volBtn = toggleBtn('Vol', 'Show volume bars');
  volBtn.addEventListener('click', () => { st.v = !st.v; save(); paintBar(); chart.setVolume(st.v); });
  const logBtn = toggleBtn('Log', 'Logarithmic price scale — equal distances are equal percentage moves');
  logBtn.addEventListener('click', () => { st.lg = !st.lg; save(); paintBar(); chart.setLog(st.lg); });

  const toolSeg = el('div', 'cp-seg cp-tools');
  toolSeg.setAttribute('role', 'group');
  toolSeg.setAttribute('aria-label', i18nT('Drawing tools'));
  const toolBtns = new Map();
  for (const t of DRAW_TOOLS) {
    const b = el('button', 'cp-btn cp-tool', TOOL_GLYPH[t.id] || t.id);
    b.type = 'button';
    b.dataset.tool = t.id;
    b.title = i18nT(t.label);
    b.setAttribute('aria-label', i18nT(t.label));
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; chart.setTool(on ? t.id : null); paintTool(on ? t.id : null); });
    toolBtns.set(t.id, b);
    toolSeg.appendChild(b);
  }
  const clearBtn = el('button', 'cp-btn cp-tool', '⌫');
  clearBtn.type = 'button';
  clearBtn.title = i18nT('Remove all drawings on this symbol');
  clearBtn.addEventListener('click', () => {
    if (!sym) return;
    const n = safe(() => (deps().drawingsFor(sym) || []).length, 0);
    if (!n) return;
    if (!confirm(i18nT('Remove all drawings on') + ' ' + sym + '?')) return;
    chart.setDrawings([]);
    persistDrawings([]);
  });
  toolSeg.appendChild(clearBtn);

  const cmpBox = el('div', 'cp-cmp');
  const cmpChips = el('span', 'cp-cmp-chips');
  const cmpInput = el('input', 'cp-cmp-in');
  cmpInput.type = 'text';
  cmpInput.placeholder = i18nT('+ Compare');
  cmpInput.title = i18nT('Overlay another symbol as percent change (Enter to add)');
  cmpInput.setAttribute('aria-label', i18nT('Compare with symbol'));
  cmpInput.autocomplete = 'off';
  cmpInput.spellcheck = false;
  cmpInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const s = String(cmpInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15);
    cmpInput.value = '';
    if (!s || s === sym || st.cmp.includes(s)) return;
    const cap = Math.min(MAX_COMPARE, levelLimit(level(), 'compare'));
    if (st.cmp.length >= cap) { cmpInput.placeholder = i18nT('Limit reached'); return; }
    st.cmp.push(s); save(); paintCompareChips(); loadCompare();
  });
  cmpBox.append(cmpChips, cmpInput);

  const more = el('span', 'cp-more field-note', '');
  more.hidden = true;

  bar.append(rangeSeg, ivSel, typeSel, fxBtn, volBtn, logBtn, toolSeg, cmpBox, more);

  const pop = el('div', 'cp-pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', i18nT('Indicators'));

  const chartHost = el('div', 'cp-chart');
  const note = el('p', 'cp-note field-note', '');
  note.hidden = true;
  root.append(bar, pop, chartHost, note);
  host.appendChild(root);

  /* ---- chart ------------------------------------------------------------------ */
  const chart = createChart(chartHost, {
    readOnly: !!opts.readOnly,
    onDrawingsChange: (arr) => persistDrawings(arr),
    onToolChange: (t) => paintTool(t),
    onRequestAlert: (price) => { const fn = deps().onRequestAlert; if (sym && typeof fn === 'function') fn(sym, price); },
    onLevelDrag: (lvl, price) => { const fn = deps().onLevelDrag; if (sym && typeof fn === 'function') fn(sym, lvl, price); },
    onCrosshair: (info) => { const bus = deps().linkBus; if (bus && typeof bus.emit === 'function') bus.emit(info ? info.t : null, id); },
  });
  chart.setType(st.t);
  chart.setVolume(st.v);
  chart.setLog(st.lg);
  applyIndicators();

  // Crosshair sync with the other charts on the workspace link. The bus may be
  // swapped when the widget is linked or unlinked, so the subscription follows it.
  let busRef = null, busOff = null;
  function syncBus() {
    const bus = deps().linkBus || null;
    if (bus === busRef) return;
    if (busOff) safe(busOff);
    busRef = bus; busOff = null;
    if (bus && typeof bus.on === 'function') {
      busOff = bus.on((t, src) => { if (src !== id) chart.syncCrosshair(t); });
    } else chart.syncCrosshair(null);
  }

  /* ---- indicator popover ------------------------------------------------------ */
  fxBtn.addEventListener('click', () => { if (pop.hidden) openPop(); else closePop(); });
  const onDocDown = (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== fxBtn && !fxBtn.contains(e.target)) closePop(); };
  document.addEventListener('pointerdown', onDocDown, true);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); fxBtn.focus(); } });

  function openPop() { renderPop(); pop.style.top = (bar.offsetTop + bar.offsetHeight + 4) + 'px'; pop.hidden = false; fxBtn.setAttribute('aria-expanded', 'true'); }
  function closePop() { pop.hidden = true; fxBtn.setAttribute('aria-expanded', 'false'); }

  function renderPop() {
    pop.textContent = '';
    const lv = level();
    const cap = Math.min(MAX_INDICATORS, levelLimit(lv, 'indicators'));
    const head = el('div', 'cp-pop-head');
    head.append(el('strong', null, i18nT('Indicators')), el('span', 'field-note', st.ind.length + ' / ' + (Number.isFinite(cap) ? cap : MAX_INDICATORS)));
    const x = el('button', 'icon-mini', '✕');
    x.type = 'button'; x.title = i18nT('Close'); x.addEventListener('click', closePop);
    head.append(el('span', 'spacer'), x);
    pop.appendChild(head);

    if (!st.ind.length) pop.appendChild(el('p', 'field-note', i18nT('No indicators on this chart. Add one below, or start from a preset.')));
    st.ind.forEach((spec, idx) => {
      const def = INDICATORS[spec.id];
      const row = el('div', 'cp-ind');
      const name = el('span', 'cp-ind-name', i18nT(def.label));
      row.appendChild(name);
      const lid = learnIdFor('indicators', spec.id);
      if (lid) row.appendChild(helpIcon(lid));
      const params = el('span', 'cp-ind-params');
      for (const p of def.params) {
        const lab = el('label', 'cp-param');
        lab.appendChild(el('span', null, i18nT(p.label || p.key)));
        let input;
        if (p.options) {
          input = el('select', 'cp-sel sm');
          for (const o of p.options) { const v = o.id ?? o; const op = el('option', null, i18nT(o.label || String(v))); op.value = v; input.appendChild(op); }
          input.value = spec.p[p.key] ?? p.def;
          input.addEventListener('change', () => { spec.p[p.key] = input.value; save(); applyIndicators(); });
        } else {
          input = el('input', 'cp-num');
          input.type = 'number';
          if (p.min != null) input.min = p.min;
          if (p.max != null) input.max = p.max;
          input.step = p.step != null ? p.step : 'any';
          input.value = spec.p[p.key] ?? p.def;
          input.addEventListener('change', () => {
            let v = Number(input.value);
            if (!fin(v)) v = p.def;
            if (p.min != null) v = Math.max(p.min, v);
            if (p.max != null) v = Math.min(p.max, v);
            input.value = v; spec.p[p.key] = v; save(); applyIndicators();
          });
        }
        lab.appendChild(input);
        params.appendChild(lab);
      }
      row.appendChild(params);
      const rm = el('button', 'icon-mini', '✕');
      rm.type = 'button';
      rm.title = i18nT('Remove');
      rm.setAttribute('aria-label', i18nT('Remove') + ' ' + i18nT(def.label));
      rm.addEventListener('click', () => { st.ind.splice(idx, 1); save(); applyIndicators(); renderPop(); paintBar(); });
      row.appendChild(rm);
      pop.appendChild(row);
    });

    const add = el('select', 'cp-sel cp-add');
    add.setAttribute('aria-label', i18nT('Add an indicator'));
    const first = el('option', null, st.ind.length >= cap ? i18nT('Limit reached for your experience level') : i18nT('＋ Add an indicator…'));
    first.value = '';
    add.appendChild(first);
    const allowAll = levelAllows(lv, 'chart.indicators.all');
    let locked = 0;
    for (const [kind, label] of [['overlay', 'On the price'], ['pane', 'Below the chart']]) {
      const g = el('optgroup');
      g.label = i18nT(label);
      for (const def of Object.values(INDICATORS)) {
        if (def.kind !== kind) continue;
        const ok = allowAll || levelAllows(lv, 'indicator.' + def.id);
        if (!ok) { locked++; continue; }
        const o = el('option', null, i18nT(def.label));
        o.value = def.id;
        g.appendChild(o);
      }
      add.appendChild(g);
    }
    add.disabled = st.ind.length >= cap;
    add.addEventListener('change', () => {
      const v = add.value;
      if (!v || !INDICATORS[v]) return;
      st.ind.push({ id: v, p: defaultParams(v) });
      save(); applyIndicators(); renderPop(); paintBar();
    });
    pop.appendChild(add);
    if (locked) pop.appendChild(el('p', 'field-note', locked + ' ' + i18nT('more indicators are available at the Standard and Pro experience levels (Settings).')));

    const pre = el('div', 'cp-presets');
    pre.appendChild(el('span', 'field-note', i18nT('Presets:')));
    for (const p of INDICATOR_PRESETS) {
      const b = el('button', 'cp-btn', i18nT(p.label));
      b.type = 'button';
      b.addEventListener('click', () => {
        st.ind = p.list.filter((x) => allowAll || levelAllows(lv, 'indicator.' + x.id)).slice(0, cap)
          .map((x) => ({ id: x.id, p: { ...defaultParams(x.id), ...x.params } }));
        save(); applyIndicators(); renderPop(); paintBar();
      });
      pre.appendChild(b);
    }
    pop.appendChild(pre);
    pop.appendChild(el('p', 'field-note cp-edu', i18nT('Indicators describe past prices. They are educational tools, not signals or advice.')));
  }

  function applyIndicators() {
    chart.setIndicators(st.ind.map((x) => ({ id: x.id, params: x.p })));
  }

  /* ---- toolbar paint ------------------------------------------------------------ */
  function toggleBtn(label, title) {
    const b = el('button', 'cp-btn cp-toggle', i18nT(label));
    b.type = 'button';
    b.title = i18nT(title);
    b.setAttribute('aria-pressed', 'false');
    return b;
  }

  function paintTool(t) {
    for (const [k, b] of toolBtns) {
      const on = k === t;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    }
  }

  let barSig = '';
  function paintBar() {
    const lv = level();
    for (const [r, b] of rangeBtns) { b.classList.toggle('active', r === st.r); b.setAttribute('aria-pressed', r === st.r ? 'true' : 'false'); }
    const spec = RANGE_BY_ID[st.r] || RANGE_BY_ID['1D'];
    const served = lastRes && lastRes.interval;
    const sig = [st.r, st.i, served, lv, st.t].join('|');
    if (sig !== barSig) {
      barSig = sig;
      ivSel.textContent = '';
      const auto = el('option', null, i18nT('Auto') + ' (' + (INTERVAL_SHORT[served || spec.interval] || spec.interval) + ')');
      auto.value = '';
      ivSel.appendChild(auto);
      for (const iv of spec.intervals || []) {
        const o = el('option', null, INTERVAL_SHORT[iv] || iv);
        o.value = iv;
        o.title = i18nT(INTERVAL_BY_ID[iv] ? INTERVAL_BY_ID[iv].label : iv);
        ivSel.appendChild(o);
      }
      ivSel.value = st.i && (spec.intervals || []).includes(st.i) ? st.i : '';
      typeSel.textContent = '';
      for (const t of CHART_TYPES) {
        if (!levelAllows(lv, 'chart.type.' + t.id) && t.id !== st.t) continue;
        const o = el('option', null, i18nT(t.label));
        o.value = t.id;
        typeSel.appendChild(o);
      }
      typeSel.value = st.t;
    }
    volBtn.setAttribute('aria-pressed', st.v ? 'true' : 'false'); volBtn.classList.toggle('active', st.v);
    logBtn.setAttribute('aria-pressed', st.lg ? 'true' : 'false'); logBtn.classList.toggle('active', st.lg);
    fxCount.textContent = st.ind.length ? ' ' + st.ind.length : '';
    // Tools a beginner is not offered yet are hidden, not disabled, and the bar
    // says where they are — a disabled control nobody explains reads as broken.
    const ro = !!opts.readOnly;
    const draw = !ro && levelAllows(lv, 'chart.drawings');
    const log = levelAllows(lv, 'chart.log') || st.lg;
    const cmp = !ro && (levelAllows(lv, 'chart.compare') || st.cmp.length > 0);
    toolSeg.hidden = !draw;
    logBtn.hidden = !log;
    cmpBox.hidden = !cmp;
    more.hidden = ro || (draw && log && cmp);
    more.textContent = more.hidden ? '' : i18nT('More tools at Standard level');
    more.title = i18nT('Drawing tools, log scale and compare appear at the Standard experience level. Change it in Settings.');
  }

  function paintCompareChips() {
    cmpChips.textContent = '';
    for (const s of st.cmp) {
      const c = el('span', 'cp-chip', s);
      const x = el('button', 'cp-chip-x', '✕');
      x.type = 'button';
      x.title = i18nT('Remove') + ' ' + s;
      x.addEventListener('click', () => { st.cmp = st.cmp.filter((v) => v !== s); save(); paintCompareChips(); loadCompare(); });
      c.appendChild(x);
      cmpChips.appendChild(c);
    }
  }

  function save() {
    if (typeof opts.onState === 'function') safe(() => opts.onState({ ...st, ind: st.ind.map((x) => ({ id: x.id, p: { ...x.p } })), cmp: st.cmp.slice() }));
  }

  /* ---- data ------------------------------------------------------------------- */
  async function load(silent) {
    if (destroyed) return;
    const my = ++token;
    if (!sym) { chart.setData({ bars: [], symbol: '' }); chart.setState('empty', i18nT('Link this chart to a symbol, or pin one to it.')); return; }
    const fn = deps().candles;
    if (typeof fn !== 'function') { chart.setState('empty', i18nT('Charts are drawn in the main window.')); return; }
    if (!silent) chart.setState('loading');
    let res = null;
    try { res = await fn(sym, { range: st.r, interval: st.i || undefined }); } catch (e) { res = { bars: [], error: String(e && e.message || e) }; }
    if (destroyed || my !== token) return;   // a newer request owns the chart now
    res = res || { bars: [] };
    // A private copy: the live-bar patch below edits the last bar in place, and
    // the provider may hand the same array to another chart of this symbol.
    res = { ...res, bars: (Array.isArray(res.bars) ? res.bars : []).map((b) => ({ ...b })) };
    lastRes = res;
    loadedAt = Date.now();
    const q = safe(() => deps().quoteFor(sym), null);
    chart.setData({ bars: res.bars || [], symbol: sym, currency: (q && q.currency) || 'USD', interval: res.interval || st.i || (RANGE_BY_ID[st.r] || {}).interval,
      isDemo: !!res.isDemo, source: res.source || '', stale: res.stale, partial: res.partial, note: res.note, feed: res.feed, delayed: res.delayed });
    if (!(res.bars || []).length) chart.setState(res.error ? 'error' : 'empty', res.error ? i18nT('Chart data could not be loaded.') + ' ' + res.error : '');
    else chart.setState('ready');
    paintNote(res);
    paintBar();
    lastQuoteSig = '';
    syncDrawings(true);
    paintLevels(true);
    applyTick();
    loadCompare();
  }

  async function loadCompare() {
    const fn = deps().candles;
    const list = st.cmp.slice();
    const sig = [sym, st.r, lastRes && lastRes.interval, list.join(',')].join('|');
    cmpSig = sig;
    if (!list.length || typeof fn !== 'function' || !sym) { chart.setCompare([]); return; }
    const out = await Promise.all(list.map((s) => Promise.resolve(fn(s, { range: st.r, interval: (lastRes && lastRes.interval) || st.i || undefined, priority: 1 })).then((r) => ({ symbol: s, bars: (r && r.bars) || [] })).catch(() => ({ symbol: s, bars: [] }))));
    if (destroyed || cmpSig !== sig) return;
    chart.setCompare(out);
  }

  function paintNote(res) {
    let txt = '';
    if (res.isDemo && res.error) txt = i18nT('Live bars were not available') + ' (' + res.error + ') — ' + i18nT('showing demo data instead.');
    else if (res.stale && res.error) txt = i18nT('Refresh failed') + ' (' + res.error + ') — ' + i18nT('showing the last bars that loaded.');
    else if (res.requestedInterval && res.interval && res.requestedInterval !== res.interval) txt = i18nT('This provider does not serve that interval for this range, so the chart uses') + ' ' + (INTERVAL_SHORT[res.interval] || res.interval) + '.';
    note.hidden = !txt;
    note.textContent = txt;
  }

  /* Levels are host data (rules, cost, fundamentals) plus pivots this panel can
     derive from bars it already holds. Re-sent only when they change, because a
     drag in progress must not be yanked back by a tick. */
  function paintLevels(force) {
    if (!sym) { chart.setLevels([]); return; }
    const host = safe(() => deps().levelsFor(sym), []) || [];
    // The 52-week range is a daily-chart reference; on an intraday chart it is
    // almost always far off-screen and only crowds the axis.
    const intraday = !!(lastRes && isIntraday(lastRes.interval));
    const list = host.filter((l) => !(intraday && (l.kind === 'high52' || l.kind === 'low52')));
    if (levelAllows(level(), 'chart.pivots') && lastRes && isIntraday(lastRes.interval)) {
      const prev = prevDayBar(sym, lastRes.bars || []);
      // No previous session in hand: ask the host for daily bars once (they
      // are cached and shared with the screener), and draw pivots when they land.
      if (!prev && askedDaily !== sym && typeof deps().dailyBars === 'function') {
        askedDaily = sym;
        Promise.resolve(deps().dailyBars(sym)).then(() => { if (!destroyed && sym) paintLevels(true); }).catch(() => {});
      }
      const pv = prev ? pivots(prev, 'classic') : null;
      if (pv) for (const k of ['P', 'R1', 'S1', 'R2', 'S2']) if (fin(pv[k])) list.push({ price: pv[k], label: k, kind: 'pivot' });
    }
    const sig = JSON.stringify(list.map((l) => [l.kind, l.label, l.price, l.id || '']));
    if (!force && sig === lastLevelSig) return;
    lastLevelSig = sig;
    chart.setLevels(list);
  }

  // The previous completed session's high/low/close: from the intraday bars when
  // they span more than one day, otherwise from the host's cached daily bars.
  function prevDayBar(s, bars) {
    const days = new Map();
    for (const b of bars) {
      const k = new Date(b.t).toISOString().slice(0, 10);
      const d = days.get(k);
      if (!d) days.set(k, { h: b.h, l: b.l, c: b.c, t: b.t });
      else { d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; }
    }
    const keys = [...days.keys()].sort();
    if (keys.length >= 2) return days.get(keys[keys.length - 2]);
    const daily = safe(() => deps().dailyFor(s), null);
    if (Array.isArray(daily) && daily.length >= 2) {
      const today = keys[0];
      const last = daily[daily.length - 1];
      const lastKey = new Date(last.t).toISOString().slice(0, 10);
      return lastKey === today ? daily[daily.length - 2] : last;
    }
    return null;
  }

  function persistDrawings(arr) {
    if (!sym) return;
    drawSig = JSON.stringify(arr || []);
    const fn = deps().saveDrawings;
    if (typeof fn === 'function') safe(() => fn(sym, arr || []));
  }

  // Another chart of the same symbol may have changed its drawings; adopt them
  // only when what storage holds differs from what this chart last saw.
  function syncDrawings(force) {
    if (!sym) return;
    const list = safe(() => deps().drawingsFor(sym), []) || [];
    const sig = JSON.stringify(list);
    if (!force && sig === drawSig) return;
    drawSig = sig;
    chart.setDrawings(list);
  }

  /* The live last bar. A quote moves the close (and stretches the high/low) of
     the bar it belongs to; a quote past that bar opens the next one, but only
     when it is the very next bucket — a gap of several bars means the session
     moved on, and the next refetch is the honest way to show it. */
  function applyTick() {
    if (!sym || !lastRes || !(lastRes.bars || []).length) return;
    const d = deps();
    if (lastRes.isDemo && typeof d.isDemoMode === 'function' && !d.isDemoMode()) return;   // no live ticks on sample bars
    const q = safe(() => d.quoteFor(sym), null);
    if (!q || !fin(q.price)) return;
    const qs = q.price + '|' + q.ts + '|' + q.volume;
    if (qs === lastQuoteSig) return;
    lastQuoteSig = qs;
    const bars = lastRes.bars;
    const lastBar = bars[bars.length - 1];
    const iv = lastRes.interval || '1d';
    const ms = INTERVAL_BY_ID[iv] ? INTERVAL_BY_ID[iv].ms : 86400000;
    const ts = fin(q.ts) ? q.ts : Date.now();
    if (!isIntraday(iv)) {
      if (iv !== '1d') {
        // Weekly/monthly: the last bar is still forming; only its close moves.
        chart.updateBar({ t: lastBar.t, c: q.price, h: Math.max(lastBar.h, q.price), l: Math.min(lastBar.l, q.price) });
        return;
      }
      const dayKey = new Date(ts).toISOString().slice(0, 10);
      const barKey = new Date(lastBar.t).toISOString().slice(0, 10);
      if (dayKey === barKey) {
        chart.updateBar({ t: lastBar.t, c: q.price, h: Math.max(lastBar.h, q.high ?? q.price, q.price), l: Math.min(lastBar.l, q.low ?? q.price, q.price), v: fin(q.volume) ? q.volume : lastBar.v });
      } else if (dayKey > barKey && ts - lastBar.t < 5 * 86400000) {
        const t = Date.parse(dayKey + 'T00:00:00Z');
        const nb = { t, o: fin(q.open) ? q.open : q.price, h: Math.max(q.high ?? q.price, q.price), l: Math.min(q.low ?? q.price, q.price), c: q.price, v: fin(q.volume) ? q.volume : null };
        bars.push(nb);
        chart.updateBar(nb);
      }
      return;
    }
    if (ts < lastBar.t) return;
    if (ts < lastBar.t + ms) {
      chart.updateBar({ t: lastBar.t, c: q.price, h: Math.max(lastBar.h, q.price), l: Math.min(lastBar.l, q.price) });
      lastBar.c = q.price; lastBar.h = Math.max(lastBar.h, q.price); lastBar.l = Math.min(lastBar.l, q.price);
    } else if (ts < lastBar.t + 2 * ms) {
      const nb = { t: lastBar.t + ms, o: q.price, h: q.price, l: q.price, c: q.price, v: null };
      bars.push(nb);
      chart.updateBar(nb);
    }
  }

  function refreshMs() {
    const iv = (lastRes && lastRes.interval) || '1d';
    if (!isIntraday(iv)) return 15 * 60000;
    return Math.max(60000, Math.min(5 * 60000, (INTERVAL_BY_ID[iv] ? INTERVAL_BY_ID[iv].ms : 60000)));
  }

  /* ---- API ------------------------------------------------------------------------ */
  paintBar();
  paintCompareChips();
  syncBus();

  return {
    root,
    chart,
    setSymbol(next) {
      const s = typeof next === 'string' && next ? next : null;
      if (s === sym) return;
      sym = s;
      lastRes = null; drawSig = ''; lastLevelSig = '';
      if (st.cmp.includes(s)) { st.cmp = st.cmp.filter((x) => x !== s); paintCompareChips(); }
      load();
    },
    symbol() { return sym; },
    // Called on every host update: patch, never reload unless the bars aged out.
    tick() {
      if (destroyed) return;
      syncBus();
      paintBar();
      if (!sym) return;
      applyTick();
      paintLevels(false);
      syncDrawings(false);
      if (lastRes && loadedAt && Date.now() - loadedAt > refreshMs()) load(true);
    },
    refresh() { load(); },
    state() { return { ...st }; },
    destroy() {
      destroyed = true;
      token++;
      document.removeEventListener('pointerdown', onDocDown, true);
      if (busOff) safe(busOff);
      safe(() => chart.destroy());
      root.remove();
    },
  };
}
