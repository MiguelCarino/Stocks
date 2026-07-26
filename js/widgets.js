/* widgets.js — the widget registry, and every renderer except the dense table
   (widget-table.js, imported here so the registry is still one list).

   A widget is deliberately not a component framework. It is a closure over an
   element it owns outright, handed a ctx snapshot on every poll tick: build once
   in create(), then PATCH on update(). That shape exists because the obvious
   alternative — clear the host, rebuild the subtree — is what the card grid in
   app.js does, and it is survivable there only because a full refresh is rare. A
   workspace re-renders every visible widget on a fifteen-second cadence, and a
   teardown at that rate throws away scroll position, keyboard focus and any text
   the user was mid-way through selecting. So each renderer keeps element refs and
   writes text nodes, and every structural rebuild is guarded by a signature that
   says the structure actually changed.

   The second decision is that widgets are readers. They take a ctx and they call
   ctx.onSelect; they do not fetch, they do not write settings, and the only
   storage any of them reads is store.alertlog, which the alerts widget cannot get
   from ctx. That is what makes them safe to run eight at a time in a tab the user
   arranged, and safe to hand to displays.js to run in a detached window.

   Honesty is inherited rather than re-decided here: a symbol the provider came
   back empty for reads "Not covered" instead of a dash, a quote whose own
   timestamp has stopped advancing carries its age, and a change is labelled with
   the baseline it was measured against. There is no bid, ask or depth anywhere in
   this file because normQuote has none — a column for one could only be
   fabricated. */

import { TABLE_WIDGET } from './widget-table.js';
import { store } from './store.js';
import { portfolioTotals } from './engine.js';
import { sparkline, drawLineChart } from './viz.js';
import { sessionAt, marketForSymbol, formatCountdown, MARKETS, HOLIDAY_HORIZON } from './session.js';
import { fmtPrice, fmtMove, fmtPct, fmtNum, fmtVolume, fmtTime, fmtAge } from './format.js';

const DASH = '—';
const STALE_FLOOR_MS = 90000;   // matches app.js: never call a quote stale inside 90s
const TICK_MS = 1000;           // countdowns and staleness ages are clocks, not poll results

const SCOPE_LABEL = { regular: 'Regular hours', extended: 'Extended hours', any: 'Any session' };
const SCOPE_TIP = {
  regular: 'Only while regular hours are open.',
  extended: 'Pre-market, regular hours and after hours.',
  any: 'Every session, including while the market is closed.',
};

/* ---- registry --------------------------------------------------------------
   Sizes are in 12-column grid units. The minimums are the point at which a
   widget stops telling the truth rather than the point at which it looks bad: a
   two-column card grid is cramped, a one-column one is a list of clipped prices. */

const TABLE_ENTRY = validTable(TABLE_WIDGET) ? TABLE_WIDGET : stubEntry('table', 'Table', 'Dense sortable quote table.');

export const WIDGETS = [
  TABLE_ENTRY,
  {
    id: 'cards', label: 'Cards', desc: 'The watchlist as cards, with sparkline and day range.',
    needsSymbol: false, minW: 3, minH: 3, defaultW: 8, defaultH: 5, create: createCards,
  },
  {
    id: 'chart', label: 'Chart', desc: 'Line chart of one symbol.',
    needsSymbol: true, minW: 3, minH: 3, defaultW: 6, defaultH: 4, create: createChart,
  },
  {
    id: 'quote', label: 'Quote', desc: 'One symbol, large enough to read across a room.',
    needsSymbol: true, minW: 2, minH: 2, defaultW: 3, defaultH: 3, create: createQuote,
  },
  {
    id: 'portfolio', label: 'Portfolio', desc: 'Holdings, value and P/L.',
    needsSymbol: false, minW: 4, minH: 3, defaultW: 6, defaultH: 4, create: createPortfolio,
  },
  {
    id: 'tape', label: 'Tape', desc: 'One-line ticker of the whole watchlist.',
    needsSymbol: false, minW: 3, minH: 1, defaultW: 12, defaultH: 1, create: createTape,
  },
  {
    id: 'alerts', label: 'Alerts', desc: 'Armed rules and what has fired.',
    needsSymbol: false, minW: 3, minH: 2, defaultW: 4, defaultH: 4, create: createAlerts,
  },
  {
    id: 'session', label: 'Session', desc: 'Market state and the countdown to the next boundary.',
    needsSymbol: false, minW: 2, minH: 1, defaultW: 4, defaultH: 2, create: createSession,
  },
];

export function widgetMeta(kind) {
  return WIDGETS.find((w) => w.id === kind) || null;
}

/* A widget that cannot be built must still be a widget: the workspace has a
   layout slot for it either way, and an empty slot reads as a bug in the
   workspace rather than in the thing that failed. An unrecognised kind is the
   normal case here, not a corrupt one — a stored layout outlives the release that
   wrote it, and a tab that once held a widget we have since removed should say
   so and keep its other panels. */
export function createWidget(kind, host, ctx) {
  const box = host && host.appendChild ? host : document.createElement('div');
  const entry = widgetMeta(kind);
  if (!entry || typeof entry.create !== 'function') {
    return placeholder(kind, box, 'Unknown widget', 'This layout asks for a widget this version does not have.');
  }

  let inner = null;
  try { inner = entry.create(box, ctx || {}); } catch (e) { inner = null; }
  if (!inner || typeof inner.update !== 'function') {
    return placeholder(kind, box, entry.label + ' unavailable', 'This widget could not be built.');
  }

  // A renderer that throws must not throw once per tick forever: it says so, in
  // the slot, and stops being called. Silently keeping the last good frame would
  // leave a dead panel showing live-looking numbers. Its own clocks and listeners
  // go with it — a stopped widget must not keep repainting nodes nobody can see.
  let dead = false;
  const die = () => {
    dead = true;
    try { if (typeof inner.destroy === 'function') inner.destroy(); } catch (e) { /* already failing */ }
    failNote(box, entry.label);
  };
  return {
    kind,
    update(next) {
      if (dead) return;
      try { inner.update(next); } catch (e) { die(); }
    },
    setSymbol(sym) {
      if (dead || typeof inner.setSymbol !== 'function') return;
      try { inner.setSymbol(sym); } catch (e) { die(); }
    },
    destroy() { try { if (typeof inner.destroy === 'function') inner.destroy(); } catch (e) { /* nothing left to save */ } },
  };
}

