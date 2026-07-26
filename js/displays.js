/* displays.js — the popout / Picture-in-Picture host. Runs in the MAIN window and
   is the only place that opens, places, tracks and closes secondary panel windows.

   WHY BOTH MECHANISMS SHIP. Window Management popouts and Document Picture-in-Picture
   are complementary, not competing, and neither one covers the whole job:

     Document PiP  - always-on-top, survives tab switching and minimising, needs no
                     permission prompt and no compositor cooperation (so it is the one
                     thing that still works under Wayland). But exactly one PiP window
                     may exist per document, it is small, it cannot be aimed at a
                     chosen monitor, and it is Chromium-only.
     Window popout - as many windows as you like, real size, aimable at a specific
                     screen, and it degrades to an ordinary popup in every browser.
                     But it is not always-on-top, popup blockers can kill it outright,
                     and Wayland compositors ignore programmatic placement entirely.

   So 'auto' arbitrates rather than picks a winner: an explicitly chosen monitor plus
   getScreenDetails means a real window, because aiming at a monitor is the whole
   reason to choose one; otherwise the panel's own default wins - 'strip' is a
   glance-value tape and belongs in an always-on-top PiP, while 'board', 'ticker' and
   'portfolio' want size and want to stay put, so they get a window; and when the
   preferred mechanism is missing we fall through to whatever remains, ending at a
   plain popup, which always exists.

   Placement is best-effort BY DESIGN. moveTo/resizeTo is honoured on Windows, macOS
   and X11 and silently ignored on Wayland. Rather than pretend it worked, the
   geometry is read back afterwards and the panel is marked placed:false, so the UI
   can say "drag it across once" instead of lying.

   A PANEL ID IS A WINDOW IDENTITY, NOT A CONTENT TYPE. Since the workspace landed,
   a panel can host any widget from widgets.js — but the four ids below are baked
   into stored configs and into the window NAME that lets a reload re-adopt a popout
   it no longer holds a handle for, so they do not change and a widget rides along
   inside the panel entry instead of replacing them. The widget also never appears
   in the URL: which symbol somebody is watching is market interest, and the
   standing rule here is that none of it travels through a query string or a window
   name. popout.js reads it back out of storage with panelConfig().

   That storage round-trip is why open() reloads a panel whose widget it changes.
   The panel decides what to draw when it LOADS, so rewriting the entry under a
   window already on screen would leave storage describing a panel that is not
   there — and this module can move a window, not repaint one. */

import { store } from './store.js';
// A panel hosted inside the PiP document cannot close itself, so the only way it
// can ask to be closed is over the mesh. peers.js imports nothing, so there is no
// cycle and no cost to listening here.
import { peers } from './peers.js';
// widgetMeta only, and only to read a widget's declared shape: a popped-out widget
// is built by widgets.js inside the panel document, never here. The registry is
// safe to pull in at load — widgets.js and widget-table.js define tables and
// functions at module scope and run nothing until something calls createWidget,
// and the one module in that graph with an import-time side effect (store.js,
// which migrates) is already imported above.
import { widgetMeta } from './widgets.js';

const CFG_KEY = 'stk_popouts';
const POPOUT_PAGE = 'popout.html';
const WIN_PREFIX = 'stkPanel_';
// Some window managers reset a popup's position right after it paints, so the
// move/resize is re-fired a couple of times. Straight from the Retina popout.
const PLACE_AT = [80, 260];
const VERIFY_AT = 520;
const VERIFY_SLOP = 60;
const POLL_MS = 1500;

export const PANELS = [
  { id: 'board', label: 'Board', desc: 'Watchlist grid, readable across a room.',
    defaultMode: 'window', fill: true, w: 1280, h: 800, pipW: 640, pipH: 460 },
  { id: 'ticker', label: 'Ticker', desc: 'One symbol, very large.',
    defaultMode: 'window', fill: true, w: 900, h: 620, pipW: 520, pipH: 360 },
  { id: 'portfolio', label: 'Portfolio', desc: 'Totals only — value, day P/L, total P/L.',
    defaultMode: 'window', fill: true, w: 760, h: 560, pipW: 480, pipH: 340 },
  { id: 'strip', label: 'Strip', desc: 'Compact one-line tape. Defaults to Picture-in-Picture.',
    defaultMode: 'pip', fill: false, w: 560, h: 150, pipW: 480, pipH: 132 },
];

