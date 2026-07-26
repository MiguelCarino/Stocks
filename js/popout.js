/* popout.js — the code that runs INSIDE a detached panel (a window.open popout
   or a Document Picture-in-Picture surface). It is a pure receiver: it holds no
   provider, no key and no timer that touches the network. Every number it shows
   arrived over the BroadcastChannel from whichever window currently owns the
   leader lock, which is what keeps N displays on one API budget.

   That asymmetry makes staleness the only failure mode worth designing around.
   A panel whose feed died looks exactly like a panel whose market is quiet, so
   the age of the last frame is tracked independently of the frame itself and is
   allowed to visibly degrade the numbers. Opening this page cold — by URL, with
   no opener alive — paints the persisted frame and declares it stale in the same
   breath, because nothing has proven a publisher exists.

   WHAT THIS FILE NO LONGER DOES: draw. It used to carry its own board, ticker,
   portfolio and strip renderers, which were near-copies of the main window's and
   drifted from them one honesty fix at a time — the panel was still printing
   'EURUSD $1.08' months after the app stopped. Rendering now goes through
   createWidget() from widgets.js, so a panel and a workspace tile of the same
   kind are the same code and cannot disagree about what a quote means. What is
   left here is everything a widget deliberately does not know: which panel this
   window is, where it belongs on which monitor, how old the frame is, and
   whether anyone is still publishing.

   The four panel ids are frozen. A window opened by the previous version is
   still running the previous version's code, and every config in stk_popouts
   names board | ticker | portfolio | strip; those ids keep choosing this page's
   layout, and they map onto widget kinds rather than being replaced by them. */

import { peers } from './peers.js';
import { store } from './store.js';
import { sessionAt, marketForSymbol } from './session.js';
// The storage readers, and only because the host is the one that writes that
// storage: a second, hand-rolled reader of the same key is how a panel ends up
// silently ignoring every setting it was opened with. panelWidget() is the same
// argument applied to the substitution rule — displays.js decides which widget an
// unknown kind falls back to and writes the sentence explaining it, and this file
// prints that sentence rather than deciding again. Nothing in displays.js runs at
// import time — no window.open, no permission probe.
import { panelConfig, panelWidget, screenGeometry, PANELS } from './displays.js';
import { createWidget, widgetMeta } from './widgets.js';
import { fmtAge } from './format.js';

// The mapping the displays contract fixes. The key is what the URL and every
// stored config say; the value is what actually draws.
const PANEL_WIDGET = {
  board: 'cards',
  ticker: 'quote',
  portfolio: 'portfolio',
  strip: 'tape',
};
const FALLBACK_PANEL = 'board';

// Below ~20s even a 5s poll can miss a beat, so the floor keeps the badge from
// flickering; above it, staleness tracks whatever cadence the leader publishes.
const STALE_FLOOR_MS = 20000;
const STALE_FACTOR = 2.5;

/* Host state a frame does not carry. Series arrive one localStorage write at a
   time rather than over the mesh, so a panel that read them once at open would
   show a chart that never gains a point — which is exactly the kind of
   live-looking dead surface this page exists to prevent. They are re-read when a
   frame lands and when the host writes the key, and never written. */
const SHARED = {
  series: 'stk_series',
  profiles: 'stk_profiles',
  rules: 'stk_rules',
  alertlog: 'stk_alertlog',
  watchlist: 'stk_watchlist',
  holdings: 'stk_holdings',
};

const shared = { series: {}, profiles: {}, rules: [], alertlog: [], watchlist: null, holdings: null };

const el = {};
const state = {
  panelId: FALLBACK_PANEL,
  panelKind: FALLBACK_PANEL,   // board|ticker|portfolio|strip — chooses the layout
  widgetKind: PANEL_WIDGET[FALLBACK_PANEL],
  symbol: null,        // pinned by whoever opened the panel; survives clicks
  widgetNote: null,    // displays.js's sentence when the widget asked for was substituted
  selection: null,     // clicked in this window; what an unpinned widget follows
  cfg: {},
  widget: null,
  frame: null,
  frameAt: 0,          // local clock; 0 while nothing live has arrived
  cold: true,          // no live broadcast seen yet in this window's lifetime
  freshness: {},       // symbol -> { ts, changedAt, polls }, for frozen quotes
  uncovered: new Set(),
  sessions: new Map(), // market id -> session object asserted by the leader
  watchlist: null,
  holdings: null,
  interval: null,      // seconds, as reported by the leader
  privacy: false,
  wasStale: null,
  alertTimer: 0,
};

