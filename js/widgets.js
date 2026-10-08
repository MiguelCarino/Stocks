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
import { PORTFOLIO_WIDGETS } from './widgets-portfolio.js';
import { describeRule, ALERT_TYPES } from './alerttypes.js';
import { sparkline } from './viz.js';
import { mountChartPanel } from './chartpanel.js';
import { MARKET_WIDGETS } from './widgets-market.js';
import { LEARN_WIDGETS } from './widgets-learn.js';
import { helpIcon } from './learn.js';
import { sessionAt, marketForSymbol, formatCountdown, MARKETS, HOLIDAY_HORIZON } from './session.js';
import { fmtPrice, fmtMove, fmtPct, fmtNum, fmtVolume, fmtTime, fmtAge, priceKind } from './format.js';

// UI-string translation via the site dictionary (i18n.js); identity when absent.
const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);

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
    id: 'chart', label: 'Chart', desc: 'Candles, indicators, drawings and alert lines for one symbol.',
    needsSymbol: true, minW: 3, minH: 4, defaultW: 6, defaultH: 6, create: createChart,
  },
  {
    id: 'quote', label: 'Quote', desc: 'One symbol, large enough to read across a room.',
    needsSymbol: true, minW: 2, minH: 2, defaultW: 3, defaultH: 3, create: createQuote,
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
  // Discovery and research: widgets-market.js.
  ...MARKET_WIDGETS,
  // Money: portfolio, allocation, performance, income, calculator.
  ...PORTFOLIO_WIDGETS,
  // Education and your own notes: widgets-learn.js.
  ...LEARN_WIDGETS,
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
    return placeholder(kind, box, i18nT('Unknown widget'), i18nT('This layout asks for a widget this version does not have.'));
  }

  let inner = null;
  try { inner = entry.create(box, ctx || {}); } catch (e) { inner = null; report(kind, e); }
  if (!inner || typeof inner.update !== 'function') {
    return placeholder(kind, box, i18nT(entry.label) + ' · ' + i18nT('unavailable'), i18nT('This widget could not be built.'));
  }

  // A renderer that throws must not throw once per tick forever: it says so, in
  // the slot, and stops being called. Silently keeping the last good frame would
  // leave a dead panel showing live-looking numbers. Its own clocks and listeners
  // go with it — a stopped widget must not keep repainting nodes nobody can see.
  let dead = false;
  const die = (e) => {
    dead = true;
    report(kind, e);
    try { if (typeof inner.destroy === 'function') inner.destroy(); } catch (e) { /* already failing */ }
    failNote(box, entry.label);
  };
  return {
    kind,
    update(next) {
      if (dead) return;
      try { inner.update(next); } catch (e) { die(e); }
    },
    setSymbol(sym) {
      if (dead || typeof inner.setSymbol !== 'function') return;
      try { inner.setSymbol(sym); } catch (e) { die(e); }
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

// The slot says what happened; the console says why, so a stopped widget is a
// bug someone can actually file rather than a silent blank.
function report(kind, e) {
  try { console.error('[widget ' + kind + ']', e); } catch (x) { /* no console */ }
}

function failNote(box, label) {
  box.textContent = '';
  const wrap = el('div', 'wg-blank');
  wrap.append(el('div', 'wg-blank-title', i18nT(label) + ' · ' + i18nT('stopped')));
  wrap.append(el('p', 'field-note', i18nT('This widget hit an error while rendering and has been stopped, '
    + 'so it cannot show you a stale frame as if it were live. Remove and re-add it to try again.')));
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

// FX is a ratio and a stock quotes in cents: fmtPrice needs to be told, because
// it no longer guesses.
function priceOpts(ctx, sym) {
  const m = marketOf(ctx, sym);
  return { fx: m === 'FX', kind: priceKind(m) };
}

// For helpers handed only a quote: the quote carries its own symbol.
function quoteKind(q) {
  return q && q.symbol ? safe(() => priceKind(marketForSymbol(q.symbol, q)), undefined) : undefined;
}

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
  if (sym) b.title = i18nT('Link the workspace to') + ' ' + sym + ' · ' + i18nT('double-click for details');
  return b;
}

/* One delegated listener per widget instead of one per row. Rows are rebuilt on
   watchlist changes and a per-row listener leaks with them.
   A single click LINKS the workspace to the symbol and nothing else; the details
   drawer is an explicit request — double-click, or Enter on a focused symbol —
   because a drawer that opened on every click covered the board the user was
   trying to re-link. Space still clicks, so the keyboard keeps both actions. */
function wirePicks(root, getCtx) {
  const pick = (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-sym]') : null;
    // An empty data-sym is a widget that has no subject yet, not a symbol named ''.
    return t && root.contains(t) && t.dataset.sym ? t.dataset.sym : null;
  };
  const call = (name, sym, e) => {
    const ctx = getCtx();
    const fn = ctx && ctx[name];
    if (typeof fn !== 'function') return false;
    if (e && name === 'openDetails') e.preventDefault();
    try { fn(sym); } catch (e2) { /* the workspace's problem, not this render's */ }
    return true;
  };
  const onClick = (e) => { const s = pick(e); if (s) call('onSelect', s); };
  const onDbl = (e) => { const s = pick(e); if (s) call('openDetails', s, e); };
  const onKey = (e) => { if (e.key !== 'Enter' || e.repeat) return; const s = pick(e); if (s) call('openDetails', s, e); };
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDbl);
  root.addEventListener('keydown', onKey);
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('dblclick', onDbl); root.removeEventListener('keydown', onKey); };
}

