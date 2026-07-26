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
   can say "drag it across once" instead of lying. */

import { store } from './store.js';
// A panel hosted inside the PiP document cannot close itself, so the only way it
// can ask to be closed is over the mesh. peers.js imports nothing, so there is no
// cycle and no cost to listening here.
import { peers } from './peers.js';

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
// opaque without the receiver having to guess what to draw.
function persistPlacement(panelId, chosenScreen, box) {
  persistPanel(panelId, {
    mode: 'window', screenId: chosenScreen, kind: panelId, open: true,
    rect: { left: box.L, top: box.T, width: box.W, height: box.H },
  });
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

function openWindow(panel, chosenScreen, sup) {
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
    return { ok: false, panelId: panel.id, mode: 'window', screenId: chosenScreen, reason: 'popup-blocked' };
  }

  const entry = { panelId: panel.id, mode: 'window', screenId: chosenScreen, win, pip: null, placed: null };
  live.set(panel.id, entry);
  persistPlacement(panel.id, chosenScreen, box);
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
      persistPlacement(panel.id, chosenScreen, b);
      place(entry.win, b);
      setTimeout(() => verifyPlacement(entry, b), VERIFY_AT);
    }, () => {});
  }

  startPoll();
  emit();
  return { ok: true, panelId: panel.id, mode: 'window', screenId: chosenScreen, reason: null };
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

async function openPip(panel, chosenScreen) {
  for (const e of [...live.values()]) if (e.mode === 'pip') closePanel(e.panelId);

  let pip = null;
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: panel.pipW, height: panel.pipH });
  } catch (e) { pip = null; }
  if (!pip) {
    // The gesture is spent by now, so the popup fallback will probably be blocked.
    // Try anyway and let openWindow report the truth.
    return openWindow(panel, chosenScreen, displays.support());
  }

  try {
    const doc = pip.document;
    doc.title = 'Carino Stocks — ' + panel.label;
    copyStyles(doc);
    const shell = doc.createElement('style');
    shell.textContent = 'html,body{margin:0;height:100%;overflow:hidden}' +
      'iframe{display:block;border:0;width:100%;height:100%}';
    doc.head.appendChild(shell);
    const frame = doc.createElement('iframe');
    frame.src = panelUrl(panel.id);
    frame.title = panel.label;
    doc.body.appendChild(frame);
  } catch (e) { /* the window is up; a styling failure is not fatal */ }

  const entry = { panelId: panel.id, mode: 'pip', screenId: chosenScreen, win: null, pip, placed: null };
  live.set(panel.id, entry);
  // No rect: PiP geometry belongs to the browser, and a stored one would have the
  // popout fight it on every load.
  persistPanel(panel.id, { mode: 'pip', screenId: chosenScreen, kind: panel.id, open: true, rect: null });
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
  return { ok: true, panelId: panel.id, mode: 'pip', screenId: chosenScreen, reason: null };
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

  async open(panelId, { mode = 'auto', screenId = null } = {}) {
    const panel = panelById(panelId);
    if (!panel) return { ok: false, panelId, mode: null, screenId: null, reason: 'unknown-panel' };

    const cfg = readConfig();
    const saved = cfg.panels[panelId] || {};
    const chosen = screenId != null ? screenId : (saved.screenId || null);
    const sup = this.support();
    const resolved = resolveMode(panel, mode, chosen, sup);

    const existing = live.get(panelId);
    if (existing && isAlive(existing)) {
      if (existing.mode === resolved) {
        // Already up: retarget and raise it instead of spawning a second copy.
        existing.screenId = chosen;
        if (resolved === 'window') {
          const box = targetBox(panel, geometryFor(cfg, chosen));
          persistPlacement(panelId, chosen, box);
          place(existing.win, box);
          setTimeout(() => verifyPlacement(existing, box), VERIFY_AT);
        } else {
          persistPanel(panelId, { mode: resolved, screenId: chosen, kind: panelId, open: true });
        }
        try { (existing.win || existing.pip).focus(); } catch (e) {}
        emit();
        return { ok: true, panelId, mode: resolved, screenId: chosen, reason: 'already-open' };
      }
      closePanel(panelId);   // synchronous, so the gesture survives the swap
    }

    if (resolved === 'pip') return openPip(panel, chosen);
    return openWindow(panel, chosen, sup);
  },

  close(panelId) { closePanel(panelId); emit(); },

  closeAll() { for (const id of [...live.keys()]) closePanel(id); emit(); },

  openPanels() { return snapshotPanels(); },

  rePlaceAll() {
    const cfg = readConfig();
    for (const e of [...live.values()]) {
      if (e.mode !== 'window' || !isAlive(e)) continue;
      const panel = panelById(e.panelId);
      if (!panel) continue;
      const box = targetBox(panel, geometryFor(cfg, e.screenId));
      persistPlacement(e.panelId, e.screenId, box);
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
      .map((id) => ({ panelId: id, mode: 'window', screenId: cfg.panels[id].screenId || null }));
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

export function screenGeometry(id) {
  const g = geometryFor(readConfig(), id);
  if (!g) return null;
  const b = screenBox(g);
  return { left: b.L, top: b.T, width: b.W, height: b.H };
}
