/* widgets-market.js — the discovery and research widgets: screener, heatmap,
   movers, compare, news, calendar and fundamentals, plus the renderers the
   detail drawer shares with them (fundamentals table, events, news list).

   Same contract as widgets.js: build once in create(), patch in update(), and
   never fetch except through a ctx function the host provides (ctx.dailyBars,
   ctx.candles, ctx.fundamentals, ctx.news, ctx.events, ctx.calendar,
   ctx.universes). A detached panel hands over a thinner ctx; every widget here
   says what it cannot show there instead of failing.

   Free tiers are the binding constraint, so anything that touches many
   symbols — the screener above all — is paced and cached: one shared scan
   cache per window keyed by symbol, requests at most two at a time, a forecast
   of the cost before a big list is scanned, and a progress line while it runs.
   Every list is labelled with where its numbers came from, and every preset is
   labelled educational: a screener sorts facts about past prices, it does not
   pick anything. */

import { createChart } from './chart.js';
import { returns, stdev, maxDrawdown } from './indicators.js';
import { metricsFromBars, applyFilters, treemap, SCAN_FIELDS, SCAN_FIELD_BY_ID, SCAN_PRESETS, SCAN_OPS } from './scan.js';
import { fmtPrice, fmtPct, fmtNum, fmtVolume, fmtAge } from './format.js';
import { helpIcon, learnIdFor, levelLimit } from './learn.js';

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);

// Dates follow the interface language (i18n.js sets <html lang>), not the browser's.
const uiLocale = () => { try { return document.documentElement.lang || undefined; } catch (e) { return undefined; } };
const DASH = '—';
const SCAN_TTL = 15 * 60 * 1000;
const NEWS_TTL = 10 * 60 * 1000;
const EVENTS_TTL = 60 * 60 * 1000;

/* ---- small helpers (widgets.js keeps its own; these are deliberately local) -- */
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fb) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { return fb; } };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
function setText(node, txt) { const s = txt == null ? '' : String(txt); if (node.textContent !== s) node.textContent = s; }
function symbolsOf(ctx) { return (ctx && Array.isArray(ctx.symbols) ? ctx.symbols : []).filter((s) => typeof s === 'string' && s); }
function quoteOf(ctx, sym) { const q = ctx && ctx.quotes ? ctx.quotes[sym] : null; return q && typeof q === 'object' ? q : null; }
function profileOf(ctx, sym) { return safe(() => ctx.profileFor(sym), null); }
function subjectOf(ctx, pinned) { return pinned || (ctx && typeof ctx.selection === 'string' && ctx.selection) || symbolsOf(ctx)[0] || null; }
function applyPrivacy(root, ctx) { root.classList.toggle('wg-privacy', !!(ctx && ctx.privacy)); }
function priceOpts(ctx, sym) { return { fx: safe(() => ctx.marketFor(sym), '') === 'FX' }; }
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const signCls = (v) => (fin(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '');

function symBtn(sym, cls) {
  const b = el('button', 'wg-pick ' + (cls || ''), sym);
  b.type = 'button';
  b.dataset.sym = sym || '';
  if (sym) b.title = i18nT('Link the workspace to') + ' ' + sym + ' · ' + i18nT('double-click for details');
  return b;
}

// Single click links the workspace; double-click or Enter opens the details
// drawer. The same rule as widgets.js wirePicks, so every list behaves alike.
function wirePicks(root, getCtx) {
  const pick = (e) => { const t = e.target && e.target.closest ? e.target.closest('[data-sym]') : null; return t && root.contains(t) && t.dataset.sym ? t.dataset.sym : null; };
  const onClick = (e) => { const s = pick(e); const c = getCtx(); if (s && c && typeof c.onSelect === 'function') safe(() => c.onSelect(s)); };
  const onDbl = (e) => { const s = pick(e); const c = getCtx(); if (s && c && typeof c.openDetails === 'function') { e.preventDefault(); safe(() => c.openDetails(s)); } };
  const onKey = (e) => {
    if (e.key !== 'Enter') return;
    const s = pick(e); const c = getCtx();
    if (s && c && typeof c.openDetails === 'function') { e.preventDefault(); safe(() => c.openDetails(s)); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDbl);
  root.addEventListener('keydown', onKey);
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('dblclick', onDbl); root.removeEventListener('keydown', onKey); };
}

function capFmt(v, ccy) {
  if (!fin(v)) return DASH;
  const p = !ccy || ccy === 'USD' ? '$' : ccy + ' ';
  const a = Math.abs(v);
  if (a >= 1e12) return p + (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return p + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return p + (v / 1e6).toFixed(1) + 'M';
  return p + fmtNum(v, 0);
}

function fmtField(f, v, ctx, sym) {
  if (f.unit === 'pct') return fin(v) ? fmtPct(v) : DASH;
  if (f.unit === 'x') return fin(v) ? fmtNum(v, 2) + '×' : DASH;
  if (f.unit === 'num') return fin(v) ? fmtNum(v, 1) : DASH;
  if (f.unit === 'price') { const q = quoteOf(ctx, sym); return fin(v) ? fmtPrice(v, q && q.currency, priceOpts(ctx, sym)) : DASH; }
  if (f.id === 'trend') return v === 'up' ? i18nT('Up') : v === 'down' ? i18nT('Down') : v === 'mixed' ? i18nT('Mixed') : DASH;
  return v == null ? DASH : String(v);
}

function eduNote(text) { return el('p', 'field-note wg-edu', i18nT(text || 'Educational, not advice.')); }

/* ---- universes ----------------------------------------------------------------- */
let universes = null, universesP = null;
function loadUniverses(ctx) {
  if (universes) return Promise.resolve(universes);
  if (universesP) return universesP;
  const fn = ctx && ctx.universes;
  if (typeof fn !== 'function') return Promise.resolve([]);
  universesP = Promise.resolve(fn()).then((u) => { universes = Array.isArray(u) ? u : []; return universes; }).catch(() => { universesP = null; return []; });
  return universesP;
}
function universeById(id) { return (universes || []).find((u) => u.id === id) || null; }

// The symbols (and their bundled sector) a list stands for.
function listSymbols(ctx, listId) {
  if (!listId || listId === 'watchlist') return symbolsOf(ctx).map((s) => ({ sym: s, sector: null }));
  const u = universeById(listId);
  return u ? u.symbols.map(([s, sector]) => ({ sym: s, sector })) : [];
}

function listSelect(current, onChange, includeWatch = true) {
  const sel = el('select', 'cs-select sm wg-listsel');
  sel.setAttribute('aria-label', i18nT('Symbol list'));
  sel.title = i18nT('Which symbols to look at');
  const fill = () => {
    const v = sel.value || current;
    sel.textContent = '';
    if (includeWatch) { const o = el('option', null, i18nT('My watchlist')); o.value = 'watchlist'; sel.appendChild(o); }
    for (const u of universes || []) { const o = el('option', null, i18nT(u.label)); o.value = u.id; o.title = i18nT(u.note || ''); sel.appendChild(o); }
    sel.value = v;
    if (sel.value !== v && sel.options.length) sel.value = sel.options[0].value;
  };
  fill();
  sel.addEventListener('change', () => onChange(sel.value));
  return { sel, fill };
}

/* ---- scan cache (shared by screener, heatmap and movers in this window) -------- */
const SCAN = new Map();        // sym -> {at, bars, isDemo, source, error, sig, m}
const inflight = new Map();    // sym -> Promise

function scanFresh(sym) { const r = SCAN.get(sym); return !!(r && Date.now() - r.at < SCAN_TTL); }

function fetchDaily(ctx, sym) {
  if (inflight.has(sym)) return inflight.get(sym);
  const fn = ctx && ctx.dailyBars;
  if (typeof fn !== 'function') return Promise.resolve(null);
  const p = Promise.resolve(fn(sym)).then((r) => {
    const rec = { at: Date.now(), bars: (r && r.bars) || [], isDemo: !!(r && r.isDemo), source: (r && r.source) || null, error: (r && r.error) || null, sig: '', m: null };
    SCAN.set(sym, rec);
    return rec;
  }).catch((e) => {
    const rec = { at: Date.now(), bars: [], isDemo: false, source: null, error: String((e && e.message) || e), sig: '', m: null };
    SCAN.set(sym, rec);
    return rec;
  }).finally(() => inflight.delete(sym));
  inflight.set(sym, p);
  return p;
}

// Metrics for one symbol, recomputed only when its quote moved.
function metricsFor(ctx, sym) {
  const rec = SCAN.get(sym);
  if (!rec || !rec.bars.length) return null;
  const q = quoteOf(ctx, sym);
  const sig = q ? q.price + '|' + q.ts : '-';
  if (rec.m && rec.sig === sig) return rec.m;
  rec.m = metricsFromBars(rec.bars, q && (!rec.isDemo || safe(() => ctx.isDemoMode(), true)) ? q : null);
  rec.sig = sig;
  return rec.m;
}

/* A scan job: two requests at a time, cached symbols skipped, progress reported.
   Returns a handle whose cancel() makes the rest of the queue a no-op. */
function runScan(ctx, syms, { force = false, onProgress } = {}) {
  let cancelled = false;
  const todo = syms.filter((s) => force || !scanFresh(s));
  const total = todo.length;
  let done = 0;
  const report = () => { if (!cancelled && onProgress) safe(() => onProgress(done, total)); };
  report();
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length && !cancelled) {
      const s = queue.shift();
      await fetchDaily(ctx, s);
      done++;
      report();
    }
  };
  const p = Promise.all([worker(), worker()]);
  return { promise: p, cancel() { cancelled = true; }, total };
}