/* ---- Widgets in panels -----------------------------------------------------
   Each legacy panel has one canonical widget: the thing it already drew before
   widgets.js existed. Asking for that widget in that panel is not a change of
   content, so the panel keeps its own hand-measured window size — those numbers
   were arrived at by looking at that exact content, and a size computed from grid
   units would be a worse answer reached more cleverly.

   Any OTHER widget in a panel does get its size from widgets.js, so a widget's
   shape has one owner. Grid units mean nothing in a window with no 12-column
   parent, so they are read as a shape and scaled: COL_PX and ROW_PX are chosen so
   the full-width table (12x6) lands near the Board window it borrows, and a
   widget under FILL_ROWS rows is treated as a strip, which must not swallow a
   whole monitor just because one was aimed at it. */

const KIND_FOR_PANEL = { board: 'cards', ticker: 'quote', portfolio: 'portfolio', strip: 'tape' };
// Every widget kind maps onto one of the four panels. Exported as a function so
// the workspace does not have to keep a second copy of this table in step.
const PANEL_FOR_KIND = {
  cards: 'board', table: 'board', chart: 'board', alerts: 'board',
  quote: 'ticker',
  portfolio: 'portfolio', session: 'portfolio',
  tape: 'strip',
};
const FALLBACK_WIDGET = 'cards';

const COL_PX = 96;
const ROW_PX = 84;
const CHROME_PX = 96;          // popout.html's own header and status strip
const MIN_WIN = { w: 420, h: 220 };
const FILL_ROWS = 4;
const PIP_SCALE = { w: 0.55, h: 0.6 };
const PIP_MIN = { w: 320, h: 120 };
const PIP_MAX = { w: 640, h: 460 };

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export function panelForWidget(kind) {
  return Object.prototype.hasOwnProperty.call(PANEL_FOR_KIND, kind) ? PANEL_FOR_KIND[kind] : 'board';
}

// The other direction: what a legacy panel has always drawn, for a receiver that
// would rather render one widget than keep a second renderer per panel id.
export function widgetForPanel(panelId) {
  return KIND_FOR_PANEL[panelId] || null;
}

function widgetSpec(kind) {
  if (typeof kind !== 'string' || !kind) return null;
  try { return widgetMeta(kind) || null; } catch (e) { return null; }
}

function cleanSymbol(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 40);
  return s || null;
}

/* Turns whatever a caller passed into a widget record that is always renderable.
   An unknown kind is the normal case, not a corrupt one — a layout outlives the
   release that wrote it — so it is substituted rather than refused: an empty
   window reads as a broken popout, while the watchlist at least shows the market.
   The note is how the substitution reaches the reader, because this side cannot
   draw inside a document it has not opened yet. */
function resolveWidget(raw) {
  if (raw == null) return null;
  const req = typeof raw === 'object' ? raw : {};
  const asked = typeof req.kind === 'string' ? req.kind.trim() : '';
  const symbol = cleanSymbol(req.symbol);
  if (widgetSpec(asked)) return { kind: asked, symbol, requested: null, note: null };
  return {
    kind: FALLBACK_WIDGET,
    symbol,
    requested: asked || null,
    note: asked
      ? 'Showing the watchlist: this version has no "' + asked + '" widget.'
      : 'Showing the watchlist: the panel was opened without naming a widget.',
  };
}

// Re-resolved from the ORIGINAL request, not from the substitute that was stored,
// so a kind this build does not know can start working the day it does. A stored
// note is carried over when re-resolution produced none of its own: the reason a
// panel is showing a substitute must survive the round trip through storage, or a
// reload would quietly turn the substitute into the truth.
function inheritWidget(saved) {
  const w = saved && typeof saved === 'object' ? saved.widget : null;
  if (!w || typeof w !== 'object') return null;
  const out = resolveWidget({ kind: w.requested || w.kind, symbol: w.symbol });
  if (out && !out.note && typeof w.note === 'string' && w.note && out.kind === w.kind) out.note = w.note;
  return out;
}