function placeholder(kind, box, title, note) {
  box.textContent = '';
  const wrap = el('div', 'wg-blank');
  wrap.append(el('div', 'wg-blank-title', title));
  wrap.append(el('p', 'field-note', note + (kind ? ' (' + String(kind) + ')' : '')));
  box.appendChild(wrap);
  return { kind, update() {}, setSymbol() {}, destroy() { box.textContent = ''; } };
}

function failNote(box, label) {
  box.textContent = '';
  const wrap = el('div', 'wg-blank');
  wrap.append(el('div', 'wg-blank-title', label + ' stopped'));
  wrap.append(el('p', 'field-note', 'This widget hit an error while rendering and has been stopped, '
    + 'so it cannot show you a stale frame as if it were live. Remove and re-add it to try again.'));
  box.appendChild(wrap);
}

function validTable(t) {
  return !!(t && typeof t === 'object' && t.id === 'table' && typeof t.create === 'function');
}

// Only reachable if widget-table.js loaded but exported something unusable. The
// registry keeps the 'table' id either way so a stored layout still resolves.
function stubEntry(id, label, desc) {
  return {
    id, label, desc, needsSymbol: false, minW: 4, minH: 3, defaultW: 12, defaultH: 5,
    create(host) { return placeholder(id, host, label + ' unavailable', 'The table renderer did not load.'); },
  };
}

/* ---- ctx access ------------------------------------------------------------
   ctx is a contract, not a promise that every field arrived. Every read goes
   through one of these so a caller that omits a callback degrades to a widget
   with less to say rather than a widget that throws on its first tick. */

function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
}

function symbolsOf(ctx) {
  const list = ctx && Array.isArray(ctx.symbols) ? ctx.symbols : [];
  return list.filter((s) => typeof s === 'string' && s);
}

function quoteOf(ctx, sym) {
  const q = ctx && ctx.quotes ? ctx.quotes[sym] : null;
  return q && typeof q === 'object' ? q : null;
}

function marketOf(ctx, sym) {
  const m = safe(() => ctx.marketFor(sym), null);
  if (m) return m;
  return safe(() => marketForSymbol(sym, quoteOf(ctx, sym)), 'US_EQUITY');
}

function sessionOf(ctx, sym) {
  const s = safe(() => ctx.sessionFor(sym), null);
  if (s && typeof s === 'object') return s;
  return sessionAt(Date.now(), marketOf(ctx, sym));
}

// FX is a ratio: fmtPrice needs to be told, because it no longer guesses.
function priceOpts(ctx, sym) { return { fx: marketOf(ctx, sym) === 'FX' }; }