// "About 38 requests · ~5 min on Twelve Data's free tier" — or null in demo.
function forecastText(ctx, syms) {
  const todo = syms.filter((s) => !scanFresh(s));
  if (!todo.length) return '';
  const fc = safe(() => ctx.scanForecast(todo), null);
  if (!fc) return todo.length + ' ' + i18nT('requests');
  if (fc.demo) return i18nT('Demo data — no API calls.');
  const t = fc.ms === Infinity ? i18nT('more than today’s free quota') : fc.ms > 60000 ? '~' + Math.ceil(fc.ms / 60000) + ' min' : fc.ms > 2000 ? '~' + Math.ceil(fc.ms / 1000) + ' s' : i18nT('a few seconds');
  return todo.length + ' ' + i18nT('requests') + ' · ' + t + (fc.label ? ' · ' + fc.label : '');
}

/* =============================================================================
   SCREENER
   ============================================================================= */
const SCREEN_COLS = ['price', 'chg1d', 'chg5d', 'chg1m', 'chgYtd', 'rsi14', 'vsSma50', 'vsSma200', 'fromHigh52', 'relVol', 'atrPct', 'gap', 'trend'];
const AUTO_SCAN_MAX = 12;

function createScreener(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState && typeof cur.widgetState === 'object' ? cur.widgetState : {};
  const st = {
    list: typeof saved.list === 'string' ? saved.list : 'watchlist',
    preset: typeof saved.preset === 'string' ? saved.preset : 'all',
    filters: Array.isArray(saved.filters) ? saved.filters.filter((f) => f && typeof f.f === 'string').slice(0, 8) : [],
    sort: typeof saved.sort === 'string' ? saved.sort : 'chg1d',
    dir: saved.dir === 'asc' ? 'asc' : 'desc',
  };
  const persist = () => safe(() => cur.onWidgetState({ ...st, filters: st.filters.slice() }));

  const root = el('div', 'wg-screener');
  const top = el('div', 'wg-bar');
  const lists = listSelect(st.list, (v) => { st.list = v; persist(); job && job.cancel(); job = null; sig = ''; update(); maybeAutoScan(); });
  const preset = el('select', 'cs-select sm');
  preset.setAttribute('aria-label', i18nT('Preset'));
  preset.title = i18nT('Educational presets — each describes a chart condition, not an opportunity.');
  for (const p of SCAN_PRESETS) { const o = el('option', null, i18nT(p.label)); o.value = p.id; o.title = i18nT(p.desc); preset.appendChild(o); }
  const custom = el('option', null, i18nT('Custom filters')); custom.value = 'custom'; preset.appendChild(custom);
  preset.value = st.preset;
  preset.addEventListener('change', () => {
    st.preset = preset.value;
    const p = SCAN_PRESETS.find((x) => x.id === st.preset);
    if (p) st.filters = p.filters.map((f) => ({ ...f }));
    persist(); sig = ''; update();
  });
  const scanBtn = el('button', 'cs-btn sm', i18nT('Scan'));
  scanBtn.type = 'button';
  scanBtn.addEventListener('click', () => startScan(true));
  const prog = el('span', 'wg-prog field-note', '');
  top.append(lists.sel, preset, scanBtn, prog);

  const filt = el('div', 'wg-filters');
  const chips = el('span', 'wg-chips');
  const addF = el('button', 'cs-btn sm', i18nT('＋ Filter'));
  addF.type = 'button';
  const builder = el('span', 'wg-builder');
  builder.hidden = true;
  const fSel = el('select', 'cs-select sm');
  for (const f of SCAN_FIELDS) { if (f.id === 'price') continue; const o = el('option', null, i18nT(f.label)); o.value = f.id; fSel.appendChild(o); }
  const crossO = el('option', null, i18nT('MA cross')); crossO.value = 'cross'; fSel.appendChild(crossO);
  fSel.setAttribute('aria-label', i18nT('Filter field'));
  const opSel = el('select', 'cs-select sm');
  opSel.setAttribute('aria-label', i18nT('Comparison'));
  const valIn = el('input', 'input sm wg-fval');
  valIn.type = 'text';
  valIn.setAttribute('aria-label', i18nT('Value'));
  const fillOps = () => {
    const f = fSel.value;
    opSel.textContent = '';
    const textual = f === 'trend' || f === 'cross';
    for (const [k, sym] of Object.entries(SCAN_OPS)) { if (textual !== (k === 'is')) continue; const o = el('option', null, sym); o.value = k; opSel.appendChild(o); }
    valIn.placeholder = f === 'trend' ? i18nT('up / down / mixed') : f === 'cross' ? i18nT('golden / death') : '30';
  };
  fSel.addEventListener('change', fillOps);
  fillOps();
  const okF = el('button', 'cs-btn sm', i18nT('Add'));
  okF.type = 'button';
  okF.addEventListener('click', () => {
    const f = fSel.value, op = opSel.value;
    let v = valIn.value.trim();
    if (op !== 'is') { v = Number(v.replace(',', '.')); if (!fin(v)) { valIn.focus(); return; } }
    else v = v.toLowerCase();
    st.filters.push({ f, op, v });
    st.preset = 'custom'; preset.value = 'custom';
    valIn.value = ''; builder.hidden = true;
    persist(); sig = ''; update();
  });
  builder.append(fSel, opSel, valIn, okF);
  addF.addEventListener('click', () => { builder.hidden = !builder.hidden; if (!builder.hidden) valIn.focus(); });
  filt.append(chips, addF, builder);

  const wrap = el('div', 'table-wrap wg-scan-wrap');
  const table = el('table', 'data wg-scan');
  const thead = el('thead'); const hrow = el('tr'); thead.appendChild(hrow);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);
  const foot = el('p', 'field-note wg-scan-foot', '');
  root.append(top, filt, wrap, foot, eduNote('Screens describe past prices. Presets are educational, not advice or recommendations.'));
  host.appendChild(root);

  // Header, built once: a click sorts, the ? explains.
  const cols = ['sym', ...SCREEN_COLS];
  for (const c of cols) {
    const f = SCAN_FIELD_BY_ID[c];
    const th = el('th', c === 'sym' ? '' : 'num');
    th.scope = 'col';
    const b = el('button', 'wt-hbtn', c === 'sym' ? i18nT('Symbol') : i18nT(f.label));
    b.type = 'button';
    b.title = c === 'sym' ? i18nT('Sort by symbol') : i18nT(f.desc);
    b.addEventListener('click', () => { if (st.sort === c) st.dir = st.dir === 'desc' ? 'asc' : 'desc'; else { st.sort = c; st.dir = c === 'sym' ? 'asc' : 'desc'; } persist(); sig = ''; update(); });
    th.appendChild(b);
    if (f && f.learn) th.appendChild(helpIcon(f.learn));
    th.dataset.col = c;
    hrow.appendChild(th);
  }

  const unwire = wirePicks(root, () => cur);
  let job = null, sig = '', progTxt = '';

  function paintChips() {
    chips.textContent = '';
    st.filters.forEach((f, i) => {
      const fd = SCAN_FIELD_BY_ID[f.f];
      const label = (fd ? i18nT(fd.label) : f.f === 'cross' ? i18nT('MA cross') : f.f) + ' ' + (SCAN_OPS[f.op] || f.op) + ' ' + f.v;
      const c = el('span', 'cp-chip', label);
      const x = el('button', 'cp-chip-x', '✕');
      x.type = 'button';
      x.title = i18nT('Remove filter');
      x.addEventListener('click', () => { st.filters.splice(i, 1); st.preset = st.filters.length ? 'custom' : 'all'; preset.value = st.preset; persist(); sig = ''; update(); });
      c.appendChild(x);
      chips.appendChild(c);
    });
  }

  function startScan(force) {
    if (job) job.cancel();
    const syms = listSymbols(cur, st.list).map((x) => x.sym);
    if (!syms.length) return;
    if (typeof cur.dailyBars !== 'function') { progTxt = i18nT('Scanning runs in the main window.'); update(); return; }
    job = runScan(cur, syms, {
      force,
      onProgress: (d, t) => { progTxt = t ? i18nT('Scanning') + ' ' + d + ' / ' + t + '…' : ''; sig = ''; update(); },
    });
    const mine = job;
    job.promise.then(() => { if (job === mine) { job = null; progTxt = ''; sig = ''; update(); } });
  }

  function maybeAutoScan() {
    const syms = listSymbols(cur, st.list).map((x) => x.sym);
    const demo = safe(() => cur.isDemoMode(), false);
    if (syms.length && (demo || syms.length <= AUTO_SCAN_MAX) && syms.some((s) => !scanFresh(s))) startScan(false);
    else update();
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const entries = listSymbols(cur, st.list);
    const rows = entries.map((e) => ({ sym: e.sym, m: metricsFor(cur, e.sym), rec: SCAN.get(e.sym) }));
    const scanned = rows.filter((r) => r.m);
    const shown = applyFilters(scanned, st.filters);
    const dir = st.dir === 'asc' ? 1 : -1;
    shown.sort((a, b) => {
      if (st.sort === 'sym') return dir * a.sym.localeCompare(b.sym);
      const va = a.m[st.sort], vb = b.m[st.sort];
      if (!fin(va) && !fin(vb)) return String(va || '').localeCompare(String(vb || '')) * dir;
      if (!fin(va)) return 1; if (!fin(vb)) return -1;
      return (va - vb) * dir;
    });
    for (const th of hrow.children) th.setAttribute('aria-sort', th.dataset.col === st.sort ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none');

    const newSig = st.list + '|' + st.sort + st.dir + '|' + JSON.stringify(st.filters) + '|' + shown.map((r) => r.sym + ':' + SCREEN_COLS.map((c) => { const v = r.m[c]; return fin(v) ? v.toFixed(2) : v; }).join(',')).join(';') + '|' + progTxt;
    if (newSig !== sig) {
      sig = newSig;
      paintChips();
      tbody.textContent = '';
      for (const r of shown) {
        const tr = el('tr');
        const th = el('th', 'sym');
        th.scope = 'row';
        th.appendChild(symBtn(r.sym, 'wg-pick-sym'));
        tr.appendChild(th);
        for (const c of SCREEN_COLS) {
          const f = SCAN_FIELD_BY_ID[c];
          const v = r.m[c];
          const td = el('td', 'num' + (f.unit === 'pct' && c !== 'atrPct' ? ' ' + signCls(v) : '') + (f.unit === 'price' ? ' amount' : ''), fmtField(f, v, cur, r.sym));
          if (c === 'rsi14' && fin(v)) td.classList.add(v >= 70 ? 'hot' : v <= 30 ? 'cold' : 'x');
          if (c === 'trend') td.classList.add('trend-' + (v || 'none'));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      if (!shown.length) {
        const tr = el('tr'); const td = el('td', 'empty-cell');
        td.colSpan = cols.length;
        td.textContent = !entries.length ? i18nT('This list is empty.')
          : !scanned.length ? (job ? i18nT('Scanning…') : i18nT('Not scanned yet. Press Scan to fetch daily bars for this list.'))
            : i18nT('No symbols match these filters.');
        tr.appendChild(td); tbody.appendChild(tr);
      }
      const demo = rows.some((r) => r.rec && r.rec.isDemo);
      const failed = rows.filter((r) => r.rec && !r.rec.bars.length).length;
      const oldest = scanned.reduce((a, r) => Math.min(a, r.rec ? r.rec.at : Infinity), Infinity);
      const u = universeById(st.list);
      setText(foot, [
        shown.length + ' ' + i18nT('of') + ' ' + entries.length + ' ' + i18nT('shown'),
        scanned.length < entries.length && !job ? (entries.length - scanned.length) + ' ' + i18nT('not scanned') : '',
        failed ? failed + ' ' + i18nT('without data') : '',
        demo ? i18nT('demo data') : '',
        fin(oldest) ? i18nT('daily bars, oldest') + ' ' + fmtAge(Date.now() - oldest) + ' ' + i18nT('old') : '',
        u ? i18nT(u.note) : '',
      ].filter(Boolean).join(' · '));
    }
    setText(prog, progTxt || (job ? '' : forecastText(cur, entries.map((e) => e.sym))));
    setText(scanBtn, job ? i18nT('Rescan') : scanned.length ? i18nT('Rescan') : i18nT('Scan'));
  }

  loadUniverses(cur).then(() => { lists.fill(); maybeAutoScan(); });
  update(cur);
  return {
    kind: 'screener',
    update,
    setSymbol() { /* a screen is a list, not one symbol */ },
    destroy() { if (job) job.cancel(); unwire(); host.textContent = ''; },
  };
}

/* ---- rows for heatmap / movers: live quotes for the watchlist, scan data for a
   bundled list (a list outside the watchlist has no live quotes to read). ----- */
function moverRows(ctx, listId) {
  const entries = listSymbols(ctx, listId);
  const watch = !listId || listId === 'watchlist';
  return entries.map(({ sym, sector }) => {
    const q = quoteOf(ctx, sym);
    const m = metricsFor(ctx, sym);
    const p = profileOf(ctx, sym);
    const chg = q && fin(q.changePct) ? q.changePct : m ? m.chg1d : null;
    const price = q && fin(q.price) ? q.price : m ? m.price : null;
    const vol = q && fin(q.volume) ? q.volume : m ? m.volume : null;
    const rec = SCAN.get(sym);
    return {
      sym, chg, price, vol,
      dollarVol: fin(vol) && fin(price) ? vol * price : null,
      relVol: m ? m.relVol : null,
      sector: sector || (p && p.sector) || null,
      cap: p && fin(p.marketCap) && p.marketCap > 0 ? p.marketCap : null,
      live: !!(q && fin(q.changePct)),
      isDemo: !!(rec && rec.isDemo),
      watch,
    };
  });
}

/* =============================================================================
   HEATMAP
   ============================================================================= */
function createHeatmap(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = { list: typeof saved.list === 'string' ? saved.list : 'watchlist', size: saved.size === 'equal' ? 'equal' : 'cap', group: saved.group !== false };
  const persist = () => safe(() => cur.onWidgetState({ ...st }));

  const root = el('div', 'wg-heat');
  const bar = el('div', 'wg-bar');
  const lists = listSelect(st.list, (v) => { st.list = v; persist(); sig = ''; ensureData(); update(); });
  const sizeSel = el('select', 'cs-select sm');
  sizeSel.setAttribute('aria-label', i18nT('Tile size'));
  for (const [v, l] of [['cap', 'Size: market cap'], ['equal', 'Size: equal']]) { const o = el('option', null, i18nT(l)); o.value = v; sizeSel.appendChild(o); }
  sizeSel.value = st.size;
  sizeSel.addEventListener('change', () => { st.size = sizeSel.value; persist(); sig = ''; update(); });
  const grpBtn = el('button', 'cs-btn sm', i18nT('Group by sector'));
  grpBtn.type = 'button';
  grpBtn.addEventListener('click', () => { st.group = !st.group; persist(); sig = ''; update(); });
  const legend = el('span', 'wg-heat-legend');
  for (const v of [-3, -1, 0, 1, 3]) { const s = el('span', 'wg-heat-key', (v > 0 ? '+' : '') + v + '%'); s.style.background = heatColor(v); legend.appendChild(s); }
  bar.append(lists.sel, sizeSel, grpBtn, legend);
  const area = el('div', 'wg-heat-area');
  const note = el('p', 'field-note', '');
  root.append(bar, area, note);
  host.appendChild(root);
  const unwire = wirePicks(area, () => cur);
  let sig = '', W = 0, H = 0, job = null;

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { const r = area.getBoundingClientRect(); if (Math.round(r.width) !== W || Math.round(r.height) !== H) { W = Math.round(r.width); H = Math.round(r.height); sig = ''; update(); } });
    ro.observe(area);
  }

  function ensureData() {
    if (st.list === 'watchlist') return;
    const syms = listSymbols(cur, st.list).map((x) => x.sym);
    const demo = safe(() => cur.isDemoMode(), false);
    if (!syms.some((s) => !scanFresh(s)) || typeof cur.dailyBars !== 'function') return;
    if (!demo && syms.length > AUTO_SCAN_MAX) return;   // a big live list waits for the screener's Scan button
    if (job) job.cancel();
    job = runScan(cur, syms, { onProgress: () => { sig = ''; update(); } });
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    grpBtn.classList.toggle('active', st.group);
    grpBtn.setAttribute('aria-pressed', st.group ? 'true' : 'false');
    const rows = moverRows(cur, st.list).filter((r) => fin(r.chg));
    const caps = rows.map((r) => r.cap).filter(fin).sort((a, b) => a - b);
    const median = caps.length ? caps[Math.floor(caps.length / 2)] : 1;
    const missingCap = st.size === 'cap' ? rows.filter((r) => !fin(r.cap)).length : 0;
    for (const r of rows) r.value = st.size === 'cap' ? (fin(r.cap) ? r.cap : median) : 1;
    const newSig = [st.list, st.size, st.group, W, H, rows.map((r) => r.sym + r.chg.toFixed(2) + ':' + r.value).join(',')].join('|');
    if (newSig === sig) return;
    sig = newSig;
    area.textContent = '';
    const total = listSymbols(cur, st.list).length;
    if (!rows.length || W < 20 || H < 20) {
      area.appendChild(el('p', 'empty-cell', !total ? i18nT('This list is empty.')
        : st.list === 'watchlist' ? i18nT('Waiting for quotes…') : i18nT('Not scanned yet — open a Screener on this list and press Scan, or wait for the scan to finish.')));
    } else {
      let tiles = [];
      if (st.group) {
        const groups = new Map();
        for (const r of rows) { const g = r.sector || i18nT('Other'); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
        const gItems = [...groups.entries()].map(([name, list]) => ({ name, list, value: list.reduce((a, r) => a + r.value, 0) }));
        for (const g of treemap(gItems, 0, 0, W, H)) {
          const box = el('div', 'wg-heat-group');
          Object.assign(box.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
          if (g.h > 34 && g.w > 50) box.appendChild(el('span', 'wg-heat-gname', i18nT(g.name)));
          area.appendChild(box);
          const pad = g.h > 34 && g.w > 50 ? 14 : 0;
          tiles = tiles.concat(treemap(g.list, g.x + 1, g.y + pad + 1, g.w - 2, g.h - pad - 2));
        }
      } else tiles = treemap(rows, 0, 0, W, H);
      for (const t of tiles) {
        const b = el('button', 'wg-heat-tile');
        b.type = 'button';
        b.dataset.sym = t.sym;
        Object.assign(b.style, { left: t.x + 'px', top: t.y + 'px', width: Math.max(0, t.w - 1) + 'px', height: Math.max(0, t.h - 1) + 'px', background: heatColor(t.chg) });
        b.title = t.sym + ' ' + fmtPct(t.chg) + (t.sector ? ' · ' + i18nT(t.sector) : '') + (fin(t.cap) ? ' · ' + i18nT('Market cap') + ' ' + capFmt(t.cap) : '') + (t.live ? '' : ' · ' + i18nT('from daily bars'));
        if (t.w > 34 && t.h > 22) {
          b.appendChild(el('span', 'wg-heat-sym', t.sym));
          if (t.h > 36) b.appendChild(el('span', 'wg-heat-pct', fmtPct(t.chg)));
        }
        area.appendChild(b);
      }
    }
    const demo = rows.some((r) => r.isDemo);
    setText(note, [
      st.list === 'watchlist' ? i18nT('Day change from live quotes') : i18nT('Last daily change from cached daily bars'),
      missingCap && missingCap === rows.length ? i18nT('No market caps known for this list, so tiles are equal size')
        : missingCap ? missingCap + ' ' + i18nT('without a known market cap shown at the median size') : '',
      demo ? i18nT('demo data') : '',
      i18nT('Colour is the day’s % change, capped at ±3%.'),
    ].filter(Boolean).join(' · '));
  }

  loadUniverses(cur).then(() => { lists.fill(); ensureData(); sig = ''; update(); });
  update(cur);
  return {
    kind: 'heatmap', update, setSymbol() {},
    destroy() { if (job) job.cancel(); if (ro) ro.disconnect(); unwire(); host.textContent = ''; },
  };
}

// Diverging colour from the fleet's own up/down tokens, mixed into the card
// background: saturation is the size of the move, capped at ±3%.
function heatColor(pctV) {
  if (!fin(pctV)) return 'var(--bg-elev)';
  const a = Math.min(1, Math.abs(pctV) / 3);
  const share = Math.round(18 + a * 62);
  const tok = pctV > 0 ? 'var(--ok)' : pctV < 0 ? 'var(--err)' : 'var(--border-hi)';
  return pctV === 0 ? 'var(--bg-elev)' : 'color-mix(in srgb, ' + tok + ' ' + share + '%, var(--bg-card))';
}

/* =============================================================================
   MOVERS
   ============================================================================= */
function createMovers(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = { list: typeof saved.list === 'string' ? saved.list : 'watchlist', mode: ['gainers', 'losers', 'active'].includes(saved.mode) ? saved.mode : 'gainers' };
  const persist = () => safe(() => cur.onWidgetState({ ...st }));
  const root = el('div', 'wg-movers');
  const bar = el('div', 'wg-bar');
  const lists = listSelect(st.list, (v) => { st.list = v; persist(); sig = ''; ensure(); update(); });
  const seg = el('div', 'seg');
  const segBtns = {};
  for (const [m, l] of [['gainers', 'Gainers'], ['losers', 'Losers'], ['active', 'Most active']]) {
    const b = el('button', 'cs-btn seg-btn sm', i18nT(l));
    b.type = 'button';
    b.addEventListener('click', () => { st.mode = m; persist(); sig = ''; update(); });
    segBtns[m] = b; seg.appendChild(b);
  }
  bar.append(lists.sel, seg);
  const list = el('div', 'wg-mv-list');
  const note = el('p', 'field-note', '');
  root.append(bar, list, note);
  host.appendChild(root);
  const unwire = wirePicks(list, () => cur);
  let sig = '', job = null;

  function ensure() {
    if (st.list === 'watchlist' || typeof cur.dailyBars !== 'function') return;
    const syms = listSymbols(cur, st.list).map((x) => x.sym);
    const demo = safe(() => cur.isDemoMode(), false);
    if (!syms.some((s) => !scanFresh(s)) || (!demo && syms.length > AUTO_SCAN_MAX)) return;
    if (job) job.cancel();
    job = runScan(cur, syms, { onProgress: () => { sig = ''; update(); } });
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    for (const [m, b] of Object.entries(segBtns)) { b.classList.toggle('active', m === st.mode); b.setAttribute('aria-pressed', m === st.mode ? 'true' : 'false'); }
    let rows = moverRows(cur, st.list);
    if (st.mode === 'active') rows = rows.filter((r) => fin(r.dollarVol)).sort((a, b) => b.dollarVol - a.dollarVol);
    else if (st.mode === 'gainers') rows = rows.filter((r) => fin(r.chg) && r.chg > 0).sort((a, b) => b.chg - a.chg);
    else rows = rows.filter((r) => fin(r.chg) && r.chg < 0).sort((a, b) => a.chg - b.chg);
    rows = rows.slice(0, 10);
    const maxAbs = rows.reduce((a, r) => Math.max(a, st.mode === 'active' ? r.dollarVol : Math.abs(r.chg)), 0) || 1;
    const newSig = st.mode + '|' + st.list + '|' + rows.map((r) => r.sym + (r.chg || 0).toFixed(2) + (r.dollarVol || 0)).join(',');
    if (newSig !== sig) {
      sig = newSig;
      list.textContent = '';
      for (const r of rows) {
        const row = el('div', 'wg-mv-row');
        row.appendChild(symBtn(r.sym, 'wg-mv-sym'));
        const track = el('span', 'wg-mv-track');
        const fill = el('span', 'wg-mv-fill ' + (st.mode === 'active' ? 'act' : r.chg >= 0 ? 'up' : 'down'));
        fill.style.width = Math.max(2, ((st.mode === 'active' ? r.dollarVol : Math.abs(r.chg)) / maxAbs) * 100).toFixed(1) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'wg-mv-val num ' + signCls(r.chg), fmtPct(r.chg)));
        const v = el('span', 'wg-mv-vol num amount', fin(r.dollarVol) ? '$' + fmtVolume(r.dollarVol) : DASH);
        v.title = i18nT('Dollar volume: shares traded × price');
        row.appendChild(v);
        list.appendChild(row);
      }
      if (!rows.length) list.appendChild(el('p', 'empty-cell', st.list === 'watchlist' ? i18nT('Nothing to rank yet — waiting for quotes.') : i18nT('Not scanned yet — open a Screener on this list and press Scan.')));
      setText(note, (st.list === 'watchlist' ? i18nT('Ranked from live quotes') : i18nT('Ranked from cached daily bars')) + ' · ' + i18nT('Most active = dollar volume') + ' · ' + i18nT('Educational, not advice.'));
    }
  }

  loadUniverses(cur).then(() => { lists.fill(); ensure(); sig = ''; update(); });
  update(cur);
  return { kind: 'movers', update, setSymbol() {}, destroy() { if (job) job.cancel(); unwire(); host.textContent = ''; } };
}

