/* workspace.js — tabs, the tiling grid, symbol linking and the persistence of
   both. The structural idea is borrowed from a brokerage terminal: the user
   composes tabs, each tab holds independently configured widgets, and one
   selected symbol propagates to whichever widgets asked to follow it.

   Three decisions carry the file.

   LAYOUT IS DATA, NOT DOM. A widget owns { col, row, w, h } on a fixed
   twelve-column grid and nothing else; the frame's only inline style is the
   grid area derived from those four numbers. Dragging therefore edits four
   integers and repaints, which is what makes an in-progress drag cancellable
   (restore the numbers) and persistable (write the numbers) without the DOM
   being consulted. Collisions are resolved by pushing the intruded widget down
   — never by letting two frames share a cell, because a grid cell holding two
   widgets shows one and silently hides the other. A widget's own saved state —
   the table's columns and sort order — rides along on the same record as an
   opaque `state` field: this file never reads it, only carries it and hands it
   back through ctx.widgetState.

   HIDDEN TABS DO NOT EXIST. Switching tabs destroys the outgoing widgets and
   constructs the incoming ones instead of toggling `hidden`. A widget that is
   merely hidden still gets update(ctx) on every poll tick, so five tabs of
   history would cost five tabs of work forever; this way an inactive tab costs
   exactly its stored JSON. The price is that a widget must be cheap to rebuild,
   which is already the contract createWidget() implies.

   LINKING IS PER WIDGET, SELECTION IS PER WORKSPACE. There is one selected
   symbol. A linked widget renders it, a pinned widget renders its own, and the
   distinction is persisted per widget — so a pinned chart of SPY beside a
   linked quote is a layout you can save, which is the entire point of the
   feature. The selection itself is deliberately NOT persisted as a field: it is
   recovered from the linked widgets' own last symbol, so there is only one
   place a stale symbol could come from. */

import { store, normalizeSymbol } from './store.js';
import { WIDGETS, createWidget, widgetMeta } from './widgets.js';

const COLS = 12;
const MAX_ROW = 200;          // a runaway push-down cascade must terminate somewhere
const SAVE_MS = 400;          // debounce: a drag is hundreds of pointermoves, not hundreds of writes
const DRAG_SLOP = 5;          // px before a press on a tab or header becomes a drag rather than a click
const FALLBACK_ROW_H = 68;
const FALLBACK_GAP = 12;

// Which popout panel hosts which widget kind. The panel ids are the ones
// displays.js has always had, so a stored popout config keeps working; the kind
// travels alongside so the panel knows what to draw.
const PANEL_FOR_KIND = {
  cards: 'board', table: 'board', chart: 'board', alerts: 'board',
  quote: 'ticker', portfolio: 'portfolio', session: 'portfolio', tape: 'strip',
};

const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };

let idSeq = 0;
function mintId(prefix) { return prefix + Date.now().toString(36) + (idSeq++).toString(36); }