boot();

function boot() {
  for (const id of ['poBody', 'poTitle', 'poSession', 'poStale', 'poPlace', 'poHint', 'poAlert', 'poNote']) {
    el[id] = document.getElementById(id);
  }

  state.panelId = readPanelId();
  state.cfg = readConfig(state.panelId);
  state.panelKind = resolvePanelKind(state.panelId, state.cfg);
  // The resolved record, not the raw config: displays.js has already substituted
  // an unknown kind and written the note that says so.
  const resolved = readWidget(state.panelId);
  state.widgetKind = resolveWidgetKind(state.cfg, state.panelKind, resolved);
  state.symbol = resolveSymbol(state.cfg, resolved);
  state.widgetNote = resolved && typeof resolved.note === 'string' && resolved.note ? resolved.note : null;
  paintWidgetNote();
  // Both classes: the panel id owns the layout (a strip is one line whatever it
  // draws), the widget kind owns the type scale.
  document.body.classList.add('panel-' + state.panelKind, 'widget-' + state.widgetKind);

  const title = state.cfg.title || panelTitle();
  el.poTitle.textContent = title;
  document.title = title + ' — Carino Stocks';

  state.privacy = typeof state.cfg.privacy === 'boolean' ? state.cfg.privacy : !!safeSettings().privacy;
  applyPrivacy();

  bindKeys();
  reassertGeometry();

  // Read the persisted frame directly instead of waiting for peers.init to
  // hydrate it: init resolves only once leadership settles, and a window that
  // shows a grid of dashes for even a few hundred milliseconds looks broken.
  refreshShared();
  adoptFrame(readPersistedFrame(), false);
  mount();

  connect();
  setInterval(refresh, 1000);

  // The 1Hz interval is throttled to roughly once a minute while the panel is
  // backgrounded, so the chrome can be up to a minute out of date at the exact
  // moment the window is revealed — showing an old frame as though it were
  // current. Re-tick on every path back to the foreground; a panel is only
  // honest if it re-checks its own age before the user can read it.
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) {
    (ev === 'visibilitychange' ? document : window).addEventListener(ev, refresh);
  }
  // Fired by the host's own writes, in this document, for free. Not load-bearing:
  // the same re-read happens on every frame that arrives.
  window.addEventListener('storage', (e) => {
    if (e && e.key && !Object.values(SHARED).includes(e.key)) return;
    refreshShared();
    render();
  });
  refresh();
}

/* ---- panel identity ------------------------------------------------------ */

function readPanelId() {
  const raw = urlParam('panel');
  const id = String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return id || FALLBACK_PANEL;
}

function urlParam(name) {
  try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
}

// The id in the URL is opaque, so the layout comes from the stored config first
// and is only inferred from the id when the config is missing (a cold open).
// Every candidate is filtered through PANEL_WIDGET, which is what lets `kind`
// carry a widget id now without the layout misreading it as a panel.
function resolvePanelKind(panelId, cfg) {
  for (const v of [cfg.kind, cfg.panel, cfg.type, cfg.panelId, panelId]) {
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(PANEL_WIDGET, v)) return v;
  }
  return FALLBACK_PANEL;
}

/* A widget-configured panel names what it wants to draw; a legacy one names only
   its panel id, whose `kind` is one of the four and never a widget. `resolved` is
   displays.js's answer for this panel and therefore comes first — it is the one
   place the substitution rule lives. The URL is consulted last and only for the
   kind: displays.js keeps symbols, keys and holdings out of query strings on
   purpose, and a widget id is not user data. */
function resolveWidgetKind(cfg, panelKind, resolved) {
  const w = cfg.widget && typeof cfg.widget === 'object' ? cfg.widget : null;
  for (const v of [resolved && resolved.kind, w && w.kind, cfg.widgetKind, cfg.kind, urlParam('widget')]) {
    if (typeof v === 'string' && widgetMeta(v)) return v;
  }
  return PANEL_WIDGET[panelKind] || PANEL_WIDGET[FALLBACK_PANEL];
}

function resolveSymbol(cfg, resolved) {
  const w = cfg.widget && typeof cfg.widget === 'object' ? cfg.widget : null;
  for (const v of [resolved && resolved.symbol, w && w.symbol, cfg.symbol]) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 24);
  }
  return null;
}