/* =============================================================================
   COMPARE — normalized % performance of up to eight symbols
   ============================================================================= */
const COMPARE_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '5Y'];

function createCompare(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = {
    syms: (Array.isArray(saved.syms) ? saved.syms : []).filter((s) => typeof s === 'string' && /^[A-Z0-9.\-]{1,15}$/.test(s)).slice(0, 8),
    r: COMPARE_RANGES.includes(saved.r) ? saved.r : '1Y',
  };
  if (!st.syms.length) st.syms = symbolsOf(cur).slice(0, 3);
  const persist = () => safe(() => cur.onWidgetState({ syms: st.syms.slice(), r: st.r }));

  const root = el('div', 'wg-compare');
  const bar = el('div', 'wg-bar');
  const chips = el('span', 'wg-chips');
  const input = el('input', 'cp-cmp-in');
  input.type = 'text';
  input.placeholder = i18nT('+ Symbol');
  input.setAttribute('aria-label', i18nT('Add a symbol to compare'));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const s = input.value.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15);
    input.value = '';
    const cap = Math.min(8, 1 + levelLimit(safe(() => cur.level, 'standard'), 'compare'));
    if (!s || st.syms.includes(s)) return;
    if (st.syms.length >= cap) { input.placeholder = i18nT('Limit reached'); return; }
    st.syms.push(s); persist(); load();
  });
  const seg = el('div', 'seg');
  const segBtns = {};
  for (const r of COMPARE_RANGES) {
    const b = el('button', 'cs-btn seg-btn sm', r);
    b.type = 'button';
    b.addEventListener('click', () => { st.r = r; persist(); load(); });
    segBtns[r] = b; seg.appendChild(b);
  }
  bar.append(chips, input, seg);
  const chartHost = el('div', 'wg-cmp-chart');
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data wg-cmp-table');
  const thead = el('thead'); const hr = el('tr');
  for (const [l, tip, learn] of [['Symbol', '', ''], ['Return', 'Price change over the period (dividends not included)', 'pct-change'],
    ['Max drawdown', 'Largest fall from a peak during the period', 'drawdown'], ['Volatility', 'Annualized standard deviation of daily returns', 'volatility']]) {
    const th = el('th', l === 'Symbol' ? '' : 'num', i18nT(l)); th.scope = 'col'; if (tip) th.title = i18nT(tip);
    if (learn) th.appendChild(helpIcon(learn));
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);
  const note = el('p', 'field-note', '');
  root.append(bar, chartHost, wrap, note);
  host.appendChild(root);
  const chart = createChart(chartHost, { readOnly: true, fitAll: true });
  chart.setType('line');
  chart.setVolume(false);
  const unwire = wirePicks(root, () => cur);
  let token = 0;

  function paintChips() {
    chips.textContent = '';
    st.syms.forEach((s, i) => {
      const c = el('span', 'cp-chip cmp-c' + (i % 6));
      c.appendChild(symBtn(s, 'cp-chip-sym'));
      const x = el('button', 'cp-chip-x', '✕');
      x.type = 'button';
      x.title = i18nT('Remove') + ' ' + s;
      x.addEventListener('click', () => { st.syms = st.syms.filter((v) => v !== s); persist(); load(); });
      c.appendChild(x);
      chips.appendChild(c);
    });
    for (const [r, b] of Object.entries(segBtns)) { b.classList.toggle('active', r === st.r); b.setAttribute('aria-pressed', r === st.r ? 'true' : 'false'); }
  }

  async function load() {
    const my = ++token;
    paintChips();
    const fn = cur.candles;
    if (!st.syms.length) { chart.setData({ bars: [] }); chart.setState('empty', i18nT('Add symbols to compare.')); tbody.textContent = ''; setText(note, ''); return; }
    if (typeof fn !== 'function') { chart.setState('empty', i18nT('Charts are drawn in the main window.')); return; }
    chart.setState('loading');
    const res = await Promise.all(st.syms.map((s) => Promise.resolve(fn(s, { range: st.r, interval: st.r === '5Y' ? '1w' : '1d', priority: 1 })).catch(() => null)));
    if (my !== token) return;
    const [main, ...rest] = res;
    chart.setData({ bars: (main && main.bars) || [], symbol: st.syms[0], interval: (main && main.interval) || '1d', isDemo: res.some((r) => r && r.isDemo), source: main && main.source });
    chart.setCompare(rest.map((r, i) => ({ symbol: st.syms[i + 1], bars: (r && r.bars) || [] })));
    chart.setPercent(true);
    tbody.textContent = '';
    const ppy = st.r === '5Y' ? 52 : 252;
    res.forEach((r, i) => {
      const closes = ((r && r.bars) || []).map((b) => b.c).filter(fin);
      const tr = el('tr');
      const th = el('th', 'sym'); th.scope = 'row';
      const sw = el('span', 'wg-cmp-sw cmp-c' + (i % 6));
      th.append(sw, symBtn(st.syms[i], 'wg-pick-sym'));
      tr.appendChild(th);
      const ret = closes.length > 1 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : null;
      const mdd = closes.length > 1 ? maxDrawdown(closes) : null;
      const sd = closes.length > 2 ? stdev(returns(closes).filter(fin)) : null;
      tr.appendChild(el('td', 'num ' + signCls(ret), fin(ret) ? fmtPct(ret) : DASH));
      tr.appendChild(el('td', 'num neg', fin(mdd) ? fmtPct(mdd * 100) : DASH));
      tr.appendChild(el('td', 'num', fin(sd) ? fmtNum(sd * Math.sqrt(ppy) * 100, 1) + '%' : DASH));
      tbody.appendChild(tr);
    });
    const demo = res.some((r) => r && r.isDemo);
    setText(note, i18nT('Rebased to 0% at the first bar of the period. Price only — dividends are not included.') + (demo ? ' · ' + i18nT('demo data') : '') + ' · ' + i18nT('Past performance says nothing certain about the future.'));
  }

  function update(next) { if (next) cur = next; applyPrivacy(host, cur); }
  update(cur);
  load();
  return { kind: 'compare', update, setSymbol() {}, destroy() { token++; unwire(); safe(() => chart.destroy()); host.textContent = ''; } };
}