function sameWidget(a, b) {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.symbol === b.symbol;
}

function widgetBox(meta) {
  const cols = clamp(Math.round(Number(meta.defaultW) || 1), Math.max(1, Math.round(Number(meta.minW) || 1)), 12);
  const rows = Math.max(1, Math.round(Number(meta.defaultH) || 1), Math.round(Number(meta.minH) || 1));
  const w = Math.max(MIN_WIN.w, cols * COL_PX);
  const h = Math.max(MIN_WIN.h, rows * ROW_PX + CHROME_PX);
  return {
    w, h,
    pipW: clamp(Math.round(w * PIP_SCALE.w), PIP_MIN.w, PIP_MAX.w),
    pipH: clamp(Math.round(h * PIP_SCALE.h), PIP_MIN.h, PIP_MAX.h),
    fill: rows >= FILL_ROWS,
  };
}

// The PANELS entry the rest of this module works against. Only sizing and the
// label move; id, defaultMode and everything keyed off them stay legacy.
function effectivePanel(panel, widget) {
  if (!panel || !widget) return panel;
  const meta = widgetSpec(widget.kind);
  const label = meta ? meta.label + (widget.symbol ? ' — ' + widget.symbol : '') : panel.label;
  if (!meta || widget.kind === KIND_FOR_PANEL[panel.id]) return { ...panel, label };
  return { ...panel, ...widgetBox(meta), label };
}

// title is what popout.js names the window; it is cleared alongside the widget so
// a panel reverting to its legacy content cannot keep a widget's heading.
function widgetPatch(panel, widget) {
  return { widget: widget || null, title: widget ? panel.label : null };
}

/* ---- Storage --------------------------------------------------------------
   Panel choices and the monitor snapshot share one key. The snapshot has to be
   persisted because the live ScreenDetails handle dies with the page, and a
   popout re-asserting its own geometry after a reload has nothing else to read. */

function lsGet(key) {
  try { const v = localStorage.getItem(key); return v == null ? null : JSON.parse(v); }
  catch (e) { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode */ }
}

function normalizeConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    v: 1,
    panels: (c.panels && typeof c.panels === 'object') ? c.panels : {},
    screens: Array.isArray(c.screens) ? c.screens : [],
    screensAt: Number(c.screensAt) || 0,
    currentScreen: typeof c.currentScreen === 'string' ? c.currentScreen : null,
  };
}

function readConfig() {
  const fromStore = (store && store.popouts && typeof store.popouts === 'object') ? store.popouts : null;
  return normalizeConfig(fromStore || lsGet(CFG_KEY));
}

function writeConfig(cfg) {
  if (store && store.popouts && typeof store.popouts === 'object') {
    // Mutate in place: other modules may already hold a reference to store.popouts.
    for (const k of Object.keys(store.popouts)) delete store.popouts[k];
    Object.assign(store.popouts, cfg);
    if (typeof store.savePopouts === 'function') {
      try { store.savePopouts(); return; } catch (e) { /* fall through to direct write */ }
    }
  }
  lsSet(CFG_KEY, cfg);
}

/* ---- Capabilities ---------------------------------------------------------
   support() is synchronous and must never prompt, so the permission state is
   probed lazily in the background and reported as 'prompt' until the answer
   lands. Nothing here touches getScreenDetails(). */

let permState = null;
let permProbed = false;

function probePermission() {
  if (permProbed) return;
  permProbed = true;
  if (!('getScreenDetails' in window)) { permState = 'unavailable'; return; }
  // Only a guess, and only when nothing better is known: a refusal we watched
  // happen outranks anything this probe could assume.
  if (permState == null) permState = 'prompt';
  const ask = (name) => {
    try { return navigator.permissions.query({ name }); }
    catch (e) { return Promise.reject(e); }
  };
  if (!navigator.permissions || !navigator.permissions.query) return;
  // Older Chromium shipped this as 'window-placement'.
  ask('window-management').catch(() => ask('window-placement')).then((st) => {
    if (!st) return;
    // A dismissed prompt reports 'prompt' again even though the call we made was
    // refused, so a refusal we witnessed is not overwritten by that reading. A
    // later 'change' event is a real transition and always is.
    if (!(permState === 'denied' && st.state === 'prompt')) permState = st.state;
    if (st.addEventListener) st.addEventListener('change', () => { permState = st.state; emit(); });
    emit();
  }, () => {});
}