function frozenOf(ctx, sym) {
  const v = Number(safe(() => ctx.frozenMs(sym), 0));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function staleLimit(ctx) {
  const iv = Number(ctx && ctx.settings && ctx.settings.interval);
  return Math.max(STALE_FLOOR_MS, (Number.isFinite(iv) ? iv : 15) * 3000);
}

// Staleness only means something while the market can print: a Sunday quote that
// has not moved since Friday is correct, not frozen.
function staleMsOf(ctx, sym) {
  const sess = sessionOf(ctx, sym);
  if (!sess.isTradeable) return 0;
  const ms = frozenOf(ctx, sym);
  return ms > staleLimit(ctx) ? ms : 0;
}

function isUncovered(ctx, sym) {
  const u = ctx && ctx.uncovered;
  return !!(u && typeof u.has === 'function' && u.has(sym));
}

function seriesOf(ctx, sym) {
  const pts = safe(() => ctx.seriesFor(sym), []);
  return Array.isArray(pts) ? pts.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
}

function profileName(ctx, sym) {
  const p = safe(() => ctx.profileFor(sym), null);
  return (p && p.name) || '';
}

/* The symbol a needsSymbol widget is actually showing. Its own pin wins; a linked
   widget follows the workspace selection; with neither, the first watched symbol
   is a better first impression than an empty panel telling the user to configure
   it. */
function subjectOf(ctx, pinned) {
  if (pinned) return pinned;
  if (ctx && typeof ctx.selection === 'string' && ctx.selection) return ctx.selection;
  return symbolsOf(ctx)[0] || null;
}

/* ---- DOM helpers ---------------------------------------------------------- */

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// The whole point of the patch-not-rebuild rule. Assigning an identical string
// still invalidates layout in some engines and always drops a selection inside
// the node, so the comparison is not a micro-optimisation.
function setText(node, txt) {
  const s = txt == null ? '' : String(txt);
  if (node.textContent !== s) node.textContent = s;
}

function setCls(node, cls) {
  if (node.className !== cls) node.className = cls;
}

function setAttr(node, name, val) {
  if (val == null) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  if (node.getAttribute(name) !== String(val)) node.setAttribute(name, String(val));
}

function setHidden(node, hide) {
  if (node.hidden !== !!hide) node.hidden = !!hide;
}

// A symbol is a control, so it is a button: the card grid in app.js is clickable
// and unreachable from a keyboard, and that is not worth reproducing eight times.
function symBtn(sym, cls) {
  const b = el('button', 'wg-pick ' + (cls || ''), sym);
  b.type = 'button';
  b.dataset.sym = sym || '';
  if (sym) b.title = 'Link the workspace to ' + sym;
  return b;
}

/* One delegated listener per widget instead of one per row. Rows are rebuilt on
   watchlist changes and a per-row listener leaks with them. */
function wirePicks(root, getCtx) {
  const onClick = (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-sym]') : null;
    // An empty data-sym is a widget that has no subject yet, not a symbol named ''.
    if (!t || !root.contains(t) || !t.dataset.sym) return;
    const ctx = getCtx();
    const fn = ctx && ctx.onSelect;
    if (typeof fn !== 'function') return;
    try { fn(t.dataset.sym); } catch (e2) { /* the workspace's problem, not this render's */ }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

/* A countdown that only advances when a quote arrives is not a countdown, and an
   age that freezes at whatever the last frame said understates a dead feed by
   however long the feed has been dead. Both are clocks, so they get one. */
function everySecond(fn) {
  let id = null;
  try { id = setInterval(() => { try { fn(); } catch (e) { /* keep the clock running */ } }, TICK_MS); }
  catch (e) { id = null; }
  return () => { if (id != null) clearInterval(id); id = null; };
}

/* ---- shared pieces -------------------------------------------------------- */

function direction(q) {
  const v = q && (q.changePct ?? q.change);
  if (v == null) return 'flat';
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

/* signed:false reproduces the card chip exactly — the arrow already carries the
   sign there, so '▲ +0.45%' would state it twice. Crypto and FX quotes often
   carry a percent with no absolute move; the percent alone is the honest render,
   where app.js prints a dash beside a live number. */
function fillDelta(node, q, opts) {
  const dir = direction(q);
  setCls(node, 'delta ' + dir);
  if (!q || q.changePct == null) { setText(node, DASH); return; }
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
  // A percent standing alone keeps its own sign; one in parentheses behind an
  // absolute move does not need to repeat what the arrow already said.
  if (q.change == null) { setText(node, arrow + ' ' + fmtPct(q.changePct)); return; }
  const pct = opts && opts.signed ? fmtPct(q.changePct) : fmtNum(q.changePct) + '%';
  setText(node, arrow + ' ' + fmtMove(q.change, q.price) + ' (' + pct + ')');
}

/* Baseline, coverage, session and staleness for one symbol, as [kind, text, tip].
   Lifted from app.js fillTags: 'unknown' is a real answer rather than a missing
   one — an FX spot rate has no reference close, and printing "vs prev close" over
   it would invent the comparison the provider just said it could not make. */
function tagParts(ctx, sym) {
  const q = quoteOf(ctx, sym);
  const mkt = marketOf(ctx, sym);
  const sess = sessionOf(ctx, sym);
  const parts = [];

  if (q) {
    if (q.baseline === 'rolling_24h' || q.baseline === 'prev_close') {
      parts.push(['basis', q.baseline === 'rolling_24h' ? 'vs 24h' : 'vs prev close',
        q.baselineNote || 'Baseline reported by the data provider.']);
    } else if (mkt === 'CRYPTO') {
      // Marked 'approx' rather than plain: this baseline was guessed from the
      // ticker, and a guess that looks identical to a figure the provider vouched
      // for is the guess doing damage.
      parts.push(['basis approx', 'vs 24h',
        q.baselineNote || 'Baseline inferred from asset class — the provider did not state one.']);
    } else {
      parts.push(['basis unstated', 'no baseline',
        q.baselineNote || 'The provider did not say what this change is measured against.']);
    }
  }

  if (!q && isUncovered(ctx, sym)) {
    parts.push(['uncovered', 'Not covered',
      'The provider handling this symbol returned no quote for it. Try another provider in Settings, '
      + 'or check the symbol.']);
  }

  if (mkt === 'CRYPTO') parts.push(['always', '24/7', 'Crypto trades continuously; it is never closed.']);
  else if (sess.state !== 'open') parts.push(['closed', sess.label, [sess.detail, sess.nextLabel].filter(Boolean).join(' · ')]);

  const stale = staleMsOf(ctx, sym);
  if (stale) {
    parts.push(['stale', 'Stale ' + fmtAge(stale),
      'This quote’s own timestamp has not advanced while the market is tradeable.']);
  }
  return parts;
}

// The signature includes the text, so a climbing staleness age repaints and
// nothing else does.
function paintTags(box, parts) {
  const sig = parts.map((p) => p[0] + p[1]).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  for (const [kind, text, tip] of parts) {
    const t = el('span', 'tag ' + kind, text);
    if (tip) t.title = tip;
    box.appendChild(t);
  }
}

/* The frame's own age, as opposed to one symbol's. staleMs is zero when the last
   poll is the current one, which is the only time the numbers are live. */
function paintFrameAge(node, ctx) {
  const ms = Number(ctx && ctx.staleMs);
  if (!Number.isFinite(ms) || ms <= 0) { setHidden(node, true); return; }
  setHidden(node, false);
  setText(node, 'Frame ' + fmtAge(ms) + ' old');
  setAttr(node, 'title', 'The whole board is this far behind — the app has not completed a poll since.');
}

function sectionHead(text) { return el('div', 'wg-sec rail-lbl', text); }

// The header button of a needsSymbol widget. Disabled rather than hidden when
// there is no subject: the widget still occupies its slot, and a control that
// vanishes is harder to find again than one that is visibly inert.
function paintSubject(btn, sym) {
  setText(btn, sym || 'No symbol');
  setAttr(btn, 'data-sym', sym || '');
  setAttr(btn, 'disabled', sym ? null : '');
  setAttr(btn, 'title', sym ? 'Link the workspace to ' + sym : 'Pin a symbol to this widget, or link it to the workspace.');
}

/* Blur lives on a class rather than an inline filter so the widget matches the
   main window's privacy mode, which does the same thing from body.privacy-on.
   Widgets carry their own copy of that rule because a detached panel is a
   different document, and privacy that only holds in the tab you are not looking
   at is not privacy. */
function applyPrivacy(root, ctx) {
  root.classList.toggle('wg-privacy', !!(ctx && ctx.privacy));
}

/* ---- cards ---------------------------------------------------------------- */

function createCards(host, ctx) {
  let cur = ctx || {};
  const grid = el('div', 'card-grid');
  const empty = el('p', 'empty-cell', 'No symbols yet. Add one from the watchlist.');
  host.append(grid, empty);

  const cards = new Map();     // sym -> refs, so a repaint is a text write
  const unwire = wirePicks(host, () => cur);
  // Tags carry a live age; the poll cadence is far too coarse to show it moving.
  const stopClock = everySecond(() => {
    for (const [sym, ref] of cards) paintTags(ref.tags, tagParts(cur, sym));
  });

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const list = symbolsOf(cur);
    const live = new Set(list);
    setHidden(empty, list.length > 0);
    setHidden(grid, list.length === 0);

    for (const [sym, ref] of cards) {
      if (!live.has(sym)) { ref.root.remove(); cards.delete(sym); }
    }
    list.forEach((sym, i) => {
      let ref = cards.get(sym);
      if (!ref) { ref = buildCard(sym); cards.set(sym, ref); }
      // Sorting is the caller's; reordering the DOM only when it disagrees keeps
      // a re-sort from re-parenting every card on every tick.
      if (grid.children[i] !== ref.root) grid.insertBefore(ref.root, grid.children[i] || null);
      paintCard(ref, sym, cur);
    });
  }

  update(cur);
  return {
    kind: 'cards',
    update,
    setSymbol() { /* the grid is the whole watchlist; it has no one symbol */ },
    destroy() { stopClock(); unwire(); cards.clear(); host.textContent = ''; },
  };
}

function buildCard(sym) {
  const root = el('article', 'card wg-card');
  root.dataset.sym = sym;

  const head = el('div', 'card-head');
  const idBox = el('div', 'card-id');
  const symEl = symBtn(sym, 'card-sym');
  const name = el('span', 'card-name', '');
  idBox.append(symEl, name);
  head.appendChild(idBox);

  const priceRow = el('div', 'card-price-row');
  const price = el('span', 'card-price amount', DASH);
  const delta = el('span', 'delta flat', DASH);
  priceRow.append(price, delta);

  const tags = el('div', 'card-tags');
  const spark = el('div', 'card-spark');

  const range = el('div', 'card-range');
  const bar = el('div', 'rangebar empty');
  // The range ends are prices, so they carry `amount` too: blurring the headline
  // price and leaving the day low beside it readable is not privacy.
  const lo = el('span', 'rb-lo amount', '');
  const track = el('div', 'rb-track');
  const mark = el('div', 'rb-mark');
  track.appendChild(mark);
  const hi = el('span', 'rb-hi amount', '');
  bar.append(lo, track, hi);
  range.appendChild(bar);

  const foot = el('div', 'card-foot');
  const src = el('span', 'card-src', DASH);
  const ts = el('span', 'card-ts', '');
  foot.append(src, ts);

  root.append(head, priceRow, tags, spark, range, foot);
  return { root, name, price, delta, tags, spark, bar, lo, hi, mark, src, ts, sparkSig: null };
}

function paintCard(ref, sym, ctx) {
  const q = quoteOf(ctx, sym);
  setText(ref.name, profileName(ctx, sym));
  setText(ref.price, q ? fmtPrice(q.price, q.currency, priceOpts(ctx, sym)) : DASH);
  fillDelta(ref.delta, q);
  paintTags(ref.tags, tagParts(ctx, sym));

  const pts = seriesOf(ctx, sym);
  const sig = pts.length + ':' + (pts.length ? pts[pts.length - 1] : '');
  if (ref.sparkSig !== sig) { ref.sparkSig = sig; ref.spark.innerHTML = sparkline(pts); }

  paintRange(ref, q);
  setText(ref.src, q ? q.source : DASH);
  setText(ref.ts, q ? 'as of ' + fmtTime(q.ts) : '');
}

// A high equal to the low is not a range, and a price outside its own reported
// range means the two came from different instants — either way the bar has
// nothing to mark, so it dims instead of pinning the marker to an edge.
function paintRange(ref, q) {
  const ok = q && q.low != null && q.high != null && q.price != null && q.high > q.low;
  setCls(ref.bar, 'rangebar' + (ok ? '' : ' empty'));
  if (!ok) { setText(ref.lo, ''); setText(ref.hi, ''); ref.mark.style.left = '0%'; return; }
  const pct = Math.max(0, Math.min(100, ((q.price - q.low) / (q.high - q.low)) * 100));
  // At the price's precision, as app.js's day-range line does it: two decimals
  // turns a sub-dollar coin's whole range into '0.00 – 0.00'.
  setText(ref.lo, fmtMove(q.low, q.price));
  setText(ref.hi, fmtMove(q.high, q.price));
  const left = pct.toFixed(2) + '%';
  if (ref.mark.style.left !== left) ref.mark.style.left = left;
}

/* ---- chart ---------------------------------------------------------------- */

function createChart(host, ctx) {
  let cur = ctx || {};
  let pinned = null;

  const root = el('div', 'wg-chart');
  const head = el('div', 'wg-head');
  const symEl = symBtn('', 'wg-sym');
  const last = el('span', 'wg-last amount', DASH);
  const delta = el('span', 'delta flat', DASH);
  const frame = el('span', 'wg-frame field-note', '');
  frame.hidden = true;
  head.append(symEl, last, delta, frame);

  const tags = el('div', 'card-tags');

  const wrap = el('div', 'chart-wrap');
  // `amount` because the y-axis labels and the curve itself are prices: privacy
  // mode blurring the headline above a canvas that states the same number to two
  // decimals is the feature defeating itself. drawLineChart cannot be told to
  // omit the levels, so the whole canvas joins the blurred set.
  const canvas = el('canvas', 'detail-chart amount');
  wrap.appendChild(canvas);

  const note = el('p', 'field-note', '');
  root.append(head, tags, wrap, note);
  host.appendChild(root);

  const unwire = wirePicks(head, () => cur);
  // Baseline, session and staleness for the symbol on screen — a chart with no
  // caveat line was the one widget that could show an hours-dead feed as a trend.
  const stopClock = everySecond(() => {
    const sym = subjectOf(cur, pinned);
    paintTags(tags, sym ? tagParts(cur, sym) : []);
    paintFrameAge(frame, cur);
  });

  // A canvas is sized in device pixels, so a resized panel is a redraw and not a
  // reflow. rAF collapses a drag into one draw per frame.
  let pending = 0;
  const redraw = () => {
    pending = 0;
    const pts = seriesOf(cur, subjectOf(cur, pinned));
    drawLineChart(canvas, pts);
  };
  const queue = () => {
    if (pending) return;
    pending = safe(() => requestAnimationFrame(redraw), 0);
    if (!pending) redraw();
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = safe(() => { const o = new ResizeObserver(queue); o.observe(wrap); return o; }, null);
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const sym = subjectOf(cur, pinned);
    paintSubject(symEl, sym);

    const q = sym ? quoteOf(cur, sym) : null;
    setText(last, q ? fmtPrice(q.price, q.currency, priceOpts(cur, sym)) : DASH);
    fillDelta(delta, q, { signed: true });
    paintTags(tags, sym ? tagParts(cur, sym) : []);
    paintFrameAge(frame, cur);

    const pts = sym ? seriesOf(cur, sym) : [];
    // An axis drawn around one point looks like a flat market rather than an
    // absent series, so drawLineChart is left to say "No series data" and this
    // says why. Two points is the minimum that is actually a line.
    setText(note, !sym ? 'Link this chart to a symbol, or pin one to it.'
      : pts.length < 2 ? (isUncovered(cur, sym) ? sym + ' is not covered by the provider handling it, so there is no series to draw.'
        : 'No series for ' + sym + ' yet — it fills in once the app has fetched candles.')
        : sym + ' · ' + pts.length + ' points · delayed, not advice.');

    // The canvas is the one thing here with no text, focus or selection to lose,
    // and it also cannot observe a theme switch, so it is simply redrawn every
    // tick. rAF collapses that into at most one draw per frame.
    queue();
  }

  update(cur);
  return {
    kind: 'chart',
    update,
    setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; update(); },
    destroy() {
      stopClock();
      if (pending) safe(() => cancelAnimationFrame(pending), null);
      if (ro) safe(() => ro.disconnect(), null);
      unwire();
      host.textContent = '';
    },
  };
}

/* ---- quote ---------------------------------------------------------------- */

// Sized to be read from across a room, which means the layout has to survive a
// missing quote without collapsing: every line is present at build time and only
// its text changes.
function createQuote(host, ctx) {
  let cur = ctx || {};
  let pinned = null;

  const root = el('div', 'wg-quote');
  const symEl = symBtn('', 'wg-quote-sym');
  const name = el('div', 'wg-quote-name', '');
  const price = el('div', 'wg-quote-price amount', DASH);
  const delta = el('span', 'delta flat', DASH);
  const tags = el('div', 'card-tags');
  const foot = el('div', 'wg-quote-foot');
  const src = el('span', 'wg-quote-src', '');
  const vol = el('span', 'wg-quote-vol amount', '');
  const age = el('span', 'wg-quote-age', '');
  const frame = el('span', 'wg-quote-frame', '');
  frame.hidden = true;
  foot.append(src, vol, age, frame);
  root.append(symEl, name, price, delta, tags, foot);
  host.appendChild(root);

  const unwire = wirePicks(root, () => cur);
  const stopClock = everySecond(() => {
    const sym = subjectOf(cur, pinned);
    if (sym) paintTags(tags, tagParts(cur, sym));
  });

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const sym = subjectOf(cur, pinned);
    paintSubject(symEl, sym);
    setText(name, sym ? profileName(cur, sym) : '');

    const q = sym ? quoteOf(cur, sym) : null;
    if (!sym) { setText(price, DASH); setText(delta, DASH); setCls(delta, 'delta flat'); }
    else if (!q && isUncovered(cur, sym)) {
      // The one case where a dash would be a lie: the provider answered, and the
      // answer was that it does not have this symbol.
      setText(price, 'Not covered');
      setCls(delta, 'delta flat');
      setText(delta, DASH);
    } else {
      setText(price, q ? fmtPrice(q.price, q.currency, priceOpts(cur, sym)) : DASH);
      fillDelta(delta, q, { signed: true });
    }

    paintTags(tags, sym ? tagParts(cur, sym) : []);
    setText(src, q ? q.source : '');
    // Volume is the one extra field worth the space on a glance panel: it is what
    // says whether the price above it was set by a market or by one small print.
    setText(vol, q && q.volume != null ? 'Vol ' + fmtVolume(q.volume) : '');
    setText(age, q ? 'as of ' + fmtTime(q.ts) : '');
    paintFrameAge(frame, cur);
  }

  update(cur);
  return {
    kind: 'quote',
    update,
    setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; update(); },
    destroy() { stopClock(); unwire(); host.textContent = ''; },
  };
}