// null for a panel still drawing its legacy content, which is not an error.
function readWidget(panelId) {
  const hit = safeCall(() => panelWidget(panelId));
  return hit && typeof hit === 'object' ? hit : null;
}

/* A substituted widget must say so. displays.js resolves an unknown kind down to
   the watchlist rather than opening an empty window, and that is a reasonable
   choice only as long as the reader is told it was made — otherwise the panel
   quietly draws something nobody asked for. */
function paintWidgetNote() {
  if (!el.poNote) return;
  el.poNote.textContent = state.widgetNote || '';
  // The bar is one line and a docked strip is narrow, so the sentence is clipped
  // on screen and kept whole in the tooltip rather than being cut off outright.
  if (state.widgetNote) el.poNote.title = state.widgetNote;
  else el.poNote.removeAttribute('title');
  el.poNote.hidden = !state.widgetNote;
}

// A panel showing its own default widget keeps the panel's name: 'Board' is what
// the user clicked, 'Cards' is how it happens to be drawn. A panel configured
// with something else is named after that instead, plus its symbol if it is
// pinned to one, because 'Board' over a single chart would be a lie.
function panelTitle() {
  const meta = widgetMeta(state.widgetKind);
  let label = (meta && meta.label) || 'Panel';
  if (PANEL_WIDGET[state.panelKind] === state.widgetKind) {
    const p = PANELS.find((x) => x && x.id === state.panelKind);
    if (p && p.label) label = p.label;
  }
  return state.symbol ? label + ' · ' + state.symbol : label;
}

function readConfig(panelId) {
  const hit = safeCall(() => panelConfig(panelId));
  return hit && typeof hit === 'object' ? hit : {};
}

function safeCall(fn) {
  try { return fn(); } catch (e) { return null; }
}

function safeSettings() {
  try { return store.settings || {}; } catch (e) { return {}; }
}

/* ---- geometry -----------------------------------------------------------
   Re-asserted here rather than being trusted to the opener: the handle the
   opener held (and any expando on it) dies the moment the main window reloads,
   but the config in storage does not. Placement is a request, never a promise —
   Wayland and several tiling window managers ignore it outright, so the result
   is verified and labelled instead of assumed. */

function reassertGeometry() {
  if (state.cfg.mode === 'pip') return;   // PiP geometry belongs to the browser
  const rect = targetRect();
  if (!rect) return;

  const before = currentRect();
  try {
    if (before && (Math.abs(before.left - rect.left) > 8 || Math.abs(before.top - rect.top) > 8)) {
      window.moveTo(rect.left, rect.top);
    }
    if (before && (Math.abs(before.width - rect.width) > 8 || Math.abs(before.height - rect.height) > 8)) {
      window.resizeTo(rect.width, rect.height);
    }
  } catch (e) { /* popup blockers and some hosts forbid both outright */ }

  setTimeout(() => {
    const after = currentRect();
    if (!after) return;
    const missed = Math.abs(after.left - rect.left) > 24 || Math.abs(after.top - rect.top) > 24;
    if (missed) el.poPlace.hidden = false;
  }, 300);
}

// The box the host wrote when it opened this window, or — for a config written
// before boxes were stored — the corner of the monitor it was aimed at, which is
// enough to get the window back on the right screen without resizing it blind.
function targetRect() {
  const explicit = rectFrom(state.cfg.rect || state.cfg.bounds || state.cfg.geometry);
  if (explicit) return explicit;
  const g = state.cfg.screenId ? safeCall(() => screenGeometry(state.cfg.screenId)) : null;
  if (!g) return null;
  const cur = currentRect();
  return {
    left: g.left, top: g.top,
    width: (cur && cur.width) || g.width,
    height: (cur && cur.height) || g.height,
  };
}

function rectFrom(src) {
  if (!src || typeof src !== 'object') return null;
  const left = intOr(src.left ?? src.x, null);
  const top = intOr(src.top ?? src.y, null);
  const width = intOr(src.width ?? src.w, null);
  const height = intOr(src.height ?? src.h, null);
  if (left == null || top == null) return null;
  return { left, top, width: width || window.outerWidth || 600, height: height || window.outerHeight || 400 };
}