/* ---- Screens -------------------------------------------------------------- */

let details = null;   // live ScreenDetails handle, null before detectScreens()

function screenId(i) { return 's' + i; }

function describe(s, i, current) {
  const w = s.width || s.availWidth || 0;
  const h = s.height || s.availHeight || 0;
  return {
    id: screenId(i),
    index: i,
    label: '#' + (i + 1) + ' · ' + w + '×' + h + (s.isPrimary ? ' · primary' : ''),
    left: s.left || 0, top: s.top || 0, width: w, height: h,
    availLeft: s.availLeft != null ? s.availLeft : (s.left || 0),
    availTop: s.availTop != null ? s.availTop : (s.top || 0),
    availWidth: s.availWidth || w, availHeight: s.availHeight || h,
    primary: !!s.isPrimary,
    current: !!current,
  };
}

function listFromDetails(d) {
  try {
    return d.screens.map((s, i) => describe(s, i, s === d.currentScreen));
  } catch (e) { return []; }
}

function snapshot() {
  if (!details) return;
  const list = listFromDetails(details);
  if (!list.length) return;
  const cfg = readConfig();
  cfg.screens = list;
  cfg.screensAt = Date.now();
  const cur = list.find((s) => s.current);
  cfg.currentScreen = cur ? cur.id : null;
  writeConfig(cfg);
}

// Usable box for a monitor: prefer the work area so a placed window does not sit
// under the taskbar / dock.
function screenBox(g) {
  return {
    L: g.availLeft != null ? g.availLeft : (g.left || 0),
    T: g.availTop != null ? g.availTop : (g.top || 0),
    W: g.availWidth || g.width || 1280,
    H: g.availHeight || g.height || 800,
  };
}

function geometryFor(cfg, id) {
  if (id == null) return null;
  if (details) {
    const live = listFromDetails(details).find((s) => s.id === id);
    if (live) return live;
  }
  const saved = cfg.screens.find((s) => s.id === id);
  return saved || null;
}

function targetBox(panel, geom) {
  if (geom) {
    const b = screenBox(geom);
    // A monitor was chosen deliberately, so the big panels take the whole work
    // area; a one-line tape would look absurd stretched across it.
    if (panel.fill) return b;
    const W = Math.min(panel.w, b.W), H = Math.min(panel.h, b.H);
    return { L: b.L + Math.round((b.W - W) / 2), T: b.T + Math.round((b.H - H) / 2), W, H };
  }
  const sc = window.screen || {};
  const aw = sc.availWidth || 1280, ah = sc.availHeight || 800;
  const al = sc.availLeft || 0, at = sc.availTop || 0;
  const W = Math.min(panel.w, aw), H = Math.min(panel.h, ah);
  return { L: al + Math.round((aw - W) / 2), T: at + Math.round((ah - H) / 2), W, H };
}

function place(win, box) {
  if (!win || !box) return;
  const go = () => {
    try {
      if (win.closed) return;
      win.moveTo(box.L, box.T);
      win.resizeTo(box.W, box.H);
      win.moveTo(box.L, box.T);
    } catch (e) { /* cross-window call refused, or Wayland */ }
  };
  go();
  for (const ms of PLACE_AT) setTimeout(go, ms);
}

// Read the geometry back rather than assume it took. Wayland reports the window
// wherever the compositor decided to put it, which is exactly the honest answer.
function verifyPlacement(entry, box) {
  if (!entry || entry.mode !== 'window' || !entry.win) return;
  let ok = null;
  try {
    if (entry.win.closed) return;
    const x = entry.win.screenX, y = entry.win.screenY;
    if (typeof x === 'number' && typeof y === 'number') {
      ok = Math.abs(x - box.L) <= VERIFY_SLOP && Math.abs(y - box.T) <= VERIFY_SLOP;
    }
  } catch (e) { ok = null; }
  if (entry.placed !== ok) { entry.placed = ok; emit(); }
}