/* ---- portfolio ------------------------------------------------------------ */

const PORT_COLS = [
  ['Symbol', false], ['Shares', true], ['Avg', true], ['Last', true],
  ['Value', true], ['Day P/L', true], ['Total P/L', true], ['Weight', true],
];

// This widget cannot add a holding, so its empty state has to name the control
// that can. There is no portfolio view to send anyone to — holdings live in the
// Holdings dialog in the header.
const EMPTY_HOLDINGS = 'No holdings yet. Add one from the Holdings button in the header.';

function createPortfolio(host, ctx) {
  let cur = ctx || {};

  const root = el('div', 'wg-port');
  const stats = el('div', 'stat-row');
  const tiles = {
    value: tile('Total value'), day: tile('Day P/L'), total: tile('Total P/L'), cost: tile('Cost basis'),
  };
  stats.append(tiles.value.root, tiles.day.root, tiles.total.root, tiles.cost.root);

  const curNote = el('p', 'field-note wg-cur-note', '');
  curNote.hidden = true;

  /* A valuation is the one figure in this app a reader is most likely to act on,
     so it has to say how old the prices under it are. Two separate statements:
     the frame's age covers "nothing has refreshed", the stale line covers "one of
     these symbols stopped printing while its market was open". */
  const frame = el('p', 'field-note wg-port-frame', '');
  frame.hidden = true;
  const staleNote = el('p', 'field-note wg-port-stale', '');
  staleNote.hidden = true;

  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data');
  const thead = el('thead');
  const hrow = el('tr');
  for (const [label, num] of PORT_COLS) {
    const th = el('th', num ? 'num' : '', label);
    th.scope = 'col';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);

  const emptyRow = el('tr');
  const emptyCell = el('td', 'empty-cell', EMPTY_HOLDINGS);
  emptyCell.colSpan = PORT_COLS.length;
  emptyRow.appendChild(emptyCell);

  root.append(stats, curNote, frame, staleNote, wrap);
  host.appendChild(root);

  const rows = new Map();      // holding id -> refs
  const unwire = wirePicks(root, () => cur);
  // Ages are clocks. Repainting only the staleness marks keeps the valuation
  // itself on the poll cadence, where it belongs.
  const stopClock = everySecond(() => paintStaleness());

  function paintStaleness() {
    paintFrameAge(frame, cur);
    let n = 0;
    for (const ref of rows.values()) {
      const ms = ref.sym ? staleMsOf(cur, ref.sym) : 0;
      if (ms) n++;
      setHidden(ref.stale, !ms);
      if (ms) {
        setText(ref.stale, 'Stale ' + fmtAge(ms));
        setAttr(ref.stale, 'title', 'This quote’s own timestamp has not advanced while the market is tradeable, '
          + 'so this row — and the totals above — are built from an old price.');
      }
    }
    setHidden(staleNote, n === 0);
    if (n) {
      setText(staleNote, n === 1
        ? 'One of these prices has stopped advancing while its market is tradeable, so the totals above include it as it stands.'
        : n + ' of these prices have stopped advancing while their markets are tradeable, so the totals above include them as they stand.');
    }
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const holdings = Array.isArray(cur.holdings) ? cur.holdings : [];
    const quotes = (cur.quotes && typeof cur.quotes === 'object') ? cur.quotes : {};
    const totals = safe(() => portfolioTotals(holdings, quotes), null);
    if (!totals) {
      // Better an empty table than one filled with numbers whose arithmetic
      // failed halfway.
      setText(emptyCell, 'This portfolio could not be valued.');
      showEmpty();
      return;
    }

    const unit = portfolioCurrency(cur, holdings);
    /* Two decimals, not fmtPrice: a total is an amount of money, and fmtPrice
       takes its precision from the magnitude of the number, which is right for a
       per-unit price and wrong here — a $24.01 day P/L is not '+$24.0110'. */
    const prefix = unit === false ? '' : (!unit || unit === 'USD' ? '$' : unit + ' ');
    const money = (v) => {
      const n = Number(v);
      if (v == null || !Number.isFinite(n)) return DASH;
      return (n < 0 ? '−' : '') + prefix + fmtNum(Math.abs(n), 2);
    };
    const signedMoney = (v) => (v == null ? DASH : (v >= 0 ? '+' : '−') + money(Math.abs(v)));

    setHidden(curNote, unit !== false);
    if (unit === false) {
      setText(curNote, 'Your holdings are quoted in more than one currency. These totals are a plain sum with no '
        + 'conversion applied, so they are shown without a currency symbol.');
    }

    setTile(tiles.value, money(totals.value), null, null);
    setTile(tiles.day, signedMoney(totals.dayPL), totals.dayPL, null);
    setTile(tiles.total, signedMoney(totals.totalPL), totals.totalPL, totals.totalPLPct);
    setTile(tiles.cost, money(totals.cost), null, null);

    const list = totals.rows;
    if (!list.length) { setText(emptyCell, EMPTY_HOLDINGS); showEmpty(); return; }
    if (emptyRow.parentNode) emptyRow.remove();

    const keys = list.map((r, i) => rowKey(r, i));
    const live = new Set(keys);
    for (const [key, ref] of rows) if (!live.has(key)) { ref.root.remove(); rows.delete(key); }

    list.forEach((r, i) => {
      const key = keys[i];
      let ref = rows.get(key);
      if (!ref) { ref = buildPortRow(); rows.set(key, ref); }
      if (tbody.children[i] !== ref.root) tbody.insertBefore(ref.root, tbody.children[i] || null);
      paintPortRow(ref, r, cur, money, signedMoney);
    });
    paintStaleness();
  }

  function showEmpty() {
    for (const [key, ref] of rows) { ref.root.remove(); rows.delete(key); }
    if (!emptyRow.parentNode) tbody.appendChild(emptyRow);
    paintStaleness();
  }

  update(cur);
  return {
    kind: 'portfolio',
    update,
    setSymbol() { /* the portfolio is every holding, not one of them */ },
    destroy() { stopClock(); unwire(); rows.clear(); host.textContent = ''; },
  };
}