/* =============================================================================
   NEWS
   ============================================================================= */
export function renderNewsList(box, items, opts = {}) {
  box.textContent = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) { box.appendChild(el('p', 'field-note', i18nT(opts.empty || 'No recent headlines from your data provider.'))); return; }
  for (const n of list) {
    const row = el('article', 'wg-news-item');
    const meta = el('div', 'wg-news-meta');
    if (n._sym) meta.appendChild(symBtn(n._sym, 'wg-news-sym'));
    meta.appendChild(el('span', 'wg-news-src', n.source || ''));
    meta.appendChild(el('span', 'wg-news-time', fin(n.t) ? relTime(n.t) : ''));
    row.appendChild(meta);
    let head;
    // Links only ever open outside the app, and never with a window handle back.
    if (n.url && /^https?:\/\//i.test(n.url)) {
      head = el('a', 'wg-news-head', n.headline || '');
      head.href = n.url; head.target = '_blank'; head.rel = 'noopener noreferrer';
    } else head = el('span', 'wg-news-head', n.headline || '');
    row.appendChild(head);
    if (n.summary && !opts.compact) row.appendChild(el('p', 'wg-news-sum', String(n.summary).slice(0, 280)));
    box.appendChild(row);
  }
}

function relTime(t) {
  const d = Date.now() - t;
  if (d < 0) return new Date(t).toLocaleDateString(uiLocale());
  if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + 'm ' + i18nT('ago');
  if (d < 86400000) return Math.round(d / 3600000) + 'h ' + i18nT('ago');
  if (d < 7 * 86400000) return Math.round(d / 86400000) + 'd ' + i18nT('ago');
  return new Date(t).toLocaleDateString(uiLocale());
}