/* ---- Live panels ---------------------------------------------------------- */

const live = new Map();   // panelId -> { panelId, mode, screenId, win|pip, placed }
const listeners = new Set();
let pollTimer = null;

function panelById(id) { return PANELS.find((p) => p.id === id) || null; }

// The URL is deliberately opaque: a panel id and nothing else. Symbols, keys and
// holdings never travel through a window name or a query string.
function panelUrl(id) {
  try { return new URL(POPOUT_PAGE + '?panel=' + encodeURIComponent(id), location.href).href; }
  catch (e) { return POPOUT_PAGE + '?panel=' + encodeURIComponent(id); }
}

function snapshotPanels() {
  return [...live.values()].map((e) => ({
    panelId: e.panelId,
    mode: e.mode,
    screenId: e.screenId,
    alive: isAlive(e),
    placed: e.placed,
    widget: e.widget ? e.widget.kind : null,
    symbol: e.widget ? e.widget.symbol : null,
  }));
}

function isAlive(e) {
  try { return e.mode === 'pip' ? !!(e.pip && !e.pip.closed) : !!(e.win && !e.win.closed); }
  catch (err) { return false; }
}

function emit() {
  const list = snapshotPanels();
  for (const cb of [...listeners]) { try { cb(list); } catch (e) { /* a bad listener is not our problem */ } }
}

// There is no close event on a popup, only a handle that flips .closed.
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    let changed = false;
    for (const [id, e] of [...live]) if (!isAlive(e)) { live.delete(id); persistPanel(id, { open: false }); changed = true; }
    if (!live.size) { clearInterval(pollTimer); pollTimer = null; }
    if (changed) emit();
  }, POLL_MS);
}

function persistPanel(panelId, patch) {
  const cfg = readConfig();
  cfg.panels[panelId] = { ...(cfg.panels[panelId] || {}), ...patch };
  writeConfig(cfg);
}

// The box goes to storage with the mode, because the popout re-asserts its own
// geometry after the opener reloads and by then this window's handle — and every
// number derived from it — is gone. `kind` travels with it so a panel id can stay
// opaque without the receiver having to guess what to draw; it stays the PANEL's
// kind, since that is the field popout.js has always read.
function persistPlacement(panel, chosenScreen, box, widget) {
  persistPanel(panel.id, {
    mode: 'window', screenId: chosenScreen, kind: panel.id, open: true,
    rect: { left: box.L, top: box.T, width: box.W, height: box.H },
    ...widgetPatch(panel, widget),
  });
}

// A panel reads its widget from storage at load time, so a live window whose entry
// just changed is showing the wrong thing until it loads again. Same origin both
// ways, so this is a navigation we are allowed to make.
function reloadPanel(entry) {
  if (!entry) return;
  try {
    if (entry.mode === 'pip') {
      if (!entry.frame) return;
      try { entry.frame.contentWindow.location.reload(); }
      catch (e) { entry.frame.src = entry.frame.src; }
      return;
    }
    if (entry.win && !entry.win.closed) entry.win.location.reload();
  } catch (e) { /* the window is gone, or refused the navigation */ }
}

function resolveMode(panel, requested, chosenScreen, sup) {
  if (requested === 'pip') return sup.pip ? 'pip' : 'window';
  if (requested === 'window') return 'window';
  // auto: an explicitly aimed monitor is the strongest signal there is.
  if (sup.windowMgmt && chosenScreen) return 'window';
  if (panel.defaultMode === 'pip' && sup.pip) return 'pip';
  if (panel.defaultMode === 'window') return 'window';
  return sup.pip ? 'pip' : 'window';
}

/* ---- Window mode ---------------------------------------------------------- */