function currentRect() {
  try {
    return {
      left: intOr(window.screenX ?? window.screenLeft, 0),
      top: intOr(window.screenY ?? window.screenTop, 0),
      width: intOr(window.outerWidth, 0),
      height: intOr(window.outerHeight, 0),
    };
  } catch (e) { return null; }
}

function intOr(v, fb) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? Math.round(n) : fb;
}

/* ---- peers --------------------------------------------------------------- */

async function connect() {
  // Handlers first: init awaits the leader lock, and a frame that lands during
  // that window would otherwise be dropped on the floor.
  safeOn('quotes', (payload) => { adoptFrame(payload, true); refresh(); });
  safeOn('state', (payload) => { applyState(payload); refresh(); });
  safeOn('session', (payload) => {
    if (payload && typeof payload === 'object' && payload.market && payload.session) {
      state.sessions.set(payload.market, payload.session);
      refresh();
    }
  });
  safeOn('alert', (payload) => flashAlert(payload));

  try { await peers.init('popout'); } catch (e) { /* mesh unavailable; the stored frame is all this window gets */ }

  // init hydrates the persisted frame; adopt it in case storage was written
  // after this window read it, still as cold — a stored frame proves nothing
  // about whether a publisher is running now.
  adoptFrame(lastFrameSafe(), false);
  refresh();

  // Announce the panel so the leader can push a frame immediately instead of
  // leaving this window stale until its next scheduled tick.
  try { peers.broadcast('hello', { role: 'popout', panel: state.panelId, kind: state.widgetKind }); } catch (e) { /* noop */ }
}

function safeOn(type, fn) {
  try { peers.on(type, fn); } catch (e) { /* peers degraded; panel stays on the stored frame */ }
}

function lastFrameSafe() {
  try { return peers.lastFrame(); } catch (e) { return null; }
}

// Same key peers.js persists to, read here only for the pre-init paint. peers
// wraps the frame as {ts, by, frame}; the wrapper's write time is the only
// timestamp guaranteed to be there, and without one a stored frame would read as
// ageless and never admit to being stale.
function readPersistedFrame() {
  const rec = lsRead('stk_lastframe');
  if (!rec || typeof rec !== 'object') return null;
  const inner = rec.frame && typeof rec.frame === 'object' ? rec.frame : rec;
  if (inner.ts == null && rec.ts != null) return { ...inner, ts: rec.ts };
  return inner;
}

function lsRead(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch (e) { return null; }
}

/* ---- host state outside the frame ---------------------------------------- */

function refreshShared() {
  for (const [name, key] of Object.entries(SHARED)) {
    const v = lsRead(key);
    if (name === 'series' || name === 'profiles') {
      shared[name] = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } else if (name === 'watchlist' || name === 'holdings') {
      // null is meaningful: not seeded, as opposed to seeded and empty.
      shared[name] = Array.isArray(v) ? v : null;
    } else {
      shared[name] = Array.isArray(v) ? v : [];
    }
  }
  // The alerts widget reads store.alertlog itself, because the fires are not in
  // any frame and copying a hundred of them into every frame the host publishes
  // would be worse. Re-pointing the in-memory array is the only way this window
  // can hand it a current log; nothing here writes storage.
  try { store.alertlog = shared.alertlog; } catch (e) { /* frozen or absent store */ }
}

/* ---- frames -------------------------------------------------------------- */

// Frames are tolerated in two shapes: a wrapper with a `quotes` map, or a bare
// symbol->quote map. Anything else is ignored rather than half-rendered.
function adoptFrame(payload, live) {
  const frame = normalizeFrame(payload);
  if (!frame) return;
  // A re-read of the stored frame arrives without the wrapper's timestamp; keep
  // the age already established rather than resetting it to unknown.
  if (!live && frame.ts == null && state.frame && state.frame.ts != null) frame.ts = state.frame.ts;
  state.frame = frame;
  if (live) {
    state.frameAt = Date.now();
    state.cold = false;
    // Only a live frame is a poll. Re-reading the stored one is not new evidence
    // about whether a quote's timestamp has moved, and counting it as such would
    // let a dead feed clear its own frozen flag by being read twice.
    noteFreshness(frame.quotes);
    refreshShared();
  }
  if (Array.isArray(frame.symbols)) state.watchlist = frame.symbols;
  // Each live frame's coverage list is authoritative for that frame, so a symbol
  // the provider has since started answering for stops being marked. A stored
  // frame is not allowed to clear it: it is older evidence, not newer.
  if (Array.isArray(frame.uncovered)) state.uncovered = new Set(frame.uncovered.filter((s) => typeof s === 'string'));
  else if (live) state.uncovered = new Set();
  if (Number.isFinite(frame.interval)) state.interval = frame.interval;
}