function clampInt(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/* ---- widget metadata ------------------------------------------------------
   Every read of the registry goes through here. An unknown kind is kept rather
   than dropped: a layout written by a later version of the app must survive a
   round trip through an older one, and createWidget() already promises an
   honest placeholder for a kind it does not know. */
function meta(kind) {
  const m = safe(() => widgetMeta(kind)) || null;
  return {
    kind,
    label: (m && m.label) || kind,
    needsSymbol: !!(m && m.needsSymbol),
    minW: clampInt(m && m.minW, 1, COLS, 1),
    minH: clampInt(m && m.minH, 1, MAX_ROW, 1),
    defaultW: clampInt(m && m.defaultW, 1, COLS, 4),
    defaultH: clampInt(m && m.defaultH, 1, MAX_ROW, 4),
  };
}

/* ---- geometry ------------------------------------------------------------- */

function hit(a, b) {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

function clampRect(w) {
  const m = meta(w.kind);
  w.w = clampInt(w.w, m.minW, COLS, Math.max(m.minW, Math.min(m.defaultW, COLS)));
  w.h = clampInt(w.h, m.minH, MAX_ROW, Math.max(m.minH, m.defaultH));
  w.col = clampInt(w.col, 1, COLS - w.w + 1, 1);
  w.row = clampInt(w.row, 1, MAX_ROW, 1);
}

/* Deterministic placement. The widget being dragged is placed first so it lands
   where the pointer says; everything else is placed in reading order and pushed
   down until it fits. No upward gravity: a deliberate gap is a layout choice,
   and yanking widgets to row 1 would make a drag that ends in empty space
   silently do something else. */
function resolve(tab, priorityId) {
  const items = tab.widgets.slice().sort((a, b) => {
    if (a.id === priorityId) return -1;
    if (b.id === priorityId) return 1;
    return (a.row - b.row) || (a.col - b.col);
  });
  const placed = [];
  for (const it of items) {
    clampRect(it);
    while (it.row < MAX_ROW && placed.some((p) => hit(p, it))) it.row++;
    placed.push(it);
  }
  // Persist and traverse in reading order, so DOM order (and therefore Tab
  // order) matches what the eye sees.
  tab.widgets.sort((a, b) => (a.row - b.row) || (a.col - b.col));
}

function freeSlot(tab, w, h) {
  for (let row = 1; row <= MAX_ROW; row++) {
    for (let col = 1; col <= COLS - w + 1; col++) {
      const probe = { col, row, w, h };
      if (!tab.widgets.some((x) => hit(x, probe))) return { col, row };
    }
  }
  return { col: 1, row: MAX_ROW };
}

/* ---- persisted shape ------------------------------------------------------ */

function defaultWorkspace() {
  const sess = meta('session'), cards = meta('cards'), port = meta('portfolio');
  const sh = Math.max(sess.minH, Math.min(sess.defaultH, 3));
  // Reproduces the pre-workspace app: the cards grid full width with the session
  // line above it, and the portfolio on its own tab. An existing user must open
  // the app and recognise it, not find an empty grid to assemble.
  const watch = {
    id: mintId('t'), name: 'Watchlist',
    widgets: [
      { id: mintId('w'), kind: 'session', symbol: null, linked: false, col: 1, row: 1, w: COLS, h: sh },
      { id: mintId('w'), kind: 'cards', symbol: null, linked: false, col: 1, row: 1 + sh, w: COLS,
        h: Math.max(cards.minH, cards.defaultH, 6) },
    ],
  };
  const folio = {
    id: mintId('t'), name: 'Portfolio',
    widgets: [
      { id: mintId('w'), kind: 'portfolio', symbol: null, linked: false, col: 1, row: 1, w: COLS,
        h: Math.max(port.minH, port.defaultH, 6) },
    ],
  };
  return { v: 1, activeTab: watch.id, tabs: [watch, folio] };
}

function uniqueId(raw, prefix, seen) {
  let id = (typeof raw === 'string' && raw.trim()) ? raw.trim() : '';
  if (!id || seen.has(id)) id = mintId(prefix);
  seen.add(id);
  return id;
}

// Coerce rather than trust: this JSON may have been hand-edited, written by a
// different version, or truncated by a full quota.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return null;
  const seenT = new Set(), seenW = new Set();
  const tabs = [];
  for (const t of raw.tabs) {
    if (!t || typeof t !== 'object') continue;
    const widgets = [];
    for (const w of Array.isArray(t.widgets) ? t.widgets : []) {
      if (!w || typeof w !== 'object' || typeof w.kind !== 'string' || !w.kind) continue;
      const item = {
        id: uniqueId(w.id, 'w', seenW),
        kind: w.kind,
        symbol: (typeof w.symbol === 'string' && w.symbol) ? normalizeSymbol(w.symbol) || null : null,
        // Absent flag: a widget pinned to a symbol meant to keep it, anything
        // else meant to follow the workspace.
        linked: typeof w.linked === 'boolean' ? w.linked : !w.symbol,
        col: w.col, row: w.row, w: w.w, h: w.h,
      };
      clampRect(item);
      // A widget's own saved state (the table's column set and sort order) is
      // opaque here and carried through untouched. Rebuilding the record without
      // it is how it used to be erased: store.js round-trips `state` correctly,
      // and the first save after boot wrote back the stripped copy.
      if (w.state && typeof w.state === 'object' && !Array.isArray(w.state)) item.state = w.state;
      widgets.push(item);
    }
    const name = (typeof t.name === 'string' && t.name.trim()) ? t.name.trim().slice(0, 40) : 'Tab';
    const tab = { id: uniqueId(t.id, 't', seenT), name, widgets };
    resolve(tab, null);
    tabs.push(tab);
  }
  if (!tabs.length) return null;
  const active = tabs.some((t) => t.id === raw.activeTab) ? raw.activeTab : tabs[0].id;
  return { v: 1, activeTab: active, tabs };
}

/* ---- module state --------------------------------------------------------- */

let model = null;                 // the persisted object; store owns the bytes, we own the shape
let persisted = false;            // false: store.js is too old to hold workspaces, so we run from memory
let host = null;                  // element handed to init(); everything below it is ours
let ctxFn = () => ({});
let root = null, tabStrip = null, grid = null, picker = null, pickerBtn = null, pickerWrap = null;
let shellWired = false;
let selected = null;              // the workspace symbol; recovered from the linked widgets on boot
let saveTimer = null;
let saveNote = null;              // the line that says a layout write was refused
let saveRefused = false;
let drag = null;                  // the one in-progress pointer gesture, if any
const frames = new Map();         // widget id -> { id, wrap, body, inst, symSel, linkBtn, symKey }
const listeners = new Set();

function activeTab() {
  if (!model) return null;
  return model.tabs.find((t) => t.id === model.activeTab) || model.tabs[0] || null;
}
function findWidget(id) {
  if (!model) return null;
  for (const t of model.tabs) {
    const w = t.widgets.find((x) => x.id === id);
    if (w) return { tab: t, widget: w };
  }
  return null;
}

function emit() {
  const snap = workspace.tabs();
  for (const cb of [...listeners]) {
    try { cb({ tabs: snap, activeTab: model ? model.activeTab : null, selection: selected }); }
    catch (e) { /* a bad listener must not stop the rest, or the save */ }
  }
}

/* Writes are debounced because a drag is hundreds of pointermove events and
   localStorage is synchronous; `now` is for the end of a gesture, where the
   layout is final and losing it to a closing tab would be indefensible. */
function persist(now) {
  if (!persisted || !model) return;
  const write = () => { reportSave(safe(() => store.saveWorkspaces(), false) !== false); };
  if (now) { clearTimeout(saveTimer); saveTimer = null; write(); return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; write(); }, SAVE_MS);
}

/* A refused write has to be said out loud. Under a shared link the layout key is
   frozen on purpose — someone else's board must not rewrite the arrangement you
   come back to — but silently discarding a drag, a new tab or a column choice is
   the same experience as a bug. The watchlist at least has the hash banner to
   explain itself; this is the layout's equivalent, and it clears itself the
   moment a write succeeds (adopting or dismissing the link does that). */
function reportSave(ok) {
  if (saveRefused === !ok) return;      // nothing changed
  saveRefused = !ok;
  paintSaveNote();
}

function paintSaveNote() {
  if (!saveNote) return;
  saveNote.hidden = !saveRefused;
  // Emptied rather than left behind: a hidden node holding the previous reason is
  // a wrong sentence waiting for the next stylesheet to reveal it.
  if (!saveRefused) { saveNote.textContent = ''; return; }
  saveNote.textContent = safe(() => store.hashActive, false)
    ? 'Layout changes are not saved while you are viewing a shared link.'
    : 'Layout changes could not be saved — this browser refused the write.';
}

