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
   breath, because nothing has proven a publisher exists. */

import { peers } from './peers.js';
import { store } from './store.js';
import { portfolioTotals } from './engine.js';
import { sessionAt, marketForSymbol, formatCountdown } from './session.js';
// Only the two storage readers, and only because the host is the one that writes
// that storage: a second, hand-rolled reader of the same key is how a panel ends
// up silently ignoring every setting it was opened with. Nothing in displays.js
// runs at import time — no window.open, no permission probe.
import { panelConfig, screenGeometry } from './displays.js';

// The panel kinds this page can render, kept local: what a receiver can draw is
// its own business, and the host's PANELS table carries sizing and defaults that
// mean nothing on this side.
const KINDS = {
  board: { label: 'Board', render: renderBoard },
  ticker: { label: 'Ticker', render: renderTicker },
  portfolio: { label: 'Portfolio', render: renderPortfolio },
  strip: { label: 'Strip', render: renderStrip },
};
const FALLBACK_KIND = 'board';

// Below ~20s even a 5s poll can miss a beat, so the floor keeps the badge from
// flickering; above it, staleness tracks whatever cadence the leader publishes.
const STALE_FLOOR_MS = 20000;
const STALE_FACTOR = 2.5;

const el = {};
const state = {
  panelId: FALLBACK_KIND,
  kind: FALLBACK_KIND,
  cfg: {},
  frame: null,
  frameAt: 0,          // local clock; 0 while nothing live has arrived
  cold: true,          // no live broadcast seen yet in this window's lifetime
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
  for (const id of ['poBody', 'poTitle', 'poSession', 'poStale', 'poPlace', 'poHint', 'poAlert']) {
    el[id] = document.getElementById(id);
  }

  state.panelId = readPanelId();
  state.cfg = readConfig(state.panelId);
  state.kind = resolveKind(state.panelId, state.cfg);
  document.body.classList.add('panel-' + state.kind);
  el.poTitle.textContent = state.cfg.title || KINDS[state.kind].label;
  document.title = (state.cfg.title || KINDS[state.kind].label) + ' — Carino Stocks';

  state.privacy = typeof state.cfg.privacy === 'boolean' ? state.cfg.privacy : !!safeSettings().privacy;
  applyPrivacy();

  bindKeys();
  reassertGeometry();

  // Read the persisted frame directly instead of waiting for peers.init to
  // hydrate it: init resolves only once leadership settles, and a window that
  // shows a grid of dashes for even a few hundred milliseconds looks broken.
  adoptFrame(readPersistedFrame(), false);
  render();

  connect();
  setInterval(tickChrome, 1000);

  // The 1Hz interval is throttled to roughly once a minute while the panel is
  // backgrounded, so the chrome can be up to a minute out of date at the exact
  // moment the window is revealed — showing an old frame as though it were
  // current. Re-tick on every path back to the foreground; a panel is only
  // honest if it re-checks its own age before the user can read it.
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) {
    (ev === 'visibilitychange' ? document : window).addEventListener(ev, tickChrome);
  }
  tickChrome();
}

/* ---- panel identity ------------------------------------------------------ */

function readPanelId() {
  let raw = '';
  try { raw = new URLSearchParams(location.search).get('panel') || ''; } catch (e) { raw = ''; }
  const id = String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return id || FALLBACK_KIND;
}

// The id in the URL is opaque, so the kind comes from the stored config first
// and is only inferred from the id when the config is missing (a cold open).
function resolveKind(panelId, cfg) {
  for (const v of [cfg.kind, cfg.panel, cfg.type, cfg.panelId, panelId]) {
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(KINDS, v)) return v;
  }
  return FALLBACK_KIND;
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
  safeOn('quotes', (payload) => { adoptFrame(payload, true); render(); tickChrome(); });
  safeOn('state', (payload) => { applyState(payload); render(); tickChrome(); });
  safeOn('session', (payload) => {
    if (payload && typeof payload === 'object' && payload.market && payload.session) {
      state.sessions.set(payload.market, payload.session);
      tickChrome();
    }
  });
  safeOn('alert', (payload) => flashAlert(payload));

  try { await peers.init('popout'); } catch (e) { /* mesh unavailable; the stored frame is all this window gets */ }

  // init hydrates the persisted frame; adopt it in case storage was written
  // after this window read it, still as cold — a stored frame proves nothing
  // about whether a publisher is running now.
  adoptFrame(lastFrameSafe(), false);
  render();
  tickChrome();

  // Announce the panel so the leader can push a frame immediately instead of
  // leaving this window stale until its next scheduled tick.
  try { peers.broadcast('hello', { role: 'popout', panel: state.panelId, kind: state.kind }); } catch (e) { /* noop */ }
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
  try {
    const raw = localStorage.getItem('stk_lastframe');
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== 'object') return null;
    const inner = rec.frame && typeof rec.frame === 'object' ? rec.frame : rec;
    if (inner.ts == null && rec.ts != null) return { ...inner, ts: rec.ts };
    return inner;
  } catch (e) { return null; }
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
  if (live) { state.frameAt = Date.now(); state.cold = false; }
  if (Array.isArray(frame.symbols)) state.watchlist = frame.symbols;
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
}