// The explicit "open details" control a needsSymbol widget carries in its head.
function detailsBtn(getCtx, getSym) {
  const b = el('button', 'icon-mini wg-details info-i', 'i');
  b.type = 'button';
  b.title = i18nT('Details — quote, fundamentals, events and news');
  b.setAttribute('aria-label', i18nT('Open details'));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const sym = getSym(); const ctx = getCtx();
    if (sym && ctx && typeof ctx.openDetails === 'function') { try { ctx.openDetails(sym); } catch (e2) { /* host */ } }
  });
  return b;
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
  setText(node, arrow + ' ' + fmtMove(q.change, q.price, { kind: quoteKind(q) }) + ' (' + pct + ')');
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
      parts.push(['basis', i18nT(q.baseline === 'rolling_24h' ? 'vs 24h' : 'vs prev close'),
        i18nT(q.baselineNote || 'Baseline reported by the data provider.')]);
    } else if (mkt === 'CRYPTO') {
      // Marked 'approx' rather than plain: this baseline was guessed from the
      // ticker, and a guess that looks identical to a figure the provider vouched
      // for is the guess doing damage.
      parts.push(['basis approx', i18nT('vs 24h'),
        i18nT(q.baselineNote || 'Baseline inferred from asset class — the provider did not state one.')]);
    } else {
      parts.push(['basis unstated', i18nT('no baseline'),
        i18nT(q.baselineNote || 'The provider did not say what this change is measured against.')]);
    }
  }

  if (!q && isUncovered(ctx, sym)) {
    parts.push(['uncovered', i18nT('Not covered'),
      i18nT('The provider handling this symbol returned no quote for it. Try another provider in Settings, '
      + 'or check the symbol.')]);
  }

  if (mkt === 'CRYPTO') parts.push(['always', '24/7', i18nT('Crypto trades continuously; it is never closed.')]);
  else if (sess.state !== 'open') parts.push(['closed', sess.label, [sess.detail, sess.nextLabel].filter(Boolean).join(' · ')]);

  const stale = staleMsOf(ctx, sym);
  if (stale) {
    parts.push(['stale', i18nT('Stale') + ' ' + fmtAge(stale),
      i18nT('This quote’s own timestamp has not advanced while the market is tradeable.')]);
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
  setText(btn, sym || i18nT('No symbol'));
  setAttr(btn, 'data-sym', sym || '');
  setAttr(btn, 'disabled', sym ? null : '');
  setAttr(btn, 'title', sym ? i18nT('Link the workspace to') + ' ' + sym : i18nT('Pin a symbol to this widget, or link it to the workspace.'));
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
  const empty = el('p', 'empty-cell', i18nT('No symbols yet. Add one from the watchlist.'));
  // Beginners get a one-line key to the card, each part with its explanation.
  const legend = el('div', 'card-legend');
  const part = (txt, id) => { const s = el('span', 'card-legend-i', i18nT(txt)); s.append(helpIcon(id)); return s; };
  legend.append(el('span', 'rail-lbl', i18nT('How to read a card')),
    part('Latest price', 'last-price'), part('Change since previous close', 'prev-close'),
    part('Today’s low–high range', 'day-range'), part('Data may be delayed', 'delayed-data'));
  host.append(legend, grid, empty);

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
    setHidden(legend, !(cur.level === 'beginner' && list.length > 0));
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
  setText(ref.ts, q ? i18nT('as of') + ' ' + fmtTime(q.ts) : '');
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
  const kind = { kind: quoteKind(q) };
  setText(ref.lo, fmtMove(q.low, q.price, kind));
  setText(ref.hi, fmtMove(q.high, q.price, kind));
  const left = pct.toFixed(2) + '%';
  if (ref.mark.style.left !== left) ref.mark.style.left = left;
}