/* ---- grid metrics ---------------------------------------------------------
   Pointer deltas have to become column and row counts, which needs the used
   cell size. It is read back off the laid-out grid rather than assumed: the CSS
   owns the row height and the gap, and hard-coding either here would make a
   stylesheet change silently break dragging. */
function px(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Is the grid actually tiling right now? The stylesheet drops to a flex column
// under its own breakpoint, and the breakpoint belongs to the stylesheet — asking
// the resolved layout keeps this from becoming a second copy of that number.
function isTiling() {
  const cs = safe(() => getComputedStyle(grid), null);
  return !!cs && cs.display === 'grid';
}

function metrics() {
  const cs = safe(() => getComputedStyle(grid), null);
  const gap = cs ? px(cs.columnGap, FALLBACK_GAP) : FALLBACK_GAP;
  const rowGap = cs ? px(cs.rowGap, gap) : gap;
  let rowH = FALLBACK_ROW_H;
  if (cs) {
    const rows = String(cs.gridTemplateRows || '').trim().split(/\s+/);
    rowH = px(rows[0], px(cs.getPropertyValue('--wk-row'), FALLBACK_ROW_H));
    if (!(rowH > 0)) rowH = FALLBACK_ROW_H;
  }
  const width = grid ? grid.clientWidth : 0;
  const inner = Math.max(0, width - (cs ? px(cs.paddingLeft, 0) + px(cs.paddingRight, 0) : 0));
  const colW = Math.max(1, (inner - gap * (COLS - 1)) / COLS);
  return { colW, rowH, gap, rowGap };
}

function paintRects(tab) {
  for (const w of tab.widgets) {
    const f = frames.get(w.id);
    if (!f) continue;
    f.wrap.style.gridColumn = w.col + ' / span ' + w.w;
    f.wrap.style.gridRow = w.row + ' / span ' + w.h;
    f.wrap.setAttribute('data-rect', w.col + ',' + w.row + ',' + w.w + ',' + w.h);
  }
}

function apply(tab, priorityId) {
  resolve(tab, priorityId);
  paintRects(tab);
}

/* ---- symbols and linking -------------------------------------------------- */

/* The symbol a widget is actually showing. `c`, when given, allows the same last
   resort the widgets themselves take (widgets.js subjectOf falls back to the first
   watched symbol rather than rendering an empty panel) — without it the header
   select read '—' while the chart under it was drawing AAPL. Callers that are
   asking "what has the user pinned" pass nothing and get the honest null. */
function symbolOf(w, c) {
  if (!meta(w.kind).needsSymbol) return null;
  const own = w.linked ? (selected || w.symbol || null) : (w.symbol || null);
  if (own) return own;
  const list = c && Array.isArray(c.symbols) ? c.symbols.filter(Boolean) : [];
  return list[0] || null;
}

// No ctx here on purpose: pushing the first-watched fallback into a widget would
// PIN it there, which is a different thing from the widget choosing it as a
// subject and reverting the moment the watchlist changes.
function pushSymbol(w) {
  const f = frames.get(w.id);
  if (!f || !f.inst || typeof f.inst.setSymbol !== 'function') return;
  try { f.inst.setSymbol(symbolOf(w)); } catch (e) { /* a widget that rejects a symbol keeps its old one */ }
}

// Recover the selection from what the linked widgets were last showing, so a
// reload does not blank every linked widget until the user clicks something.
// Only ever seeds: an established selection must survive a tab switch, or the
// two halves of "linked" would disagree about which symbol is current.
function seedSelection() {
  const tab = activeTab();
  if (selected || !tab) return;
  for (const w of tab.widgets) {
    if (w.linked && meta(w.kind).needsSymbol && w.symbol) { selected = w.symbol; return; }
  }
}

/* ---- widget frames -------------------------------------------------------- */

function createFrame(w) {
  const m = meta(w.kind);
  const wrap = el('section', 'wk-w');
  wrap.dataset.id = w.id;
  wrap.dataset.kind = w.kind;

  const head = el('header', 'wk-w-head');
  const grip = el('button', 'wk-w-grip', '⠿');
  grip.type = 'button';
  grip.title = 'Move — drag, or arrow keys';
  grip.setAttribute('aria-label', 'Move ' + m.label + ' widget');
  // Pointer events only work on a surface the browser is not also panning.
  grip.style.touchAction = 'none';
  head.appendChild(grip);
  head.appendChild(el('span', 'wk-w-title', m.label));
  head.appendChild(el('span', 'spacer'));

  let symSel = null, linkBtn = null;
  if (m.needsSymbol) {
    symSel = el('select', 'cs-select sm wk-w-sym');
    symSel.setAttribute('aria-label', 'Symbol for ' + m.label + ' widget');
    symSel.addEventListener('change', () => { workspace.setWidgetSymbol(w.id, symSel.value); });
    head.appendChild(symSel);

    linkBtn = el('button', 'icon-mini wk-w-link', 'Link');
    linkBtn.type = 'button';
    linkBtn.addEventListener('click', () => { workspace.setWidgetLink(w.id, !w.linked); });
    head.appendChild(linkBtn);
  }

  const pop = el('button', 'icon-mini wk-w-pop', '⧉');
  pop.type = 'button';
  pop.title = 'Pop out to another window';
  pop.setAttribute('aria-label', 'Pop out ' + m.label + ' widget');
  // Warm the module on press, not on click: displays.open() needs the click's
  // transient activation, and awaiting a cold import first can spend it.
  pop.addEventListener('pointerdown', () => { loadDisplays(); });
  pop.addEventListener('click', () => { workspace.popOut(w.id); });
  head.appendChild(pop);

  const kill = el('button', 'icon-mini wk-w-x', '✕');
  kill.type = 'button';
  kill.title = 'Remove widget';
  kill.setAttribute('aria-label', 'Remove ' + m.label + ' widget');
  kill.addEventListener('click', () => { workspace.removeWidget(w.id); });
  head.appendChild(kill);

  const body = el('div', 'wk-w-body');

  const size = el('button', 'wk-w-size');
  size.type = 'button';
  size.title = 'Resize — drag, or arrow keys';
  size.setAttribute('aria-label', 'Resize ' + m.label + ' widget');
  size.style.touchAction = 'none';

  wrap.appendChild(head);
  wrap.appendChild(body);
  wrap.appendChild(size);
  grid.appendChild(wrap);

  const f = { id: w.id, wrap, body, inst: null, symSel, linkBtn, symKey: '' };
  frames.set(w.id, f);

  // The header background drags; its controls do not, so a mis-hit on a select
  // never starts a gesture that swallows the click.
  head.style.touchAction = 'none';
  head.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    if (ev.target.closest('button, select, input, label') && !ev.target.closest('.wk-w-grip')) return;
    beginGesture(w.id, ev, 'move');
  });
  grip.addEventListener('keydown', (ev) => nudge(ev, w.id, 'move'));
  size.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    beginGesture(w.id, ev, 'size');
  });
  size.addEventListener('keydown', (ev) => nudge(ev, w.id, 'size'));

  // A widget that throws in its constructor must not take the tab down with it.
  try { f.inst = createWidget(w.kind, body, forWidget(decorate(ctx()), w)); }
  catch (e) { f.inst = null; body.appendChild(el('p', 'wk-w-fail', 'This widget failed to load.')); }
  if (m.needsSymbol) pushSymbol(w);
  return f;
}