function createNews(host, ctx) {
  let cur = ctx || {};
  let pinned = null;
  const saved = cur.widgetState || {};
  const st = { scope: saved.scope === 'watchlist' ? 'watchlist' : 'symbol' };
  const root = el('div', 'wg-news');
  const bar = el('div', 'wg-bar');
  const seg = el('div', 'seg');
  const b1 = el('button', 'cs-btn seg-btn sm', i18nT('This symbol'));
  const b2 = el('button', 'cs-btn seg-btn sm', i18nT('Watchlist'));
  b1.type = b2.type = 'button';
  b1.addEventListener('click', () => { st.scope = 'symbol'; safe(() => cur.onWidgetState({ ...st })); load(true); });
  b2.addEventListener('click', () => { st.scope = 'watchlist'; safe(() => cur.onWidgetState({ ...st })); load(true); });
  seg.append(b1, b2);
  const status = el('span', 'field-note', '');
  bar.append(seg, status);
  const box = el('div', 'wg-news-list');
  root.append(bar, box, eduNote('Headlines come from your data provider. Stocks does not write, rank or vouch for them.'));
  host.appendChild(root);
  const unwire = wirePicks(box, () => cur);
  let token = 0, loadedKey = '', loadedAt = 0;

  async function load(force) {
    const subject = subjectOf(cur, pinned);
    const syms = st.scope === 'watchlist' ? symbolsOf(cur).slice(0, 8) : subject ? [subject] : [];
    const key = st.scope + '|' + syms.join(',');
    if (!force && key === loadedKey && Date.now() - loadedAt < NEWS_TTL) return;
    loadedKey = key; loadedAt = Date.now();
    b1.classList.toggle('active', st.scope === 'symbol'); b2.classList.toggle('active', st.scope === 'watchlist');
    const my = ++token;
    if (typeof cur.news !== 'function') { renderNewsList(box, [], { empty: 'News loads in the main window.' }); return; }
    if (!syms.length) { renderNewsList(box, [], { empty: 'Link this widget to a symbol, or pin one to it.' }); return; }
    setText(status, i18nT('Loading…'));
    const lists = await Promise.all(syms.map((s) => Promise.resolve(cur.news(s, { limit: st.scope === 'watchlist' ? 5 : 12 })).then((l) => (l || []).map((n) => ({ ...n, _sym: st.scope === 'watchlist' ? s : null }))).catch(() => [])));
    if (my !== token) return;
    const seen = new Set();
    const all = lists.flat().filter((n) => { const k = n.url || n.headline; if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 30);
    renderNewsList(box, all);
    setText(status, st.scope === 'symbol' ? (subject || '') : syms.length + ' ' + i18nT('symbols'));
  }

  function update(next) { if (next) cur = next; load(false); }
  update(cur);
  return { kind: 'news', update, setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; load(false); }, destroy() { token++; unwire(); host.textContent = ''; } };
}