// Holdings written before ids existed would otherwise all collide on `undefined`.
function rowKey(r, i) {
  const h = r.holding || {};
  return String(h.id || (h.symbol || '?') + '#' + i);
}

function tile(label) {
  const root = el('div', 'stat-tile');
  const value = el('div', 'st-value amount', DASH);
  const chip = el('span', 'delta flat', '');
  chip.hidden = true;
  root.append(el('div', 'st-label', label), value, chip);
  return { root, value, chip };
}

function setTile(t, text, dir, pct) {
  setText(t.value, text);
  if (dir == null) { setHidden(t.chip, true); return; }
  setHidden(t.chip, false);
  setCls(t.chip, 'delta ' + (dir >= 0 ? 'up' : 'down'));
  setText(t.chip, (dir >= 0 ? '▲' : '▼') + (pct != null ? ' ' + fmtNum(pct) + '%' : ''));
}

function buildPortRow() {
  const root = el('tr');
  const symCell = el('td', 'sym');
  const symEl = symBtn('', 'wg-pick-sym');
  const stale = el('span', 'tag stale', '');
  stale.hidden = true;
  symCell.append(symEl, stale);
  root.appendChild(symCell);
  const cells = [];
  for (let i = 1; i < PORT_COLS.length; i++) {
    const td = el('td', 'num amount', DASH);
    cells.push(td);
    root.appendChild(td);
  }
  return { root, symEl, stale, cells, sym: '' };
}