function destroyFrame(id) {
  const f = frames.get(id);
  if (!f) return;
  frames.delete(id);
  if (f.inst && typeof f.inst.destroy === 'function') safe(() => f.inst.destroy());
  if (f.wrap.parentNode) f.wrap.parentNode.removeChild(f.wrap);
}

function destroyAllFrames() {
  for (const id of [...frames.keys()]) destroyFrame(id);
}

// Reconcile frames against the active tab. Only structural changes come through
// here; a poll tick goes to update() and touches no DOM structure at all.
function syncFrames() {
  const tab = activeTab();
  const keep = new Set(tab ? tab.widgets.map((w) => w.id) : []);
  for (const id of [...frames.keys()]) if (!keep.has(id)) destroyFrame(id);
  if (!tab) return;
  for (const w of tab.widgets) if (!frames.has(w.id)) createFrame(w);
  // DOM order follows reading order so keyboard traversal matches the eye.
  for (const w of tab.widgets) {
    const f = frames.get(w.id);
    if (f) grid.appendChild(f.wrap);
  }
  paintRects(tab);
  renderEmpty(tab);
}

function renderEmpty(tab) {
  const existing = grid.querySelector('.wk-empty');
  if (tab.widgets.length) { if (existing) existing.remove(); return; }
  if (existing) return;
  const box = el('div', 'wk-empty');
  box.appendChild(el('p', null, 'This tab is empty.'));
  const add = el('button', 'btn-primary', 'Add a widget');
  add.type = 'button';
  add.addEventListener('click', () => openPicker());
  box.appendChild(add);
  grid.appendChild(box);
}

/* ---- ctx ------------------------------------------------------------------ */

function ctx() {
  const c = safe(() => ctxFn(), null);
  return (c && typeof c === 'object') ? c : {};
}

// Widgets ask the workspace to change the selection through ctx.onSelect. The
// host's own handler is kept and called too — it may open a drawer or scroll a
// rail — but the linking itself is wired here so it cannot be forgotten there.
function decorate(base) {
  const outer = typeof base.onSelect === 'function' ? base.onSelect : null;
  return {
    ...base,
    selection: selected,
    onSelect(sym) {
      workspace.select(sym);
      if (outer) safe(() => outer(sym));
    },
  };
}

/* The per-widget half of the ctx. It has to be a clone rather than the shared
   object: onWidgetState closes over ONE widget record, so handing every widget
   the same ctx would let whichever was decorated last own the hook and write its
   columns into another widget's slot. The state itself is opaque — the widget
   canonicalizes it on the way back in, and store.js caps its size. */
function forWidget(shared, w) {
  return {
    ...shared,
    widgetState: w.state || null,
    onWidgetState(next) {
      const keep = (next && typeof next === 'object' && !Array.isArray(next)) ? next : null;
      if (keep) w.state = keep; else delete w.state;
      // A column toggle or a header click is a finished gesture, not a drag.
      persist(true);
    },
  };
}

function syncHeader(f, w, c) {
  if (!f.symSel) return;
  const m = meta(w.kind);
  const cur = symbolOf(w, c);
  const list = Array.isArray(c.symbols) ? c.symbols.filter(Boolean) : [];
  const opts = cur && !list.includes(cur) ? [cur, ...list] : list.slice();
  const key = (cur || '') + '|' + opts.join(',');
  // Rebuilding the option list on every tick would fight an open dropdown.
  if (key !== f.symKey) {
    f.symKey = key;
    f.symSel.textContent = '';
    if (!cur) {
      const none = el('option', null, '—');
      none.value = '';
      f.symSel.appendChild(none);
    }
    for (const s of opts) {
      const o = el('option', null, s);
      o.value = s;
      f.symSel.appendChild(o);
    }
  }
  if (f.symSel.value !== (cur || '')) f.symSel.value = cur || '';
  if (f.linkBtn) {
    f.linkBtn.setAttribute('aria-pressed', w.linked ? 'true' : 'false');
    f.linkBtn.classList.toggle('active', !!w.linked);
    f.linkBtn.title = w.linked
      ? 'Linked to the workspace symbol — click to pin ' + (cur || 'this widget')
      : 'Pinned to ' + (cur || 'no symbol') + ' — click to follow the workspace symbol';
    f.linkBtn.setAttribute('aria-label', (w.linked ? 'Unlink ' : 'Link ') + m.label + ' widget');
  }
}