function applyPrivacy() {
  document.body.classList.toggle('privacy-on', !!state.privacy);
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

function tickChrome() {
  const now = Date.now();
  const age = frameAgeMs(now);

  // Cold is stale by definition: a persisted frame proves only that a publisher
  // once existed, never that one is running right now.
  const stale = state.cold || age == null || age > staleAfterMs();
  if (stale !== state.wasStale) { document.body.classList.toggle('is-stale', stale); state.wasStale = stale; }

  if (!stale) {
    el.poStale.hidden = true;
  } else {
    // A paused leader freezes the numbers on purpose. Dim them all the same —
    // they are still not current — but do not cry feed failure over a choice.
    const paused = !!(state.frame && state.frame.paused);
    el.poStale.hidden = false;
    el.poStale.className = 'chip ' + (paused ? 'warn' : 'bad');
    el.poStale.textContent = age == null ? 'No feed'
      : (paused ? 'Paused ' : 'Stale ') + formatAge(age);
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

// The panel's market is whatever its first symbol trades on; a mixed panel gets
// the honest answer for its leading row rather than a fabricated average.
function currentSession(now) {
  const syms = symbolList();
  if (!syms.length) return null;
  const q = quoteFor(syms[0]);
  let market = 'US_EQUITY';
  try { market = marketForSymbol(syms[0], q) || 'US_EQUITY'; } catch (e) { /* keep default */ }

  const asserted = state.sessions.get(market);
  if (asserted && typeof asserted === 'object') {
    const boundary = num(asserted.nextChange);
    if (boundary == null || boundary > now) return asserted;
  }
  try { return sessionAt(now, market); } catch (e) { return null; }
}

function formatAge(ms) {
  try { return formatCountdown(ms); } catch (e) { return Math.round(ms / 1000) + 's'; }
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
  try { if (Array.isArray(store.watchlist) && store.watchlist.length) return store.watchlist; } catch (e) { /* noop */ }
  const q = state.frame && state.frame.quotes;
  return q ? Object.keys(q) : [];
}

function quoteFor(sym) {
  const q = state.frame && state.frame.quotes;
  return q && q[sym] && typeof q[sym] === 'object' ? q[sym] : null;
}

function holdingList() {
  if (Array.isArray(state.holdings)) return state.holdings;
  try { return Array.isArray(store.holdings) ? store.holdings : []; } catch (e) { return []; }
}

function render() {
  const body = el.poBody;
  body.className = 'po-body';
  body.textContent = '';
  const node = KINDS[state.kind].render();
  if (node) body.appendChild(node);
  else body.appendChild(empty('Nothing to show — add symbols in the main window.'));
}

function empty(msg) {
  const d = document.createElement('div');
  d.className = 'po-empty';
  d.textContent = msg;
  return d;
}

function renderBoard() {
  const syms = symbolList();
  if (!syms.length) return null;
  const grid = document.createElement('div');
  grid.className = 'board';
  for (const sym of syms) {
    const q = quoteFor(sym);
    const dir = direction(q);
    const tile = document.createElement('div');
    tile.className = 'bt ' + dir;
    tile.appendChild(node('div', 'bt-sym', sym));
    tile.appendChild(node('div', 'bt-price amount', fmtPrice(q && q.price, q && q.currency)));
    tile.appendChild(deltaChip(q, 'bt-delta'));
    grid.appendChild(tile);
  }
  return grid;
}

function renderTicker() {
  const syms = symbolList();
  if (!syms.length) return null;
  const tape = document.createElement('div');
  tape.className = 'tape';
  // Duration scales with content so a two-symbol tape does not sprint past.
  tape.style.setProperty('--dur', Math.max(18, syms.length * 6) + 's');
  // The loop is seamless only while the runs together out-span the window, so a
  // short watchlist gets extra copies instead of a gap chasing the last symbol.
  const runs = Math.max(2, Math.ceil(12 / syms.length));
  for (let i = 0; i < runs; i++) tape.appendChild(tickerRun(syms, i > 0));
  return tape;
}

function tickerRun(syms, dupe) {
  const run = document.createElement('div');
  run.className = 'tape-run' + (dupe ? ' dupe' : '');
  if (dupe) run.setAttribute('aria-hidden', 'true');
  for (const sym of syms) {
    const q = quoteFor(sym);
    const item = document.createElement('div');
    item.className = 'tk';
    item.appendChild(node('span', 'tk-sym', sym));
    item.appendChild(node('span', 'tk-price amount', fmtPrice(q && q.price, q && q.currency)));
    item.appendChild(node('span', 'tk-pct ' + direction(q), fmtPct(q && q.changePct)));
    run.appendChild(item);
  }
  return run;
}

function renderStrip() {
  const syms = symbolList();
  if (!syms.length) return null;
  const row = document.createElement('div');
  row.className = 'strip';
  for (const sym of syms) {
    const q = quoteFor(sym);
    const item = document.createElement('div');
    item.className = 'sp';
    item.appendChild(node('span', 'sp-sym', sym));
    item.appendChild(node('span', 'sp-price amount', fmtPrice(q && q.price, q && q.currency)));
    item.appendChild(node('span', 'sp-pct ' + direction(q), fmtPct(q && q.changePct)));
    row.appendChild(item);
  }
  return row;
}

function renderPortfolio() {
  const holdings = holdingList();
  if (!holdings.length) return null;
  const quotes = (state.frame && state.frame.quotes) || {};

  let totals;
  try { totals = portfolioTotals(holdings, quotes); }
  catch (e) { return empty('Portfolio could not be valued.'); }

  const wrap = document.createElement('div');
  wrap.className = 'pf';

  const tiles = document.createElement('div');
  tiles.className = 'pf-tiles';
  tiles.appendChild(pfTile('Total value', fmtPrice(totals.value), null));
  tiles.appendChild(pfTile('Day P/L', signedPrice(totals.dayPL), sign(totals.dayPL)));
  tiles.appendChild(pfTile('Total P/L', signedPrice(totals.totalPL),
    sign(totals.totalPL), totals.totalPLPct != null ? fmtPct(totals.totalPLPct) : null));
  wrap.appendChild(tiles);

  const rows = document.createElement('div');
  rows.className = 'pf-rows';
  const sorted = totals.rows.slice().sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  for (const r of sorted) {
    const row = document.createElement('div');
    row.className = 'pf-row';
    row.appendChild(node('span', 'pf-sym', r.holding.symbol));
    row.appendChild(node('span', 'pf-val-cell amount', fmtPrice(r.marketValue)));
    row.appendChild(node('span', 'pf-day ' + sign(r.dayPL), signedPrice(r.dayPL)));
    rows.appendChild(row);
  }
  wrap.appendChild(rows);
  return wrap;
}

function pfTile(label, value, dir, sub) {
  const t = document.createElement('div');
  t.className = 'pf-tile';
  t.appendChild(node('div', 'pf-lbl', label));
  t.appendChild(node('div', 'pf-val amount ' + (dir || ''), value));
  if (sub) t.appendChild(node('div', 'pf-lbl', sub));
  return t;
}

function deltaChip(q, extraClass) {
  const dir = direction(q);
  const c = node('span', 'delta ' + dir + ' ' + extraClass, '');
  if (!q || q.changePct == null) { c.textContent = '—'; return c; }
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
  // Crypto and FX quotes often carry a percent without an absolute move; show
  // the percent alone rather than a dash pretending to be a number.
  c.textContent = q.change == null ? `${arrow} ${fmtPct(q.changePct)}`
    : `${arrow} ${fmtNum(q.change)} (${fmtPct(q.changePct)})`;
  return c;
}

function direction(q) {
  const v = q && (q.changePct ?? q.change);
  if (v == null) return 'flat';
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

function sign(v) { return v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : ''; }

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls.trim();
  if (text != null) n.textContent = text;
  return n;
}

/* ---- formatting ---------------------------------------------------------- */

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPrice(v, currency) {
  if (v == null) return '—';
  const prefix = !currency || currency === 'USD' ? '$' : currency + ' ';
  return prefix + fmtNum(v);
}
function signedPrice(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '−') + fmtPrice(Math.abs(v));
}
function fmtPct(v) { return v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Number(v)).toFixed(2) + '%'; }

/* ---- keyboard ------------------------------------------------------------ */

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'f' || k === 'F') { e.preventDefault(); toggleFullscreen(); }
    else if (k === 'Escape') { e.preventDefault(); closeSelf(); }
  });
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