function paintPortRow(ref, r, ctx, money, signedMoney) {
  const sym = (r.holding && r.holding.symbol) || '';
  ref.sym = sym;
  setText(ref.symEl, sym);
  setAttr(ref.symEl, 'data-sym', sym || null);
  setAttr(ref.symEl, 'title', sym ? 'Link the workspace to ' + sym : null);

  const q = sym ? quoteOf(ctx, sym) : null;
  const uncov = sym && r.price == null && isUncovered(ctx, sym);
  const [shares, avg, lastCell, value, day, total, weight] = ref.cells;
  setText(shares, fmtNum(r.shares));
  // Per-unit prices, at the price's own precision and with the price's currency
  // rule — the same two calls app.js's holdings table makes, so the two views of
  // one holding cannot disagree about what it cost.
  setText(avg, fmtMove(r.avg, r.price));
  setText(lastCell, uncov ? 'Not covered'
    : r.price != null ? fmtPrice(r.price, q && q.currency, priceOpts(ctx, sym)) : DASH);
  setAttr(lastCell, 'title', uncov ? 'The provider handling this symbol returned no quote for it.' : null);
  setText(value, money(r.marketValue));
  setText(day, signedMoney(r.dayPL));
  setCls(day, 'num amount' + (r.dayPL == null ? '' : r.dayPL >= 0 ? ' pos' : ' neg'));
  setText(total, signedMoney(r.totalPL));
  setCls(total, 'num amount' + (r.totalPL == null ? '' : r.totalPL >= 0 ? ' pos' : ' neg'));
  // An unpriced holding has an unknown weight, not a zero one: portfolioTotals
  // divides by the priced total, so 0.0% here would be a share of a sum this row
  // is not in.
  setText(weight, r.weight != null && r.marketValue != null ? r.weight.toFixed(1) + '%' : DASH);
}