/* =============================================================================
   CALENDAR — earnings and dividends for the watchlist, next 30 days
   ============================================================================= */
function createCalendar(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = { scope: saved.scope === 'all' ? 'all' : 'watchlist', days: [7, 30, 90].includes(saved.days) ? saved.days : 30 };
  const persist = () => safe(() => cur.onWidgetState({ ...st }));
  const root = el('div', 'wg-cal');
  const bar = el('div', 'wg-bar');
  const scopeSel = el('select', 'cs-select sm');
  scopeSel.setAttribute('aria-label', i18nT('Which earnings to show'));
  for (const [v, l] of [['watchlist', 'My watchlist'], ['all', 'All reported earnings']]) { const o = el('option', null, i18nT(l)); o.value = v; scopeSel.appendChild(o); }
  scopeSel.value = st.scope;
  scopeSel.addEventListener('change', () => { st.scope = scopeSel.value; persist(); load(true); });
  const daysSel = el('select', 'cs-select sm');
  daysSel.setAttribute('aria-label', i18nT('Time window'));
  for (const d of [7, 30, 90]) { const o = el('option', null, i18nT('Next {n} days').replace('{n}', d)); o.value = d; daysSel.appendChild(o); }
  daysSel.value = String(st.days);
  daysSel.addEventListener('change', () => { st.days = Number(daysSel.value); persist(); load(true); });
  const status = el('span', 'field-note', '');
  bar.append(scopeSel, daysSel, status);
  const box = el('div', 'wg-cal-list');
  root.append(bar, box, eduNote('Dates come from your data provider and can move. Confirm with the company before relying on one.'));
  host.appendChild(root);
  const unwire = wirePicks(box, () => cur);
  let token = 0, key = '', at = 0;

  async function load(force) {
    const watch = symbolsOf(cur);
    const k = st.scope + '|' + st.days + '|' + watch.join(',');
    if (!force && k === key && Date.now() - at < EVENTS_TTL) return;
    key = k; at = Date.now();
    const my = ++token;
    if (typeof cur.calendar !== 'function' && typeof cur.events !== 'function') { box.textContent = ''; box.appendChild(el('p', 'field-note', i18nT('The calendar loads in the main window.'))); return; }
    setText(status, i18nT('Loading…'));
    const from = ymd(Date.now()), to = ymd(Date.now() + st.days * 86400000);
    const set = new Set(watch);
    const items = [];
    const cal = typeof cur.calendar === 'function' ? await Promise.resolve(cur.calendar({ from, to })).catch(() => null) : null;
    for (const e of (cal && cal.earnings) || []) {
      if (!e || !e.date || e.date < from || e.date > to) continue;
      if (st.scope === 'watchlist' && !set.has(e.symbol)) continue;
      items.push({ date: e.date, sym: e.symbol, kind: 'earnings', text: calTxt(e) });
    }
    // Per-symbol events fill dividends (and earnings the market-wide feed missed).
    if (typeof cur.events === 'function') {
      const syms = watch.slice(0, 12);
      const evs = await Promise.all(syms.map((s) => Promise.resolve(cur.events(s)).then((e) => [s, e]).catch(() => [s, null])));
      for (const [s, ev] of evs) {
        if (!ev) continue;
        for (const d of ev.dividends || []) if (d.exDate && d.exDate >= from && d.exDate <= to) items.push({ date: d.exDate, sym: s, kind: 'dividend', text: i18nT('ex-date') + (fin(d.amount) ? ' · ' + fmtNum(d.amount, 4) + ' ' + (d.currency || '') : '') + (d.payDate ? ' · ' + i18nT('pays') + ' ' + d.payDate : '') });
        for (const e of ev.earnings || []) if (e.date && e.date >= from && e.date <= to && !items.some((x) => x.sym === s && x.kind === 'earnings' && x.date === e.date)) items.push({ date: e.date, sym: s, kind: 'earnings', text: calTxt(e) });
        for (const sp of ev.splits || []) if (sp.date && sp.date >= from && sp.date <= to) items.push({ date: sp.date, sym: s, kind: 'split', text: splitTxt(sp.ratio) });
      }
    }
    if (my !== token) return;
    items.sort((a, b) => a.date.localeCompare(b.date) || a.sym.localeCompare(b.sym));
    box.textContent = '';
    if (!items.length) box.appendChild(el('p', 'field-note', i18nT('Nothing scheduled in this window that your provider reports.')));
    let lastDate = '';
    for (const it of items.slice(0, 120)) {
      if (it.date !== lastDate) {
        lastDate = it.date;
        const d = new Date(it.date + 'T12:00:00Z');
        box.appendChild(el('div', 'wg-cal-date', d.toLocaleDateString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })));
      }
      const row = el('div', 'wg-cal-row');
      row.append(el('span', 'tag wg-cal-kind ' + it.kind, i18nT(it.kind === 'earnings' ? 'Earnings' : it.kind === 'dividend' ? 'Dividend' : 'Split')), symBtn(it.sym, 'wg-cal-sym'), el('span', 'wg-cal-txt', it.text));
      box.appendChild(row);
    }
    setText(status, items.length + ' ' + i18nT('events') + (safe(() => cur.isDemoMode(), false) ? ' · ' + i18nT('demo data') : ''));
  }

  function update(next) { if (next) cur = next; load(false); }
  update(cur);
  return { kind: 'calendar', update, setSymbol() {}, destroy() { token++; unwire(); host.textContent = ''; } };
}
// A split ratio arrives as a number (4 = four new shares per old one) or text.
function splitTxt(r) { return fin(Number(r)) && String(r).indexOf(':') < 0 ? Number(r) + ':1' : String(r || ''); }
function calTxt(e) {
  const parts = [];
  if (e.hour === 'bmo') parts.push(i18nT('before open')); else if (e.hour === 'amc') parts.push(i18nT('after close'));
  if (fin(e.epsEstimate)) parts.push(i18nT('EPS est.') + ' ' + fmtNum(e.epsEstimate, 2));
  return parts.join(' · ');
}
function hourTxt(h) { return h === 'bmo' ? ' · ' + i18nT('before open') : h === 'amc' ? ' · ' + i18nT('after close') : ''; }