function normalizeFrame(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const quotes = payload.quotes && typeof payload.quotes === 'object' ? payload.quotes
    : (looksLikeQuoteMap(payload) ? payload : null);
  if (!quotes) return null;
  const symbols = Array.isArray(payload.symbols) ? payload.symbols
    : (Array.isArray(payload.order) ? payload.order : null);
  return {
    quotes,
    symbols,
    // Additive: the host does not publish this yet, and a panel that assumed an
    // absent list meant "everything is covered" would print dashes over symbols
    // the provider has already said it does not have.
    uncovered: Array.isArray(payload.uncovered) ? payload.uncovered : null,
    ts: num(payload.ts) ?? num(payload.sentAt),
    interval: num(payload.interval),
    paused: payload.paused === true,
  };
}

function looksLikeQuoteMap(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object' && ('price' in v || 'changePct' in v)) return true;
  }
  return false;
}

function applyState(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.watchlist)) state.watchlist = payload.watchlist;
  if (Array.isArray(payload.holdings)) state.holdings = payload.holdings;
  if (Number.isFinite(payload.interval)) state.interval = payload.interval;
  const s = payload.settings;
  if (s && typeof s === 'object' && typeof s.privacy === 'boolean' && typeof state.cfg.privacy !== 'boolean') {
    state.privacy = s.privacy; applyPrivacy();
  }
  // A watchlist edit usually comes with a rules or holdings edit; both live in
  // storage rather than in this message.
  refreshShared();
}

function applyPrivacy() {
  document.body.classList.toggle('privacy-on', !!state.privacy);
}

/* ---- freshness -------------------------------------------------------------
   Straight from app.js: a quote is stale when its own timestamp stops advancing
   across polls, which is the only evidence there is — a provider that keeps
   stamping Date.now() on a frozen price would otherwise look permanently live.
   One observation proves nothing, so the clock only starts on the second frame
   carrying the same ts. */

function noteFreshness(quotes) {
  const now = Date.now();
  for (const [sym, q] of Object.entries(quotes || {})) {
    if (!q || typeof q !== 'object') continue;
    const ts = q.ts == null ? null : q.ts;
    const f = state.freshness[sym];
    if (!f || f.ts !== ts) state.freshness[sym] = { ts, changedAt: now, polls: 1 };
    else f.polls++;
  }
}

function frozenMs(sym) {
  const f = state.freshness[sym];
  if (!f || f.polls < 2) return 0;
  return Date.now() - f.changedAt;
}

/* ---- staleness & session chrome ------------------------------------------ */

function intervalSec() {
  const v = state.interval ?? num(safeSettings().interval) ?? 15;
  return Math.max(5, v);
}

function staleAfterMs() {
  return Math.max(STALE_FLOOR_MS, intervalSec() * 1000 * STALE_FACTOR);
}

// Two clocks, and the panel is only as fresh as the worse of them: a message
// arriving proves the mesh is alive, not that the prices in it are. A leader
// whose provider died hours ago still answers a hello with the frame it last
// managed to fetch, and that frame must not repaint as live just because it was
// re-sent a second ago.
function frameAgeMs(now) {
  const byArrival = state.frameAt ? now - state.frameAt : null;
  const ts = state.frame && state.frame.ts;
  const byTs = Number.isFinite(ts) ? now - ts : null;
  if (byArrival == null && byTs == null) return null;
  return Math.max(0, Math.max(byArrival == null ? -Infinity : byArrival, byTs == null ? -Infinity : byTs));
}

// Cold is stale by definition: a persisted frame proves only that a publisher
// once existed, never that one is running right now.
function frameState(now) {
  const age = frameAgeMs(now);
  return {
    age,
    stale: state.cold || age == null || age > staleAfterMs(),
    paused: !!(state.frame && state.frame.paused),
  };
}