/* ---- tab strip ------------------------------------------------------------ */

function renderTabs() {
  if (!tabStrip || !model) return;
  tabStrip.textContent = '';
  for (const t of model.tabs) {
    const active = t.id === model.activeTab;
    // A presentational wrapper, because a tab that owns a close button cannot be
    // a single <button>: nesting buttons is invalid and unreachable by keyboard.
    const item = el('div', 'wk-tab' + (active ? ' active' : ''));
    item.setAttribute('role', 'presentation');
    item.dataset.id = t.id;

    const btn = el('button', 'wk-tab-btn', t.name);
    btn.type = 'button';
    btn.id = 'wk-tab-' + t.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.setAttribute('aria-controls', 'wk-panel');
    btn.tabIndex = active ? 0 : -1;
    btn.title = t.name + ' — double-click to rename';
    btn.style.touchAction = 'none';
    btn.addEventListener('click', () => workspace.setActiveTab(t.id));
    btn.addEventListener('dblclick', () => beginRename(t.id));
    btn.addEventListener('keydown', (ev) => onTabKey(ev, t.id));
    btn.addEventListener('pointerdown', (ev) => beginTabDrag(t.id, ev));
    item.appendChild(btn);

    const x = el('button', 'wk-tab-x', '✕');
    x.type = 'button';
    x.title = 'Delete tab';
    x.setAttribute('aria-label', 'Delete tab ' + t.name);
    x.addEventListener('click', (ev) => { ev.stopPropagation(); workspace.removeTab(t.id); });
    item.appendChild(x);

    tabStrip.appendChild(item);
  }
  const add = el('button', 'wk-tab-add', '＋');
  add.type = 'button';
  add.title = 'New tab';
  add.setAttribute('aria-label', 'New tab');
  add.addEventListener('click', () => workspace.addTab());
  tabStrip.appendChild(add);

  const at = activeTab();
  if (grid && at) grid.setAttribute('aria-labelledby', 'wk-tab-' + at.id);
}

function onTabKey(ev, id) {
  if (!model) return;
  const i = model.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  let j = -1;
  if (ev.key === 'ArrowLeft') j = i - 1;
  else if (ev.key === 'ArrowRight') j = i + 1;
  else if (ev.key === 'Home') j = 0;
  else if (ev.key === 'End') j = model.tabs.length - 1;
  else if (ev.key === 'F2') { ev.preventDefault(); beginRename(id); return; }
  else if (ev.key === 'Delete') { ev.preventDefault(); workspace.removeTab(id); return; }
  else return;
  if (j < 0 || j >= model.tabs.length) return;
  ev.preventDefault();
  workspace.setActiveTab(model.tabs[j].id);
  const next = tabBtn(model.tabs[j].id);
  if (next) next.focus();
}

// Found by walking the strip rather than by building a selector: an id loaded
// from storage is foreign text, and foreign text in a selector is a bug waiting
// for someone to hand-edit an export.
function tabItem(id) {
  if (!tabStrip) return null;
  for (const item of tabStrip.querySelectorAll('.wk-tab')) if (item.dataset.id === id) return item;
  return null;
}
function tabBtn(id) {
  const item = tabItem(id);
  return item ? item.querySelector('.wk-tab-btn') : null;
}

function beginRename(id) {
  if (!model) return;
  const tab = model.tabs.find((t) => t.id === id);
  const btn = tabBtn(id);
  if (!tab || !btn) return;
  const input = el('input', 'input wk-tab-edit');
  input.value = tab.name;
  input.setAttribute('aria-label', 'Tab name');
  input.maxLength = 40;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) workspace.renameTab(id, input.value);
    else renderTabs();
    const back = tabBtn(id);
    if (back) back.focus();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  btn.replaceWith(input);
  input.focus();
  input.select();
}

/* Tab reorder. The gesture starts on the tab button, so it must not steal the
   click that switches tabs: nothing moves until the pointer has travelled far
   enough to mean it. */
function beginTabDrag(id, ev) {
  if (!model || model.tabs.length < 2) return;
  if (ev.button != null && ev.button !== 0) return;
  const btn = ev.currentTarget;
  const x0 = ev.clientX;
  const order = model.tabs.map((t) => t.id);
  let moving = false;
  try { btn.setPointerCapture(ev.pointerId); } catch (e) { /* capture is a nicety, not a requirement */ }

  const onMove = (e) => {
    if (!moving && Math.abs(e.clientX - x0) < DRAG_SLOP) return;
    moving = true;
    btn.classList.add('wk-tab-moving');
    const items = [...tabStrip.querySelectorAll('.wk-tab')];
    let index = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { index = i; break; }
    }
    const cur = model.tabs.findIndex((t) => t.id === id);
    if (cur !== index) {
      workspace.reorderTab(id, index);
      // renderTabs() has just replaced the element the pointer was captured on,
      // so the capture has to be re-taken or the rest of the drag is lost.
      const again = tabBtn(id);
      if (again) { again.classList.add('wk-tab-moving'); safe(() => again.setPointerCapture(e.pointerId)); }
    }
  };
  const end = (cancel) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancelled);
    window.removeEventListener('keydown', onKey, true);
    if (cancel && moving) {
      model.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      persist(true);
    }
    if (moving) { renderTabs(); emit(); }
  };
  const up = () => end(false);
  const cancelled = () => end(true);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); end(true); } };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancelled);
  window.addEventListener('keydown', onKey, true);
}

/* ---- move / resize gestures ----------------------------------------------- */

function snapshotRects(tab) {
  return tab.widgets.map((w) => ({ id: w.id, col: w.col, row: w.row, w: w.w, h: w.h }));
}
function restoreRects(tab, snap) {
  for (const s of snap) {
    const w = tab.widgets.find((x) => x.id === s.id);
    if (w) { w.col = s.col; w.row = s.row; w.w = s.w; w.h = s.h; }
  }
}