/* =============================================================================
   FUNDAMENTALS
   ============================================================================= */
// [key, label, kind]. Percent fields arrive in percent units (0.52 = 0.52%).
const FUND_ROWS = [
  ['marketCap', 'Market cap', 'cap'], ['pe', 'P/E (trailing)', 'x'], ['forwardPe', 'P/E (forward)', 'x'], ['peg', 'PEG', 'x'],
  ['eps', 'EPS', 'money'], ['ps', 'Price / sales', 'x'], ['pb', 'Price / book', 'x'],
  ['dividendYield', 'Dividend yield', 'pct'], ['dividendPerShare', 'Dividend / share', 'money'], ['payoutRatio', 'Payout ratio', 'pct'],
  ['beta', 'Beta', 'num'], ['high52', '52-week high', 'price'], ['low52', '52-week low', 'price'],
  ['avgVolume10d', 'Avg volume (10d)', 'vol'], ['avgVolume3m', 'Avg volume (3m)', 'vol'], ['sharesOutstanding', 'Shares outstanding', 'vol'],
  ['revenueGrowth', 'Revenue growth', 'pct'], ['profitMargin', 'Profit margin', 'pct'], ['roe', 'Return on equity', 'pct'], ['debtToEquity', 'Debt / equity', 'num'],
  ['circulatingSupply', 'Circulating supply', 'vol'], ['maxSupply', 'Max supply', 'vol'], ['ath', 'All-time high', 'price'], ['atl', 'All-time low', 'price'],
];