function tickChrome() {
  const now = Date.now();
  const fs = frameState(now);

  if (fs.stale !== state.wasStale) { document.body.classList.toggle('is-stale', fs.stale); state.wasStale = fs.stale; }

  if (!fs.stale) {
    el.poStale.hidden = true;
  } else {
    // A paused leader freezes the numbers on purpose. Dim them all the same —
    // they are still not current — but do not cry feed failure over a choice.
    el.poStale.hidden = false;
    el.poStale.className = 'chip ' + (fs.paused ? 'warn' : 'bad');
    el.poStale.textContent = fs.age == null ? 'No feed'
      : (fs.paused ? 'Paused ' : 'Stale ') + fmtAge(fs.age);
  }

  paintSession(now);
}

function paintSession(now) {
  const s = currentSession(now);
  if (!s) { el.poSession.hidden = true; document.body.classList.remove('is-shut'); return; }
  el.poSession.hidden = false;

  const shut = !s.isTradeable;
  document.body.classList.toggle('is-shut', shut);

  const bits = [s.label];
  if (s.detail) bits.push(s.detail);
  if (shut && s.nextLabel) bits.push(s.nextLabel);
  if (s.approx) bits.push('approx');
  el.poSession.textContent = bits.join(' · ');
  el.poSession.className = ('chip ' + (s.isOpen ? 'ok' : s.isTradeable ? 'warn' : '')).trim();
  el.poSession.title = shut ? 'Market is shut — these are the last prices seen, not live ones.' : '';
}

// The panel's market is whatever its subject trades on, and for a panel showing
// a whole watchlist that is its first row: a mixed panel gets the honest answer
// for its leading symbol rather than a fabricated average. (The session widget
// is the one that answers per market, which is why it exists.)
function currentSession(now) {
  const sym = state.symbol || state.selection || symbolList()[0];
  if (!sym) return null;
  return sessionForMarket(marketFor(sym), now);
}

// The leader's asserted session outranks the local calendar, because the leader
// is also corroborating it against the provider — but only until its own stated
// boundary: past that it is a claim about a session that has already ended.
function sessionForMarket(market, now) {
  const asserted = state.sessions.get(market);
  if (asserted && typeof asserted === 'object') {
    const boundary = num(asserted.nextChange);
    if (boundary == null || boundary > now) return asserted;
  }
  return safeCall(() => sessionAt(now, market));
}

function marketFor(sym) {
  return safeCall(() => marketForSymbol(sym, quoteFor(sym))) || 'US_EQUITY';
}

/* ---- alerts -------------------------------------------------------------- */

function flashAlert(payload) {
  const text = payload && (payload.text || payload.message);
  if (!text) return;
  el.poAlert.textContent = String(text);
  el.poAlert.hidden = false;
  clearTimeout(state.alertTimer);
  state.alertTimer = setTimeout(() => { el.poAlert.hidden = true; }, 12000);
}

/* ---- rendering ----------------------------------------------------------- */

function symbolList() {
  const cfgSyms = Array.isArray(state.cfg.symbols) ? state.cfg.symbols.filter((s) => typeof s === 'string') : null;
  if (cfgSyms && cfgSyms.length) return cfgSyms;
  if (Array.isArray(state.watchlist) && state.watchlist.length) return state.watchlist;
  if (Array.isArray(shared.watchlist) && shared.watchlist.length) return shared.watchlist;
  const q = state.frame && state.frame.quotes;
  return q ? Object.keys(q) : [];
}

function quoteFor(sym) {
  const q = state.frame && state.frame.quotes;
  return q && q[sym] && typeof q[sym] === 'object' ? q[sym] : null;
}

function holdingList() {
  if (Array.isArray(state.holdings)) return state.holdings;
  return Array.isArray(shared.holdings) ? shared.holdings : [];
}

/* The ctx a widget reads, rebuilt on every tick. Frozen shape, so a widget
   cannot tell a panel from a workspace tile — which is the whole point of the
   refactor. The two fields a panel genuinely cannot supply are honest about it:
   ctx.rules and the alert log come from storage rather than the mesh, and
   ctx.uncovered stays empty until the host publishes it. */