/* Totals here are a plain sum with no FX conversion in them, so they may only
   carry a currency symbol when every holding is quoted in the same one. Mixed
   holdings get bare numbers and a line saying why, which is the honest shape of a
   figure that adds dollars to yen. */
function portfolioCurrency(ctx, holdings) {
  const set = new Set();
  for (const h of holdings) {
    const q = quoteOf(ctx, h && h.symbol);
    if (q && q.currency) set.add(q.currency);
  }
  if (set.size > 1) return false;
  return set.size === 1 ? [...set][0] : null;
}

/* ---- tape ----------------------------------------------------------------- */

/* Deliberately not the popout's marquee. A scrolling tape is for a wall display
   nobody interacts with; inside a workspace the symbols are click targets, and a
   target that moves is a target you miss. This one is a single line that scrolls
   only when the user scrolls it. */
function createTape(host, ctx) {
  let cur = ctx || {};
  const root = el('div', 'wg-tape');
  const empty = el('span', 'field-note', 'No symbols yet.');
  root.appendChild(empty);
  host.appendChild(root);

  const items = new Map();
  const unwire = wirePicks(root, () => cur);

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const list = symbolsOf(cur);
    const live = new Set(list);
    setHidden(empty, list.length > 0);

    for (const [sym, ref] of items) if (!live.has(sym)) { ref.root.remove(); items.delete(sym); }
    list.forEach((sym, i) => {
      let ref = items.get(sym);
      if (!ref) { ref = buildTapeItem(sym); items.set(sym, ref); }
      // The empty note is hidden rather than removed, so it keeps slot 0 and the
      // items index one past it.
      const at = i + 1;
      if (root.children[at] !== ref.root) root.insertBefore(ref.root, root.children[at] || null);
      paintTapeItem(ref, sym, cur);
    });
  }

  update(cur);
  return {
    kind: 'tape',
    update,
    setSymbol() { /* the tape is the whole watchlist */ },
    destroy() { unwire(); items.clear(); host.textContent = ''; },
  };
}

function buildTapeItem(sym) {
  const root = el('span', 'wg-tk');
  const symEl = symBtn(sym, 'wg-tk-sym');
  const price = el('span', 'wg-tk-price amount', DASH);
  const pct = el('span', 'wg-tk-pct flat', DASH);
  const mark = el('span', 'wg-tk-stale', '·');
  mark.hidden = true;
  root.append(symEl, price, pct, mark);
  return { root, price, pct, mark };
}

function paintTapeItem(ref, sym, ctx) {
  const q = quoteOf(ctx, sym);
  if (!q && isUncovered(ctx, sym)) {
    setText(ref.price, 'Not covered');
    setAttr(ref.price, 'title', 'The provider handling this symbol returned no quote for it.');
  } else {
    setText(ref.price, q ? fmtPrice(q.price, q.currency, priceOpts(ctx, sym)) : DASH);
    setAttr(ref.price, 'title', null);
  }
  setCls(ref.pct, 'wg-tk-pct ' + direction(q));
  setText(ref.pct, q && q.changePct != null ? fmtPct(q.changePct) : DASH);

  // One line has no room for 'Stale 4m', so the age moves into the title and the
  // marker only has to be noticeable.
  const stale = staleMsOf(ctx, sym);
  setHidden(ref.mark, !stale);
  if (stale) setAttr(ref.mark, 'title', 'Stale ' + fmtAge(stale) + ' — this quote’s timestamp has stopped advancing.');
}

/* ---- alerts --------------------------------------------------------------- */

/* store.alertlog is read here and nowhere else in this file: the fires are not in
   ctx, and duplicating the log into every frame the workspace builds would be a
   hundred entries copied per tick for a panel that may not be open. Reading it is
   also the only storage access any widget makes.

   The log records what was true when a rule fired and deliberately not what the
   price did afterwards — a "you should have acted" column would turn a monitoring
   tool into a scorecard for decisions this app does not make. */
function createAlerts(host, ctx) {
  let cur = ctx || {};
  const root = el('div', 'wg-alerts');
  const rulesBox = el('div', 'wg-rules');
  const rulesEmpty = el('p', 'field-note', 'No armed rules.');
  const disarmed = el('p', 'field-note', '');
  disarmed.hidden = true;
  const logBox = el('div', 'alert-log');
  const logEmpty = el('p', 'field-note', 'Nothing has triggered yet.');

  root.append(sectionHead('Armed rules'), rulesBox, rulesEmpty, disarmed,
    sectionHead('Recent fires'), logBox, logEmpty);
  host.appendChild(root);

  const unwire = wirePicks(root, () => cur);
  let ruleSig = null, logSig = null;

  function update(next) {
    if (next) cur = next;
    const all = Array.isArray(cur.rules) ? cur.rules : [];
    const armed = all.filter((r) => r && r.armed);
    setHidden(rulesEmpty, armed.length > 0);

    const sig = armed.map((r) => [r.id, r.symbol, r.type, r.op, r.value, scopeOf(r)].join('~')).join('|');
    if (sig !== ruleSig) {
      ruleSig = sig;
      rulesBox.textContent = '';
      for (const r of armed) rulesBox.appendChild(ruleRow(r));
    }

    const off = all.length - armed.length;
    setHidden(disarmed, off <= 0);
    if (off > 0) setText(disarmed, off + (off === 1 ? ' rule is disarmed and will not fire.' : ' rules are disarmed and will not fire.'));

    const log = safe(() => (Array.isArray(store.alertlog) ? store.alertlog : []), []);
    const rows = log.slice(-8).reverse();
    setHidden(logEmpty, rows.length > 0);
    const lsig = rows.length + ':' + (rows[0] ? rows[0].ts : '');
    if (lsig !== logSig) {
      logSig = lsig;
      logBox.textContent = '';
      for (const a of rows) logBox.appendChild(logRow(a, cur));
    }
  }

  update(cur);
  return {
    kind: 'alerts',
    update,
    setSymbol() { /* rules are global; filtering them by selection would hide fires */ },
    destroy() { unwire(); host.textContent = ''; },
  };
}