/* ---- chart ---------------------------------------------------------------- */

/* The chart tile is a header (symbol, last, change, caveats) over a chart panel
   (chartpanel.js), which owns the toolbar, the engine and the data requests made
   through ctx.candles. Its range, interval, type and indicators are this
   widget's saved state, so two charts of one symbol can show different things. */
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
  const tags = el('div', 'card-tags');
  const info = detailsBtn(() => cur, () => subjectOf(cur, pinned));
  head.append(symEl, last, delta, tags, frame, el('span', 'spacer'), info);

  const body = el('div', 'wg-chart-body amount-chart');
  root.append(head, body);
  host.appendChild(root);

  const unwire = wirePicks(head, () => cur);
  const panel = mountChartPanel(body, {
    getDeps: () => ({ ...cur, quoteFor: (s) => quoteOf(cur, s) }),
    state: cur.widgetState,
    defaults: cur.settings && cur.settings.chartDefaults,
    onState: (next) => { const fn = cur.onWidgetState; if (typeof fn === 'function') safe(() => fn(next), null); },
    readOnly: typeof cur.saveDrawings !== 'function',
    variant: 'widget',
  });
  // Baseline, session and staleness for the symbol on screen — a chart with no
  // caveat line was the one widget that could show an hours-dead feed as a trend.
  const stopClock = everySecond(() => {
    const sym = subjectOf(cur, pinned);
    paintTags(tags, sym ? tagParts(cur, sym) : []);
    paintFrameAge(frame, cur);
  });

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const sym = subjectOf(cur, pinned);
    paintSubject(symEl, sym);
    setHidden(info, !sym || typeof cur.openDetails !== 'function');
    const q = sym ? quoteOf(cur, sym) : null;
    setText(last, q ? fmtPrice(q.price, q.currency, priceOpts(cur, sym)) : (sym && isUncovered(cur, sym) ? i18nT('Not covered') : DASH));
    fillDelta(delta, q, { signed: true });
    paintTags(tags, sym ? tagParts(cur, sym) : []);
    paintFrameAge(frame, cur);
    panel.setSymbol(sym);
    panel.tick();
  }

  update(cur);
  return {
    kind: 'chart',
    update,
    setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; update(); },
    destroy() {
      stopClock();
      unwire();
      safe(() => panel.destroy(), null);
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
  const info = detailsBtn(() => cur, () => subjectOf(cur, pinned));
  info.classList.add('wg-quote-details');
  root.append(symEl, name, price, delta, tags, foot, info);
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
    setHidden(info, !sym || typeof cur.openDetails !== 'function');
    setText(name, sym ? profileName(cur, sym) : '');

    const q = sym ? quoteOf(cur, sym) : null;
    if (!sym) { setText(price, DASH); setText(delta, DASH); setCls(delta, 'delta flat'); }
    else if (!q && isUncovered(cur, sym)) {
      // The one case where a dash would be a lie: the provider answered, and the
      // answer was that it does not have this symbol.
      setText(price, i18nT('Not covered'));
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
    setText(vol, q && q.volume != null ? i18nT('Vol') + ' ' + fmtVolume(q.volume) : '');
    setText(age, q ? i18nT('as of') + ' ' + fmtTime(q.ts) : '');
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
/* The portfolio, allocation, performance, income and calculator widgets live in
   widgets-portfolio.js: they are built on the transaction ledger (portfolio.js)
   rather than the old flat holdings, and share one valuation (folio.js). */

/* ---- tape ----------------------------------------------------------------- */

/* Deliberately not the popout's marquee. A scrolling tape is for a wall display
   nobody interacts with; inside a workspace the symbols are click targets, and a
   target that moves is a target you miss. This one is a single line that scrolls
   only when the user scrolls it. */
function createTape(host, ctx) {
  let cur = ctx || {};
  const root = el('div', 'wg-tape');
  const empty = el('span', 'field-note', i18nT('No symbols yet.'));
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
  const rulesEmpty = el('p', 'field-note', i18nT('No armed rules.'));
  const disarmed = el('p', 'field-note', '');
  disarmed.hidden = true;
  const logBox = el('div', 'alert-log');
  const logEmpty = el('p', 'field-note', i18nT('Nothing has triggered yet.'));

  root.append(sectionHead(i18nT('Armed rules')), rulesBox, rulesEmpty, disarmed,
    sectionHead(i18nT('Recent fires')), logBox, logEmpty);
  host.appendChild(root);

  const unwire = wirePicks(root, () => cur);
  let ruleSig = null, logSig = null;

  function update(next) {
    if (next) cur = next;
    const all = Array.isArray(cur.rules) ? cur.rules : [];
    const armed = all.filter((r) => r && r.armed);
    setHidden(rulesEmpty, armed.length > 0);

    const sig = armed.map((r) => [r.id, r.symbol, r.type, r.op, r.value, JSON.stringify(r.params || {}), scopeOf(r)].join('~')).join('|');
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
  // A portfolio rule has no ticker to link to.
  if (r.symbol && r.symbol[0] !== '@') row.appendChild(symBtn(r.symbol, 'rr-sym'));
  else row.appendChild(el('span', 'rr-sym', i18nT('Portfolio')));
  let text = '';
  try { text = describeRule(r); } catch (e) { text = r.symbol + ' ' + r.type; }
  const cond = el('span', 'rule-cond', text);
  // The number the rule last measured, so a glance says how close it is.
  const def = ALERT_TYPES[r.type];
  if (def && typeof r._prev === 'number' && Number.isFinite(r._prev)) cond.title = i18nT('Last measured') + ': ' + r._prev.toPrecision(6);
  row.appendChild(cond);
  const scope = scopeOf(r);
  const chip = el('span', 'tag scope ' + scope, i18nT(SCOPE_LABEL[scope]));
  chip.title = i18nT(SCOPE_TIP[scope]);
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
  const mkt = el('span', 'wg-sess-mkt', i18nT((MARKETS[id] && MARKETS[id].label) || id));
  const state = el('span', 'tag closed', '');
  const count = el('span', 'wg-sess-count amount', '');
  const nextEl = el('span', 'wg-sess-next', '');
  const detail = el('span', 'wg-sess-detail', '');
  const approx = el('span', 'tag approx', i18nT('approx'));
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
  setAttr(ref.root, 'title', (MARKETS[id] && MARKETS[id].label ? i18nT(MARKETS[id].label) + ' · ' : '') + s.tz);
}