function beginGesture(id, ev, mode) {
  if (drag) return;
  const found = findWidget(id);
  const tab = activeTab();
  if (!found || !tab || found.tab !== tab) return;
  const w = found.widget;
  const f = frames.get(id);
  if (!f) return;
  // Below the responsive breakpoint the grid becomes a flex column, so the
  // inline grid-column/grid-row this gesture writes are inert — the drag would
  // have no visible effect here while silently rewriting the desktop layout it
  // is not showing. Ask the layout what it actually is rather than re-deriving
  // the breakpoint in a second place that can drift from the stylesheet.
  if (!isTiling()) return;

  ev.preventDefault();
  const m = metrics();
  const stepX = m.colW + m.gap, stepY = m.rowH + m.rowGap;
  const start = { col: w.col, row: w.row, w: w.w, h: w.h };
  const snap = snapshotRects(tab);
  const x0 = ev.clientX, y0 = ev.clientY;
  const target = ev.currentTarget;
  safe(() => target.setPointerCapture(ev.pointerId));
  // preventDefault above suppresses the focus a press would normally give the
  // handle, and the handle is also the keyboard entry point to the same gesture.
  safe(() => { if (target.focus) target.focus(); });
  grid.classList.add('wk-dragging');
  f.wrap.classList.add(mode === 'move' ? 'wk-w-moving' : 'wk-w-sizing');
  let moved = false;

  const onMove = (e) => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    moved = true;
    const dc = Math.round(dx / stepX), dr = Math.round(dy / stepY);
    if (mode === 'move') { w.col = start.col + dc; w.row = start.row + dr; }
    else { w.w = start.w + dc; w.h = start.h + dr; }
    // clampRect inside resolve() is what keeps the widget on the grid; a drag
    // past the twelfth column stops rather than wrapping.
    apply(tab, id);
  };
  const finish = (cancel) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancelled);
    window.removeEventListener('keydown', onKey, true);
    grid.classList.remove('wk-dragging');
    f.wrap.classList.remove('wk-w-moving');
    f.wrap.classList.remove('wk-w-sizing');
    drag = null;
    if (cancel) { restoreRects(tab, snap); apply(tab, null); }
    if (moved) { persist(true); emit(); }
  };
  const up = () => finish(false);
  const cancelled = () => finish(true);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(true); } };

  drag = { id, mode };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancelled);
  window.addEventListener('keydown', onKey, true);
}

// The keyboard path to the same two operations. Without it the layout would be
// mouse-only, which for a tool whose whole state is a layout is not acceptable.
function nudge(ev, id, mode) {
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = map[ev.key];
  if (!d) return;
  const found = findWidget(id);
  if (!found) return;
  ev.preventDefault();
  const w = found.widget;
  if (mode === 'move') workspace.moveWidget(id, w.col + d[0], w.row + d[1]);
  else workspace.resizeWidget(id, w.w + d[0], w.h + d[1]);
}

/* ---- add-widget picker ---------------------------------------------------- */

function renderPicker() {
  picker.textContent = '';
  const list = Array.isArray(WIDGETS) ? WIDGETS : [];
  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const row = el('button', 'wk-pick', null);
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.appendChild(el('span', 'wk-pick-label', entry.label || entry.id));
    if (entry.desc) row.appendChild(el('span', 'wk-pick-desc', entry.desc));
    row.addEventListener('click', () => { closePicker(); workspace.addWidget(entry.id); });
    row.addEventListener('keydown', onPickerKey);
    picker.appendChild(row);
  }
  if (!picker.childNodes.length) picker.appendChild(el('p', 'wk-pick-desc', 'No widgets are registered.'));
}

function onPickerKey(ev) {
  const items = [...picker.querySelectorAll('.wk-pick')];
  const i = items.indexOf(ev.currentTarget);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const j = (i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[j].focus();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closePicker();
    if (pickerBtn) pickerBtn.focus();
  }
}

function openPicker() {
  renderPicker();
  picker.hidden = false;
  if (pickerBtn) pickerBtn.setAttribute('aria-expanded', 'true');
  const first = picker.querySelector('.wk-pick');
  if (first) first.focus();
}

function closePicker() {
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  if (pickerBtn) pickerBtn.setAttribute('aria-expanded', 'false');
}

/* ---- shell --------------------------------------------------------------- */

function buildShell() {
  host.textContent = '';
  root = el('div', 'wk-root');

  const bar = el('div', 'wk-bar');
  tabStrip = el('div', 'wk-tabs');
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'Workspace tabs');
  bar.appendChild(tabStrip);
  bar.appendChild(el('span', 'spacer'));

  const wrap = el('div', 'wk-picker-wrap');
  pickerBtn = el('button', 'cs-btn wk-add', '＋ Widget');
  pickerBtn.type = 'button';
  pickerBtn.setAttribute('aria-haspopup', 'menu');
  pickerBtn.setAttribute('aria-expanded', 'false');
  pickerBtn.addEventListener('click', () => { if (picker.hidden) openPicker(); else closePicker(); });
  picker = el('div', 'wk-picker');
  picker.setAttribute('role', 'menu');
  picker.hidden = true;
  wrap.appendChild(pickerBtn);
  wrap.appendChild(picker);
  bar.appendChild(wrap);

  const reset = el('button', 'cs-btn wk-reset', 'Reset layout');
  reset.type = 'button';
  reset.title = 'Restore the default tabs and widgets';
  reset.addEventListener('click', () => {
    if (safe(() => window.confirm('Discard your tabs and widgets and restore the default workspace?'), true)) workspace.reset();
  });
  bar.appendChild(reset);

  saveNote = el('p', 'field-note wk-savenote', '');
  saveNote.setAttribute('role', 'status');
  saveNote.hidden = true;
  paintSaveNote();      // a refusal survives a shell rebuild

  grid = el('div', 'wk-grid');
  grid.id = 'wk-panel';
  grid.setAttribute('role', 'tabpanel');

  root.appendChild(bar);
  root.appendChild(saveNote);
  root.appendChild(grid);
  host.appendChild(root);

  pickerWrap = wrap;
  // Document-level listeners are wired once even if the shell is rebuilt, so a
  // second init() cannot double-fire them.
  if (!shellWired) {
    shellWired = true;
    document.addEventListener('pointerdown', (ev) => {
      if (!picker || picker.hidden) return;
      if (pickerWrap && !pickerWrap.contains(ev.target)) closePicker();
    });
    // A layout is worth more than the 400 ms of debounce it might be sitting in.
    window.addEventListener('pagehide', () => persist(true));
  }
}