export function renderFundamentals(box, f, opts = {}) {
  box.textContent = '';
  if (!f) {
    box.appendChild(el('p', 'field-note', i18nT(opts.empty || 'No fundamentals from your data provider for this symbol. Funds, FX pairs and some listings have none.')));
    return;
  }
  const grid = el('div', 'kv-grid wg-fund-grid');
  const ccy = f.currency || (opts.quote && opts.quote.currency) || null;
  let n = 0;
  for (const [k, label, kind] of FUND_ROWS) {
    const v = f[k];
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    n++;
    const kk = el('div', 'kv-k', i18nT(label));
    const lid = learnIdFor('fundamentals', k);
    if (lid && opts.help !== false) kk.appendChild(helpIcon(lid));
    let txt;
    if (kind === 'cap') txt = capFmt(v, ccy);
    else if (kind === 'x') txt = fmtNum(v, 2) + (k === 'peg' ? '' : '×');
    else if (kind === 'pct') txt = fmtNum(v, 2) + '%';
    else if (kind === 'money') txt = (ccy && ccy !== 'USD' ? ccy + ' ' : '$') + fmtNum(v, 2);
    else if (kind === 'price') txt = fmtPrice(v, ccy, opts.fx ? { fx: true } : undefined);
    else if (kind === 'vol') txt = fmtVolume(v);
    else txt = fmtNum(v, 2);
    if (k === 'high52' && f.high52Date) txt += ' (' + f.high52Date + ')';
    if (k === 'low52' && f.low52Date) txt += ' (' + f.low52Date + ')';
    const vv = el('div', 'kv-v' + (kind === 'money' || kind === 'price' || kind === 'cap' ? ' amount' : ''), txt);
    grid.append(kk, vv);
  }
  if (!n) { box.appendChild(el('p', 'field-note', i18nT('Your provider returned no figures for this symbol.'))); return; }
  box.appendChild(grid);
  const asOf = f.asOf ? (typeof f.asOf === 'number' ? ymd(f.asOf) : String(f.asOf).slice(0, 10)) : '';
  box.appendChild(el('p', 'field-note', i18nT('Source') + ': ' + (f.source || '—') + (asOf ? ' · ' + i18nT('as of') + ' ' + asOf : '') + ' · ' + i18nT('Figures can lag company filings.')));
}

export function renderEvents(box, ev, opts = {}) {
  box.textContent = '';
  const today = ymd(Date.now());
  const e = ev || {};
  const nextE = (e.earnings || []).filter((x) => x && x.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const lastE = (e.earnings || []).filter((x) => x && x.date < today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const nextD = (e.dividends || []).filter((x) => x && x.exDate >= today).sort((a, b) => a.exDate.localeCompare(b.exDate))[0];
  const lastD = (e.dividends || []).filter((x) => x && x.exDate < today).sort((a, b) => b.exDate.localeCompare(a.exDate))[0];
  const lastS = (e.splits || []).filter((x) => x && x.date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const grid = el('div', 'kv-grid');
  const add = (label, txt, learn) => { const k = el('div', 'kv-k', i18nT(label)); if (learn) k.appendChild(helpIcon(learn)); grid.append(k, el('div', 'kv-v', txt)); };
  if (nextE) add('Next earnings', nextE.date + hourTxt(nextE.hour) + (fin(nextE.epsEstimate) ? ' · ' + i18nT('EPS est.') + ' ' + fmtNum(nextE.epsEstimate, 2) : ''), 'earnings-report');
  if (lastE) add('Last earnings', lastE.date + (fin(lastE.epsActual) ? ' · EPS ' + fmtNum(lastE.epsActual, 2) : '') + (fin(lastE.epsEstimate) ? ' ' + i18nT('vs est.') + ' ' + fmtNum(lastE.epsEstimate, 2) : ''), 'eps');
  if (nextD) add('Next ex-dividend', nextD.exDate + (fin(nextD.amount) ? ' · ' + fmtNum(nextD.amount, 4) + ' ' + (nextD.currency || '') : ''), 'ex-dividend-date');
  else if (lastD) add('Last ex-dividend', lastD.exDate + (fin(lastD.amount) ? ' · ' + fmtNum(lastD.amount, 4) + ' ' + (lastD.currency || '') : ''), 'ex-dividend-date');
  if (lastS) add('Last split', lastS.date + ' · ' + splitTxt(lastS.ratio), 'stock-split');
  if (!grid.childElementCount) { box.appendChild(el('p', 'field-note', i18nT(opts.empty || 'No earnings, dividend or split dates from your data provider.'))); return; }
  box.appendChild(grid);
}

function createFundamentals(host, ctx) {
  let cur = ctx || {};
  let pinned = null;
  const root = el('div', 'wg-fund');
  const head = el('div', 'wg-head');
  const symEl = symBtn('', 'wg-sym');
  const name = el('span', 'field-note', '');
  head.append(symEl, name);
  const box = el('div', 'wg-fund-body');
  const evBox = el('div', 'wg-fund-ev');
  root.append(head, box, evBox);
  host.appendChild(root);
  const unwire = wirePicks(head, () => cur);
  let token = 0, shown = '', at = 0;

  async function load(force) {
    const sym = subjectOf(cur, pinned);
    if (!force && sym === shown && Date.now() - at < EVENTS_TTL) return;
    shown = sym; at = Date.now();
    const my = ++token;
    setText(symEl, sym || i18nT('No symbol'));
    symEl.dataset.sym = sym || '';
    const p = sym ? profileOf(cur, sym) : null;
    setText(name, p && p.name ? p.name : '');
    if (!sym) { renderFundamentals(box, null, { empty: 'Link this widget to a symbol, or pin one to it.' }); evBox.textContent = ''; return; }
    if (typeof cur.fundamentals !== 'function') { renderFundamentals(box, null, { empty: 'Fundamentals load in the main window.' }); return; }
    box.textContent = ''; box.appendChild(el('p', 'field-note', i18nT('Loading…')));
    const [f, ev] = await Promise.all([
      Promise.resolve(cur.fundamentals(sym)).catch(() => null),
      typeof cur.events === 'function' ? Promise.resolve(cur.events(sym)).catch(() => null) : null,
    ]);
    if (my !== token) return;
    renderFundamentals(box, f, { quote: quoteOf(cur, sym), fx: safe(() => cur.marketFor(sym), '') === 'FX' });
    renderEvents(evBox, ev);
  }

  function update(next) { if (next) cur = next; applyPrivacy(host, cur); load(false); }
  update(cur);
  return { kind: 'fundamentals', update, setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; load(false); }, destroy() { token++; unwire(); host.textContent = ''; } };
}

/* ---- registry entries -------------------------------------------------------- */
export const MARKET_WIDGETS = [
  { id: 'screener', label: 'Screener', desc: 'Scan the watchlist or a bundled list with filters and educational presets.', needsSymbol: false, minW: 4, minH: 3, defaultW: 12, defaultH: 6, create: createScreener },
  { id: 'heatmap', label: 'Heatmap', desc: 'Day change as coloured tiles, sized by market cap and grouped by sector.', needsSymbol: false, minW: 3, minH: 3, defaultW: 6, defaultH: 5, create: createHeatmap },
  { id: 'movers', label: 'Movers', desc: 'Top gainers, losers and most active in a list.', needsSymbol: false, minW: 3, minH: 3, defaultW: 4, defaultH: 5, create: createMovers },
  { id: 'compare', label: 'Compare', desc: 'Percent performance of up to eight symbols over one period.', needsSymbol: false, minW: 4, minH: 4, defaultW: 6, defaultH: 6, create: createCompare },
  { id: 'news', label: 'News', desc: 'Headlines for the linked symbol or the whole watchlist.', needsSymbol: true, minW: 3, minH: 3, defaultW: 4, defaultH: 5, create: createNews },
  { id: 'calendar', label: 'Calendar', desc: 'Earnings and dividend dates for the watchlist.', needsSymbol: false, minW: 3, minH: 3, defaultW: 4, defaultH: 5, create: createCalendar },
  { id: 'fundamentals', label: 'Fundamentals', desc: 'Key statistics for one symbol: valuation, dividends, 52-week range.', needsSymbol: true, minW: 3, minH: 3, defaultW: 4, defaultH: 5, create: createFundamentals },
];