function openWindow(panel, chosenScreen, sup, widget) {
  const cfg = readConfig();
  const geom = geometryFor(cfg, chosenScreen);
  const box = targetBox(panel, geom);
  // Built BEFORE anything that could yield: awaiting getScreenDetails() first
  // spends the transient activation and the popup is blocked outright.
  const feats = 'popup,left=' + box.L + ',top=' + box.T + ',width=' + box.W + ',height=' + box.H +
    ',menubar=no,toolbar=no,location=no,status=no,scrollbars=yes,resizable=yes';

  let win = null;
  try { win = window.open(panelUrl(panel.id), WIN_PREFIX + panel.id, feats); }
  catch (e) { win = null; }
  if (!win) {
    live.delete(panel.id);
    emit();
    return { ...result(panel, 'window', chosenScreen, widget), ok: false, reason: 'popup-blocked' };
  }

  const entry = { panelId: panel.id, mode: 'window', screenId: chosenScreen, win, pip: null, frame: null, placed: null, widget };
  live.set(panel.id, entry);
  persistPlacement(panel, chosenScreen, box, widget);
  place(win, box);
  setTimeout(() => verifyPlacement(entry, box), VERIFY_AT);
  try { win.focus(); } catch (e) {}

  // A monitor was picked but we have no geometry for it (fresh profile, or the
  // snapshot predates a display change). Ask now that the window is already up,
  // so a slow permission round-trip cannot cost us the popup.
  if (!geom && chosenScreen && sup.windowMgmt) {
    displays.detectScreens().then(() => {
      const g = geometryFor(readConfig(), chosenScreen);
      if (!g || !isAlive(entry)) return;
      const b = targetBox(panel, g);
      persistPlacement(panel, chosenScreen, b, widget);
      place(entry.win, b);
      setTimeout(() => verifyPlacement(entry, b), VERIFY_AT);
    }, () => {});
  }

  startPoll();
  emit();
  return result(panel, 'window', chosenScreen, widget);
}

/* ---- Picture-in-Picture mode ----------------------------------------------
   requestWindow() needs a user gesture and only ONE PiP window may exist per
   document, so an existing one is closed first, inside the same gesture.
   The PiP document is blank and same-origin: it hosts popout.html in a frame so
   the popout stays a single implementation, and the parent stylesheets are copied
   in so the shell around that frame is styled from the first paint. */

function copyStyles(doc) {
  try {
    for (const sheet of document.styleSheets) {
      if (sheet.href) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        // Relative hrefs resolve against the PiP document, not this page, and the
        // self-hosted fonts would 404 without a sound.
        link.href = new URL(sheet.href, location.href).href;
        doc.head.appendChild(link);
      } else if (sheet.ownerNode && sheet.ownerNode.textContent) {
        const style = doc.createElement('style');
        style.textContent = sheet.ownerNode.textContent;
        doc.head.appendChild(style);
      }
    }
  } catch (e) { /* a cross-origin sheet we cannot read is not worth failing over */ }
}

async function openPip(panel, chosenScreen, widget) {
  for (const e of [...live.values()]) if (e.mode === 'pip') closePanel(e.panelId);

  // Written before the await, so a panel that ends up loading anyway — the frame
  // below, or a cold open by URL — never reads an entry describing the old widget.
  persistPanel(panel.id, { kind: panel.id, ...widgetPatch(panel, widget) });

  let pip = null;
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: panel.pipW, height: panel.pipH });
  } catch (e) { pip = null; }
  if (!pip) {
    // The gesture is spent by now, so the popup fallback will probably be blocked.
    // Try anyway and let openWindow report the truth.
    return openWindow(panel, chosenScreen, displays.support(), widget);
  }

  let frame = null;
  try {
    const doc = pip.document;
    doc.title = 'Carino Stocks — ' + panel.label;
    copyStyles(doc);
    const shell = doc.createElement('style');
    shell.textContent = 'html,body{margin:0;height:100%;overflow:hidden}' +
      'iframe{display:block;border:0;width:100%;height:100%}';
    doc.head.appendChild(shell);
    frame = doc.createElement('iframe');
    frame.src = panelUrl(panel.id);
    frame.title = panel.label;
    doc.body.appendChild(frame);
  } catch (e) { /* the window is up; a styling failure is not fatal */ }

  const entry = { panelId: panel.id, mode: 'pip', screenId: chosenScreen, win: null, pip, frame, placed: null, widget };
  live.set(panel.id, entry);
  // No rect: PiP geometry belongs to the browser, and a stored one would have the
  // popout fight it on every load.
  persistPanel(panel.id, {
    mode: 'pip', screenId: chosenScreen, kind: panel.id, open: true, rect: null,
    ...widgetPatch(panel, widget),
  });
  try {
    pip.addEventListener('pagehide', () => {
      if (live.get(panel.id) !== entry) return;
      live.delete(panel.id);
      persistPanel(panel.id, { open: false });
      emit();
    }, { once: true });
  } catch (e) {}

  startPoll();
  emit();
  return result(panel, 'pip', chosenScreen, widget);
}