// Legacy rules carry no `sessions`, and they were written when every session
// counted — reporting them as 'Any session' keeps that promise visible.
function scopeOf(rule) {
  const s = rule && rule.sessions;
  if (!Array.isArray(s) || !s.length) return 'any';
  return s.length === 1 && s[0] === 'open' ? 'regular' : 'extended';
}

function ruleRow(r) {
  const row = el('div', 'rule-row');
  row.appendChild(symBtn(r.symbol, 'rr-sym'));
  row.appendChild(el('span', 'rule-cond',
    (r.type === 'pct' ? 'Δ%' : 'price') + ' ' + (r.op === 'above' ? '≥' : '≤') + ' ' + r.value + (r.type === 'pct' ? '%' : '')));
  const scope = scopeOf(r);
  const chip = el('span', 'tag scope ' + scope, SCOPE_LABEL[scope]);
  chip.title = SCOPE_TIP[scope];
  row.appendChild(chip);
  return row;
}

function logRow(a, ctx) {
  const row = el('div', 'log-row');
  row.appendChild(el('span', 'log-time', fmtTime(a && a.ts)));
  if (a && (a.sessionLabel || a.session)) {
    const st = el('span', 'tag sess' + (a.approx ? ' approx' : ''), a.sessionLabel || a.session);
    st.title = a.approx
      ? 'Market session when the rule fired — the calendar could not confirm this date.'
      : 'Market session when the rule fired.';
    row.appendChild(st);
  }
  row.appendChild(el('span', 'log-text', (a && a.text) || ''));
  if (a && a.quote && a.quote.price != null) {
    // The LOGGED symbol decides the prefix, exactly as app.js's copy of this log
    // does it: an FX entry has to still read '1.0848 USD' months after the pair
    // left the board, and '$1.0848' is a ratio dressed as an amount of dollars.
    const snap = el('span', 'log-snap amount', fmtPrice(a.quote.price, a.quote.currency, priceOpts(ctx, a.symbol))
      + (a.quote.changePct != null ? ' (' + fmtNum(a.quote.changePct) + '%)' : ''));
    snap.title = 'Quote at the moment the rule fired' + (a.quote.source ? ' · ' + a.quote.source : '');
    row.appendChild(snap);
  }
  return row;
}

/* ---- session -------------------------------------------------------------- */

/* One row per market actually on the board, rather than one row for whichever
   market the app decided to speak for. A crypto-only watchlist being told "US
   equities: closed" is the exact confusion the market column removes, and a
   mixed board has two answers that are both true at once. */
function createSession(host, ctx) {
  let cur = ctx || {};
  const root = el('div', 'wg-session');
  host.appendChild(root);

  const rows = new Map();      // market id -> refs
  let order = [];
  const stopClock = everySecond(() => paint());

  function markets() {
    const seen = [];
    const add = (m) => { if (m && MARKETS[m] && !seen.includes(m)) seen.push(m); };
    const sel = cur && typeof cur.selection === 'string' ? cur.selection : null;
    if (sel) add(marketOf(cur, sel));
    for (const sym of symbolsOf(cur)) add(marketOf(cur, sym));
    if (!seen.length) add('US_EQUITY');
    return seen;
  }

  function paint() {
    const list = markets();
    if (list.join('|') !== order.join('|')) {
      order = list;
      for (const [id, ref] of rows) if (!list.includes(id)) { ref.root.remove(); rows.delete(id); }
      list.forEach((id, i) => {
        let ref = rows.get(id);
        if (!ref) { ref = buildSessRow(id); rows.set(id, ref); }
        if (root.children[i] !== ref.root) root.insertBefore(ref.root, root.children[i] || null);
      });
    }
    const now = Date.now();
    for (const id of list) paintSessRow(rows.get(id), id, now);
  }

  function update(next) {
    if (next) cur = next;
    paint();
  }

  update(cur);
  return {
    kind: 'session',
    update,
    setSymbol() { /* the row set follows the board, not one symbol */ },
    destroy() { stopClock(); rows.clear(); host.textContent = ''; },
  };
}

function buildSessRow(id) {
  const root = el('div', 'wg-sess-row');
  const mkt = el('span', 'wg-sess-mkt', (MARKETS[id] && MARKETS[id].label) || id);
  const state = el('span', 'tag closed', '');
  const count = el('span', 'wg-sess-count amount', '');
  const nextEl = el('span', 'wg-sess-next', '');
  const detail = el('span', 'wg-sess-detail', '');
  const approx = el('span', 'tag approx', 'approx');
  approx.hidden = true;
  approx.title = 'The holiday table is authoritative through ' + HOLIDAY_HORIZON
    + '; this date is rule-derived and unconfirmed, so treat the boundary as an estimate.';
  root.append(mkt, state, count, nextEl, detail, approx);
  return { root, state, count, next: nextEl, detail, approx };
}

function paintSessRow(ref, id, now) {
  if (!ref) return;
  const s = sessionAt(now, id);
  setCls(ref.state, 'tag ' + (s.isOpen ? 'live' : s.isTradeable ? 'always' : 'closed'));
  setText(ref.state, s.label);
  // Crypto has no boundary to count down to, so nothing is printed rather than a
  // UTC midnight the market does not observe.
  setText(ref.count, s.nextChange ? formatCountdown(s.nextChange - now) : '');
  setText(ref.next, s.nextLabel || '');
  setText(ref.detail, s.detail || '');
  setHidden(ref.approx, !s.approx);
  setAttr(ref.root, 'title', (MARKETS[id] && MARKETS[id].label ? MARKETS[id].label + ' · ' : '') + s.tz);
}