function buildCtx() {
  const now = Date.now();
  const quotes = (state.frame && state.frame.quotes) || {};
  const fs = frameState(now);
  // One sessionAt per market rather than per row: the table asks for every row,
  // and this ctx lives for one second, well inside a session boundary.
  const sessions = new Map();
  const markets = new Map();

  const marketOf = (sym) => {
    if (!markets.has(sym)) markets.set(sym, marketFor(sym));
    return markets.get(sym);
  };

  return {
    quotes,
    symbols: symbolList(),
    holdings: holdingList(),
    rules: shared.rules,
    // The leader's effective cadence, not this window's stored setting: it is
    // what every staleness threshold downstream is sized from, and a panel that
    // used the nominal 15s would cry stale through a 300s closed-market poll.
    settings: { interval: intervalSec(), privacy: state.privacy },
    selection: state.selection,
    seriesFor(sym) {
      const rec = shared.series && shared.series[sym];
      return rec && Array.isArray(rec.points) ? rec.points : [];
    },
    profileFor(sym) {
      const p = shared.profiles && shared.profiles[sym];
      return p && typeof p === 'object' ? p : null;
    },
    sessionFor(sym) {
      const mkt = marketOf(sym);
      if (!sessions.has(mkt)) sessions.set(mkt, sessionForMarket(mkt, now));
      return sessions.get(mkt);
    },
    marketFor: marketOf,
    frozenMs,
    uncovered: state.uncovered,
    // An unknown age is not a small age. When there is no age at all the footer
    // already says 'No feed' and the body is dimmed, so nothing is invented here
    // for the widget's own chip to print.
    staleMs: fs.stale && fs.age != null ? fs.age : 0,
    privacy: state.privacy,
    onSelect,
  };
}

/* A panel has no workspace to link, so a click is a local selection: it is what
   an unpinned quote or chart follows and what the table highlights. It is
   deliberately not broadcast — a receiver able to retarget the host would make
   the main window's selection depend on which monitor someone tapped. */
function onSelect(sym) {
  if (typeof sym !== 'string' || !sym || sym === state.selection) return;
  state.selection = sym;
  render();
}

function mount() {
  if (state.widget) { safeCall(() => state.widget.destroy()); state.widget = null; }
  el.poBody.textContent = '';
  const host = document.createElement('div');
  host.className = 'po-widget';
  el.poBody.appendChild(host);
  // createWidget never throws: an unknown kind — a config written by a newer
  // build — renders its own placeholder and the panel chrome stays truthful.
  state.widget = createWidget(state.widgetKind, host, buildCtx());
  // A configured symbol is a pin rather than a selection, so clicking around in
  // the panel cannot silently retarget the display someone set up.
  if (state.symbol) state.widget.setSymbol(state.symbol);
}

function render() {
  if (!state.widget) { mount(); return; }
  state.widget.update(buildCtx());
}

// The widgets patch rather than rebuild, and the ages they print climb on a
// clock rather than on arrivals, so repainting them with the chrome is both
// cheap and the only way 'Frame 4m old' is ever true.
function refresh() {
  render();
  tickChrome();
}

/* ---- formatting ---------------------------------------------------------- */

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ---- keyboard ------------------------------------------------------------ */

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'f' || k === 'F') {
      if (isTyping(e.target)) return;   // a widget's own control gets the key
      e.preventDefault();
      toggleFullscreen();
    } else if (k === 'Escape') {
      // A widget with something open — the table's column menu — owns Escape
      // first. Closing the whole window instead would be a very expensive way
      // to dismiss a dropdown.
      if (document.querySelector('details[open]')) return;
      e.preventDefault();
      closeSelf();
    }
  });
}

function isTyping(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(noop); return; }
    const root = document.documentElement;
    if (!root.requestFullscreen) return;   // PiP surfaces expose no fullscreen
    const p = root.requestFullscreen();
    if (p && p.catch) p.catch(noop);
  } catch (e) { /* nothing to fall back to; the window simply stays as it is */ }
}

// A window this script did not open cannot close itself, and a PiP surface never
// can: window.close() is a no-op inside the PiP document's frame. The 'bye' goes
// out first so the host — which does hold the handle — can do it instead, and the
// message below is only reached when nobody did.
function closeSelf() {
  try { peers.broadcast('bye', { panel: state.panelId }); } catch (e) { /* noop */ }
  try { window.close(); } catch (e) { /* noop */ }
  setTimeout(() => {
    if (window.closed) return;
    el.poHint.textContent = 'Esc blocked — close from the window controls';
    // The strip layout has no room for the hint line and hides it, so the
    // sentence borrows the chip slot rather than going nowhere.
    if (el.poHint.offsetParent === null) {
      el.poPlace.textContent = 'Esc blocked — use the window controls';
      el.poPlace.hidden = false;
    }
  }, 900);
}

function noop() {}