/* The open() return value. `widget` is the kind actually shown and `requested` the
   kind that was asked for and does not exist, so a caller can repeat the note the
   panel is displaying instead of quietly disagreeing with it. */
function result(panel, mode, chosenScreen, widget) {
  return {
    ok: true,
    panelId: panel.id,
    mode,
    screenId: chosenScreen,
    reason: null,
    widget: widget ? widget.kind : null,
    requested: widget ? widget.requested : null,
  };
}

function closePanel(panelId) {
  const e = live.get(panelId);
  live.delete(panelId);
  // Cleared even when there is no handle: a panel opened before the last reload
  // exists only as this flag, and "close" has to be able to retract it.
  persistPanel(panelId, { open: false });
  if (!e) return;
  try { if (e.mode === 'pip' && e.pip) e.pip.close(); } catch (err) {}
  try { if (e.win && !e.win.closed) e.win.close(); } catch (err) {}
}

/* ---- Public API ----------------------------------------------------------- */

export const displays = {
  support() {
    probePermission();
    return {
      windowMgmt: 'getScreenDetails' in window,
      pip: 'documentPictureInPicture' in window,
      popup: true,
      permission: permState || 'unavailable',
    };
  },

  // The ONLY entry point allowed to prompt. Call it from a click.
  async detectScreens() {
    if (!('getScreenDetails' in window)) return this.screens();
    try {
      const d = await window.getScreenDetails();
      details = d;
      if (d.addEventListener) d.addEventListener('screenschange', () => { snapshot(); emit(); });
      snapshot();
      permState = 'granted';
      emit();
      return listFromDetails(d);
    } catch (e) {
      permState = 'denied';
      permProbed = false;
      probePermission();   // correct the guess if the browser will tell us
      emit();
      return this.screens();
    }
  },

  screens() {
    if (details) {
      const list = listFromDetails(details);
      if (list.length) return list;
    }
    const cfg = readConfig();
    return cfg.screens.map((s) => ({ ...s, current: s.id === cfg.currentScreen }));
  },

  /* opts = { mode, screenId, widget }, where widget is { kind, symbol }.
     An omitted `widget` INHERITS whatever this panel was last opened with, which
     is what makes re-targeting a panel and re-adopting an orphan leave the content
     alone; pass widget: null to mean the panel's own legacy content explicitly. */
  async open(panelId, opts = {}) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const mode = o.mode === undefined ? 'auto' : o.mode;
    const screenId = o.screenId === undefined ? null : o.screenId;
    const base = panelById(panelId);
    if (!base) return { ok: false, panelId, mode: null, screenId: null, reason: 'unknown-panel', widget: null, requested: null };

    const cfg = readConfig();
    const saved = cfg.panels[panelId] || {};
    const chosen = screenId != null ? screenId : (saved.screenId || null);
    const widget = Object.prototype.hasOwnProperty.call(o, 'widget')
      ? resolveWidget(o.widget)
      : inheritWidget(saved);
    const panel = effectivePanel(base, widget);
    const sup = this.support();
    const resolved = resolveMode(panel, mode, chosen, sup);

    const existing = live.get(panelId);
    if (existing && isAlive(existing)) {
      if (existing.mode === resolved) {
        // Already up: retarget and raise it instead of spawning a second copy.
        const swapped = !sameWidget(existing.widget, widget);
        existing.screenId = chosen;
        existing.widget = widget;
        if (resolved === 'window') {
          const box = targetBox(panel, geometryFor(cfg, chosen));
          persistPlacement(panel, chosen, box, widget);
          place(existing.win, box);
          setTimeout(() => verifyPlacement(existing, box), VERIFY_AT);
        } else {
          persistPanel(panelId, {
            mode: resolved, screenId: chosen, kind: panelId, open: true,
            ...widgetPatch(panel, widget),
          });
        }
        if (swapped) reloadPanel(existing);
        try { (existing.win || existing.pip).focus(); } catch (e) {}
        emit();
        return { ...result(panel, resolved, chosen, widget), reason: 'already-open' };
      }
      closePanel(panelId);   // synchronous, so the gesture survives the swap
    }

    if (resolved === 'pip') return openPip(panel, chosen, widget);
    return openWindow(panel, chosen, sup, widget);
  },

  close(panelId) { closePanel(panelId); emit(); },

  closeAll() { for (const id of [...live.keys()]) closePanel(id); emit(); },

  openPanels() { return snapshotPanels(); },

  rePlaceAll() {
    const cfg = readConfig();
    for (const e of [...live.values()]) {
      if (e.mode !== 'window' || !isAlive(e)) continue;
      const base = panelById(e.panelId);
      if (!base) continue;
      // Through effectivePanel, or a widget-sized window would snap back to the
      // legacy panel's dimensions the first time the monitors change.
      const panel = effectivePanel(base, e.widget);
      const box = targetBox(panel, geometryFor(cfg, e.screenId));
      persistPlacement(panel, e.screenId, box, e.widget);
      place(e.win, box);
      setTimeout(() => verifyPlacement(e, box), VERIFY_AT);
    }
  },

  /* Panels the config still calls open that this window holds no handle for.
     Handles die with the page and popouts deliberately outlive their opener, so
     after a reload this list is the only trace that a panel is still on screen.
     Re-opening by id re-adopts the existing window through its shared name — but
     only from a click, which is why it is surfaced instead of done here.

     PiP panels are excluded: a PiP surface is destroyed with the document that
     requested it, so one can never be orphaned, only stale in storage. */
  orphanPanels() {
    const cfg = readConfig();
    return Object.keys(cfg.panels)
      .filter((id) => {
        const p = cfg.panels[id];
        return p && p.open && p.mode !== 'pip' && !live.has(id) && panelById(id);
      })
      .map((id) => {
        const w = inheritWidget(cfg.panels[id]);
        return {
          panelId: id, mode: 'window', screenId: cfg.panels[id].screenId || null,
          widget: w ? w.kind : null, symbol: w ? w.symbol : null,
        };
      });
  },

  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/* A panel asks to be closed rather than closing itself, because in PiP mode it
   runs in a frame inside the PiP document where window.close() does nothing.
   Registering the handler before peers.init() is deliberate and safe: on() only
   adds to a local map, and a 'bye' that lands during init would otherwise be
   dropped. */
try {
  peers.on('bye', (payload) => {
    const id = payload && payload.panel;
    if (!id || !live.has(id)) return;
    closePanel(id);
    emit();
  });
} catch (e) { /* no mesh: a window-mode panel can still close itself */ }

/* ---- Shared with popout.js -------------------------------------------------
   A popped-out window re-asserts its own geometry on load, and needs to read the
   same snapshot the host wrote. Exported here so the storage shape has exactly
   one definition. */

export function panelConfig(panelId) {
  const cfg = readConfig();
  return cfg.panels[panelId] || null;
}

/* The widget a panel should draw, already resolved: { kind, symbol, requested,
   note }, or null for a panel still showing its legacy content. Exported so the
   substitution rule for an unknown kind has one implementation instead of one on
   each side of the storage boundary — and so a panel that IS showing a substitute
   can print `note` rather than silently drawing something else. */
export function panelWidget(panelId) {
  return inheritWidget(readConfig().panels[panelId]);
}

export function screenGeometry(id) {
  const g = geometryFor(readConfig(), id);
  if (!g) return null;
  const b = screenBox(g);
  return { left: b.L, top: b.T, width: b.W, height: b.H };
}