/* ---- displays (lazy) -----------------------------------------------------
   displays.js probes permissions and registers mesh handlers at import time, so
   it must not be pulled in until something actually asks for a second window. */
let displaysMod = null;
function loadDisplays() {
  if (!displaysMod) displaysMod = import('./displays.js').catch(() => null);
  return displaysMod;
}

/* ---- public API ---------------------------------------------------------- */

export const workspace = {
  init(hostEl, getCtx) {
    if (!hostEl) return;
    destroyAllFrames();   // a second init() must not leak the first one's widgets
    host = hostEl;
    if (typeof getCtx === 'function') ctxFn = getCtx;

    // store.js owns the bytes. If it is too old to know about workspaces we run
    // from memory rather than writing a key we do not own: a lost layout is a
    // regression, a corrupted store is a bug report.
    if (typeof store.ensureWorkspaces === 'function') safe(() => store.ensureWorkspaces(defaultWorkspace));
    // Unreadable stored JSON becomes the default workspace rather than an empty
    // screen, and the default is written back, so a layout that failed to parse
    // once does not fail to parse on every load from here on.
    const shape = normalize(store.workspaces) || defaultWorkspace();
    const canSave = typeof store.saveWorkspaces === 'function';
    const target = (store.workspaces && typeof store.workspaces === 'object' && !Array.isArray(store.workspaces))
      ? store.workspaces : null;
    if (canSave && target) {
      // Mutate in place: other modules may already hold this reference.
      target.v = 1;
      target.activeTab = shape.activeTab;
      target.tabs = shape.tabs;
      model = target;
      persisted = true;
    } else if (canSave) {
      store.workspaces = shape;
      model = store.workspaces || shape;
      persisted = true;
    } else {
      model = shape;
      persisted = false;
    }

    buildShell();
    seedSelection();
    renderTabs();
    syncFrames();
    this.update();
    if (persisted) persist(true);
    emit();
  },

  // Called on every poll tick, so it does no DOM surgery: it hands each live
  // widget the new ctx and lets the widget decide what changed. One widget that
  // throws must not cost the others their frame.
  update() {
    if (!model || !grid) return;
    const tab = activeTab();
    if (!tab) return;
    const base = ctx();
    const shared = decorate(base);
    for (const w of tab.widgets) {
      const f = frames.get(w.id);
      if (!f) continue;
      syncHeader(f, w, base);
      if (!f.inst || typeof f.inst.update !== 'function') continue;
      try { f.inst.update(forWidget(shared, w)); }
      catch (e) { f.wrap.classList.add('wk-w-error'); }
    }
  },

  tabs() {
    if (!model) return [];
    return model.tabs.map((t) => ({
      id: t.id, name: t.name,
      widgets: t.widgets.map((w) => ({ ...w })),
    }));
  },

  activeTabId() { return model ? model.activeTab : null; },

  setActiveTab(id) {
    if (!model || !model.tabs.some((t) => t.id === id) || model.activeTab === id) return;
    model.activeTab = id;
    // Destroy first: the outgoing widgets must release their state before the
    // incoming ones are built, or a hidden tab would cost a tick forever.
    destroyAllFrames();
    seedSelection();
    renderTabs();
    syncFrames();
    this.update();
    persist(false);
    emit();
  },

  addTab(name) {
    if (!model) return null;
    const clean = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 40) : 'Tab ' + (model.tabs.length + 1);
    const tab = { id: mintId('t'), name: clean, widgets: [] };
    model.tabs.push(tab);
    model.activeTab = tab.id;
    destroyAllFrames();
    renderTabs();
    syncFrames();
    this.update();
    persist(true);
    emit();
    return tab.id;
  },

  renameTab(id, name) {
    if (!model) return;
    const tab = model.tabs.find((t) => t.id === id);
    if (!tab) return;
    const clean = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 40) : tab.name;
    if (clean !== tab.name) { tab.name = clean; persist(true); }
    renderTabs();
    emit();
  },

  /* Deleting the last tab reseeds the default workspace instead of failing.
     An app with no tabs has no add-tab button either, so "you may not do that"
     and "here is a fresh start" are the only two honest answers, and the second
     one is recoverable. */
  removeTab(id) {
    if (!model) return;
    const tab = model.tabs.find((t) => t.id === id);
    if (!tab) return;
    const msg = tab.widgets.length
      ? 'Delete the tab "' + tab.name + '" and its ' + tab.widgets.length + ' widget'
        + (tab.widgets.length === 1 ? '' : 's') + '?'
      : 'Delete the tab "' + tab.name + '"?';
    if (!safe(() => window.confirm(msg), true)) return;
    if (model.tabs.length <= 1) { this.reset(); return; }
    model.tabs = model.tabs.filter((t) => t.id !== id);
    if (model.activeTab === id) model.activeTab = model.tabs[0].id;
    destroyAllFrames();
    seedSelection();
    renderTabs();
    syncFrames();
    this.update();
    persist(true);
    emit();
  },

  reorderTab(id, index) {
    if (!model) return;
    const i = model.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const j = clampInt(index, 0, model.tabs.length - 1, i);
    if (i === j) return;
    const [tab] = model.tabs.splice(i, 1);
    model.tabs.splice(j, 0, tab);
    renderTabs();
    persist(false);
    emit();
  },

  addWidget(kind, opts = {}) {
    if (!model) return null;
    const tab = (opts.tab && model.tabs.find((t) => t.id === opts.tab)) || activeTab();
    if (!tab) return null;
    const m = meta(kind);
    const w = clampInt(opts.w, m.minW, COLS, Math.max(m.minW, Math.min(m.defaultW, COLS)));
    const h = clampInt(opts.h, m.minH, MAX_ROW, Math.max(m.minH, m.defaultH));
    const spot = (opts.col != null && opts.row != null)
      ? { col: clampInt(opts.col, 1, COLS - w + 1, 1), row: clampInt(opts.row, 1, MAX_ROW, 1) }
      : freeSlot(tab, w, h);
    const sym = typeof opts.symbol === 'string' ? normalizeSymbol(opts.symbol) || null : null;
    const item = {
      id: mintId('w'), kind: String(kind || ''),
      symbol: m.needsSymbol ? (sym || selected || null) : null,
      // A new symbol widget follows the workspace unless it was handed a symbol
      // of its own, which is the only reason to ask for one explicitly.
      linked: m.needsSymbol ? (typeof opts.linked === 'boolean' ? opts.linked : !sym) : false,
      col: spot.col, row: spot.row, w, h,
    };
    tab.widgets.push(item);
    if (tab === activeTab()) {
      apply(tab, item.id);
      syncFrames();
      this.update();
    } else {
      resolve(tab, item.id);
    }
    persist(true);
    emit();
    return item.id;
  },

  removeWidget(id) {
    const found = findWidget(id);
    if (!found) return;
    destroyFrame(id);
    found.tab.widgets = found.tab.widgets.filter((w) => w.id !== id);
    if (found.tab === activeTab()) { syncFrames(); }
    persist(true);
    emit();
  },

  /* A linked widget's symbol is the workspace's symbol, so setting it moves the
     whole workspace. Silently pinning it instead would be the more literal
     reading of this call and the more surprising behaviour: the chain button is
     the only thing that should ever break a link. */
  setWidgetSymbol(id, sym) {
    const found = findWidget(id);
    if (!found) return;
    const w = found.widget;
    if (!meta(w.kind).needsSymbol) return;
    const clean = normalizeSymbol(sym) || null;
    if (w.linked) { this.select(clean); return; }
    if (w.symbol === clean) return;
    w.symbol = clean;
    pushSymbol(w);
    const f = frames.get(id);
    if (f) syncHeader(f, w, ctx());
    persist(true);
    emit();
  },

  setWidgetLink(id, linked) {
    const found = findWidget(id);
    if (!found) return;
    const w = found.widget;
    if (!meta(w.kind).needsSymbol) return;
    const on = !!linked;
    if (w.linked === on) return;
    // Unlinking keeps what is on screen: the symbol it was showing becomes the
    // pinned one, so nothing visibly changes at the moment of the click.
    // Linking adopts the selection — and writes it through, because a linked
    // widget's stored symbol is what the next boot recovers the selection from.
    // ctx() so "what is on screen" includes the widgets' own first-symbol
    // fallback: unlinking a widget that was showing the first watched symbol has
    // to pin that symbol, not null.
    if (!on) w.symbol = symbolOf(w, ctx());
    else if (selected) w.symbol = selected;
    else if (w.symbol) selected = w.symbol;
    w.linked = on;
    pushSymbol(w);
    const f = frames.get(id);
    if (f) syncHeader(f, w, ctx());
    persist(true);
    emit();
  },

  moveWidget(id, col, row) {
    const found = findWidget(id);
    if (!found || found.tab !== activeTab()) return;
    const w = found.widget;
    w.col = clampInt(col, 1, COLS, w.col);
    w.row = clampInt(row, 1, MAX_ROW, w.row);
    apply(found.tab, id);
    persist(false);
    emit();
  },

  resizeWidget(id, w, h) {
    const found = findWidget(id);
    if (!found || found.tab !== activeTab()) return;
    const item = found.widget;
    const m = meta(item.kind);
    item.w = clampInt(w, m.minW, COLS, item.w);
    item.h = clampInt(h, m.minH, MAX_ROW, item.h);
    apply(found.tab, id);
    persist(false);
    emit();
  },

  select(sym) {
    const clean = normalizeSymbol(sym) || null;
    if (clean === selected) return;
    selected = clean;
    const tab = activeTab();
    if (tab) {
      const base = ctx();
      for (const w of tab.widgets) {
        if (!w.linked || !meta(w.kind).needsSymbol) continue;
        // Written through so a reload can recover the selection from the widgets.
        w.symbol = clean;
        pushSymbol(w);
        const f = frames.get(w.id);
        if (f) syncHeader(f, w, base);
      }
    }
    persist(false);
    emit();
  },

  selection() { return selected; },

  async popOut(id) {
    const found = findWidget(id);
    if (!found) return { ok: false, reason: 'unknown-widget' };
    const w = found.widget;
    const mod = await loadDisplays();
    if (!mod || !mod.displays) return { ok: false, reason: 'displays-unavailable' };
    const panel = PANEL_FOR_KIND[w.kind] || 'board';
    // The symbol on screen, fallback included: a detached copy of a widget must
    // open on what the widget was showing, not on nothing.
    return mod.displays.open(panel, { widget: { kind: w.kind, symbol: symbolOf(w, ctx()) } });
  },

  reset() {
    if (!model) return;
    const fresh = defaultWorkspace();
    model.v = 1;
    model.tabs = fresh.tabs;
    model.activeTab = fresh.activeTab;
    destroyAllFrames();
    selected = null;
    seedSelection();
    renderTabs();
    syncFrames();
    this.update();
    persist(true);
    emit();
  },

  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
