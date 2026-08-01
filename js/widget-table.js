/* widget-table.js — the dense quote table: one row per watchlist symbol, one
   column per field the provider layer actually returned, sortable by any column.
   It lives in its own module because it is by far the largest widget and because
   nothing else needs its column machinery.

   THE COLUMN SET IS CLOSED, AND DELIBERATELY SO. Every column below reads a real
   property of a normalized quote (providers/base.js) or of a cached profile.
   There is no bid, no ask, no bid size, no ask size and no depth-ladder level,
   because normQuote has no such fields: no free tier here sells order-book data,
   so any such column could only be manufactured from the last trade. A column of
   invented liquidity is the single worst thing a monitoring table could show —
   it is the one number a reader would act on. Do not add one.

   Rendering is a patch, not a rebuild. A rebuild every fifteen seconds is
   trivially easy to write and destroys the scroll offset, the focus ring and any
   text the reader had selected mid-thought — on a table this dense that is the
   whole value proposition gone. So rows are created once per symbol set and
   thereafter only their cell contents change; the <tr> nodes are re-parented, not
   recreated, when a sort reorders them. */

import { fmtPrice, fmtMove, fmtPct, fmtNum, fmtVolume, fmtCap, fmtTime, fmtAge } from './format.js';
import { sessionAt, marketForSymbol } from './session.js';

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
// Fleet i18n bridge — guarded so the module still works without the dictionary.
const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);

// Wraps a host-supplied callback. A widget must not blank itself because the
// container handed it a function that throws on one symbol.
function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
}

/* ---- Columns ---------------------------------------------------------------
   `sort` returns the UNDERLYING value — a number, or a rank for the text
   columns whose alphabetical order means nothing to a trader — never the
   formatted string, so "1,180,000" does not sort below "9". `width` is applied
   through a <colgroup> rather than CSS: column widths are a property of the
   content this file chose to put in them, and the stylesheet cannot know them. */

const SESSION_RANK = { open: 0, pre: 1, post: 2, closed: 3, weekend: 4, holiday: 5 };

const COL_DEFS = [
  {
    id: 'symbol', label: 'Symbol', desc: 'Ticker as requested from the provider.',
    width: '9ch', locked: true, rowHeader: true,
    sort: (r) => r.sym,
    build: (td) => {
      const btn = el('button', 'wt-rowbtn'); btn.type = 'button';
      td.appendChild(btn);
      return { btn };
    },
    patch: (td, r, refs) => {
      setText(refs.btn, r.sym);
      setAttr(refs.btn, 'title', 'Link ' + r.sym + ' to this workspace');
    },
  },
  {
    id: 'name', label: 'Name', desc: 'Company or instrument name, from the cached profile.',
    width: '17ch',
    sort: (r) => (r.prof && r.prof.name ? String(r.prof.name).toUpperCase() : null),
    text: (r) => (r.prof && r.prof.name) || '—',
    title: (r) => (r.prof && r.prof.name) || '',
  },
  {
    id: 'last', label: 'Last', desc: 'Most recent price the provider reported.',
    num: true, width: '11ch', amount: true,
    sort: (r) => q(r, 'price'),
    text: (r) => (r.uncovered ? 'Not covered' : r.q ? fmtPrice(r.q.price, r.q.currency, { fx: r.fx }) : '—'),
    title: (r) => (r.uncovered
      ? 'The provider handling this symbol returned no quote for it.'
      : r.q ? 'As of ' + fmtTime(r.q.ts) + ' · ' + r.q.source : ''),
  },
  {
    id: 'chg', label: 'Chg', desc: 'Absolute change against the baseline in the Basis column.',
    // amount, like every other figure on this row: blurring Last and printing the
    // move, the open, the high, the low and the previous close beside it in full
    // is privacy mode defeating itself four cells to the right.
    num: true, width: '9ch', amount: true,
    sort: (r) => q(r, 'change'),
    // The move is printed at the PRICE's precision. Two decimals turned every
    // move on a sub-dollar coin into "0.00" beside a non-zero percentage.
    text: (r) => (r.q ? fmtMove(r.q.change, r.q.price) : '—'),
    tone: (r) => q(r, 'change'),
  },
  {
    id: 'chgpct', label: 'Chg%', desc: 'Percent change against the baseline in the Basis column.',
    num: true, width: '8ch',
    sort: (r) => q(r, 'changePct'),
    text: (r) => (r.q ? fmtPct(r.q.changePct) : '—'),
    tone: (r) => q(r, 'changePct'),
  },
  {
    id: 'open', label: 'Open', desc: 'Session open, where the provider reports one.',
    num: true, width: '9ch', amount: true,
    sort: (r) => q(r, 'open'),
    // Bare figures, not fmtPrice: the currency is already stated once per row in
    // Last, and repeating "$" down five columns costs width and buys nothing.
    // fmtMove is exactly "this number at that price's precision".
    text: (r) => (r.q ? fmtMove(r.q.open, r.q.price) : '—'),
  },
  {
    id: 'high', label: 'High', desc: 'Session high, where the provider reports one.',
    num: true, width: '9ch', amount: true,
    sort: (r) => q(r, 'high'),
    text: (r) => (r.q ? fmtMove(r.q.high, r.q.price) : '—'),
  },
  {
    id: 'low', label: 'Low', desc: 'Session low, where the provider reports one.',
    num: true, width: '9ch', amount: true,
    sort: (r) => q(r, 'low'),
    text: (r) => (r.q ? fmtMove(r.q.low, r.q.price) : '—'),
  },
  {
    id: 'prevclose', label: 'Prev close', desc: 'The reference the change is measured against.',
    num: true, width: '10ch', amount: true,
    sort: (r) => q(r, 'prevClose'),
    text: (r) => (r.q ? fmtMove(r.q.prevClose, r.q.price) : '—'),
  },
  {
    id: 'range', label: 'Range', desc: 'Where Last sits between Low and High.',
    num: true, width: '9ch',
    sort: (r) => r.rng,
    build: (td) => {
      const wrap = el('div', 'wt-range');
      const track = el('div', 'wt-rtrack');
      const mark = el('div', 'wt-rmark');
      const pct = el('span', 'wt-rpct');
      track.appendChild(mark);
      wrap.append(track, pct);
      td.appendChild(wrap);
      return { wrap, mark, pct };
    },
    patch: (td, r, refs) => {
      const have = r.rng != null;
      refs.wrap.classList.toggle('wt-empty', !have);
      setText(refs.pct, have ? fmtNum(r.rng, 0) + '%' : '—');
      const left = have ? r.rng + '%' : '0%';
      if (refs.mark.style.left !== left) refs.mark.style.left = left;
      setAttr(td, 'title', have
        ? 'Last is ' + fmtNum(r.rng, 0) + '% of the way from ' + fmtMove(r.q.low, r.q.price)
          + ' to ' + fmtMove(r.q.high, r.q.price)
        : 'No high/low reported for this symbol.');
    },
  },
  {
    id: 'volume', label: 'Volume', desc: 'Shares or units traded, as reported.',
    num: true, width: '9ch',
    sort: (r) => q(r, 'volume'),
    text: (r) => (r.q && r.q.volume != null ? fmtVolume(r.q.volume) : '—'),
  },
  {
    id: 'cap', label: 'Mkt cap', desc: 'Market capitalisation from the cached profile.',
    num: true, width: '9ch', amount: true,
    sort: (r) => (r.prof && r.prof.marketCap ? Number(r.prof.marketCap) || null : null),
    text: (r) => (r.prof && r.prof.marketCap ? fmtCap(Number(r.prof.marketCap)) : '—'),
  },
  {
    id: 'exchange', label: 'Exchange', desc: 'Listing venue from the cached profile.',
    width: '11ch',
    sort: (r) => (r.prof && r.prof.exchange ? String(r.prof.exchange).toUpperCase() : null),
    text: (r) => (r.prof && r.prof.exchange) || '—',
    title: (r) => (r.prof && r.prof.exchange) || '',
  },
  {
    id: 'sector', label: 'Sector', desc: 'Industry classification from the cached profile.',
    width: '14ch',
    sort: (r) => (r.prof && r.prof.sector ? String(r.prof.sector).toUpperCase() : null),
    text: (r) => (r.prof && r.prof.sector) || '—',
    title: (r) => (r.prof && r.prof.sector) || '',
  },
  {
    id: 'basis', label: 'Basis', desc: 'What Chg and Chg% are actually measured against.',
    width: '11ch',
    // Ranked, not alphabetical: sorting Basis is a request to group the honest
    // comparisons apart from the ones the provider would not vouch for. The
    // inferred case holds its own rank so it sorts in with neither.
    sort: (r) => (r.basis ? r.basis.rank : null),
    build: (td) => { const t = el('span', 'tag basis'); td.appendChild(t); return { t }; },
    /* A baseline this app guessed from the ticker must not render identically to
       one the provider stated. 'approx' is the dashed marker the rest of the UI
       already uses for "rule-derived, unconfirmed"; 'unstated' is the dimmed
       italic it uses for an absence. Without this the inferred case carried no
       visual difference at all — only a tooltip nobody hovers. */
    patch: (td, r, refs) => {
      const b = r.basis;
      setText(refs.t, b ? b.label : '—');
      const cls = 'tag basis' + (b && b.kind === 'inferred' ? ' approx' : b && b.kind === 'none' ? ' unstated' : '');
      if (refs.t.className !== cls) refs.t.className = cls;
      setAttr(td, 'title', b ? b.note : '');
      td.classList.toggle('wt-warn', !!(b && b.kind !== 'stated'));
    },
  },
  {
    id: 'session', label: 'Session', desc: 'Local-calendar session for this symbol’s market.',
    width: '12ch',
    sort: (r) => (r.sess ? (SESSION_RANK[r.sess.state] ?? 9) : null),
    text: (r) => (r.sess ? r.sess.label : '—'),
    title: (r) => (r.sess ? [r.sess.detail, r.sess.nextLabel].filter(Boolean).join(' · ') : ''),
    mark: (td, r) => {
      setAttr(td, 'data-state', r.sess ? r.sess.state : '');
      td.classList.toggle('wt-approx', !!(r.sess && r.sess.approx));
    },
  },
  {
    id: 'source', label: 'Source', desc: 'Which provider answered for this symbol.',
    width: '10ch',
    sort: (r) => (r.q && r.q.source ? String(r.q.source).toUpperCase() : null),
    text: (r) => (r.q && r.q.source) || '—',
  },
  {
    id: 'asof', label: 'As of', desc: 'When this figure is from — the print itself where the provider says so, otherwise our fetch.',
    num: true, width: '9ch',
    sort: (r) => (r.q ? Number(r.q.ts) || null : null),
    // Only Finnhub timestamps the print (base.js sets tsSource). For everyone
    // else this is when we asked, which advances on every poll whether or not
    // the price did — so it is marked rather than passed off as the print time.
    text: (r) => (r.q ? fmtTime(r.q.ts) + (r.q.tsSource === 'provider' ? '' : '~') : '—'),
    title: (r) => (!r.q ? '' : r.stale
      ? 'This quote’s timestamp has not advanced for ' + fmtAge(r.frozen) + ' while the market is tradeable.'
      : r.q.tsSource === 'provider'
        ? 'Timestamp reported by ' + r.q.source + ' for the print itself.'
        : r.q.source + ' does not timestamp its quotes, so this is when we fetched — not when the price moved.'),
    mark: (td, r) => {
      td.classList.toggle('wt-warn', !!r.stale);
      td.classList.toggle('wt-approx', !!(r.q && r.q.tsSource !== 'provider'));
    },
  },
];

const COL_BY_ID = Object.create(null);
for (const c of COL_DEFS) COL_BY_ID[c.id] = c;

const LOCKED = COL_DEFS.filter((c) => c.locked).map((c) => c.id);
// Exchange, Sector and Source are off by default: they are per-symbol constants,
// so they cost width on every row and change on none of them.
const DEFAULT_COLS = COL_DEFS.filter((c) => !['exchange', 'sector', 'source'].includes(c.id)).map((c) => c.id);

function q(r, key) {
  const v = r.q ? r.q[key] : null;
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

/* ---- Registry entry -------------------------------------------------------- */

export const TABLE_WIDGET = {
  id: 'table',
  label: 'Table',
  desc: 'Every watchlist symbol as one dense sortable row — the whole quote, not the summary.',
  needsSymbol: false,
  minW: 4, minH: 3,
  defaultW: 12, defaultH: 6,
  create(host, ctx) { return createTable(host, ctx); },
};

/* ---- Implementation -------------------------------------------------------- */

function createTable(host, ctx0) {
  let ctx = normCtx(ctx0);
  let visible = initialCols(ctx);
  let sort = initialSort(ctx);
  /* The table shows every symbol, so there is nothing for a per-widget pin to
     filter: the highlight follows the workspace selection and nothing else. It
     deliberately does NOT implement setSymbol — the container only builds the
     symbol control for a needsSymbol widget, and this widget declares itself
     needsSymbol:false, so a pin here would be an API nothing could reach.
     `shown` is seeded rather than null so the first paint highlights the current
     selection without yanking the view to it: nobody asked for a jump on load. */
  let shown = ctx.selection;

  const rows = new Map();      // sym -> { tr, cells: Map<colId, {td, refs}> }
  let symSig = null, colSig = null, orderSig = null;

  const root = el('div', 'wt-root');
  const bar = el('div', 'wt-bar');
  const count = el('span', 'wt-count');
  const frame = el('span', 'wt-frame'); frame.hidden = true;
  // Only a change the USER made reports back up: setColumns() is the container
  // telling us what it already knows, and echoing it would be a write loop.
  const cols = buildColMenu((next) => {
    visible = sanitizeCols(next) || DEFAULT_COLS.slice();
    render(true);
    emit();
  });
  bar.append(count, frame, cols.box);

  const scroll = el('div', 'wt-scroll');
  const table = el('table', 'wt-table');
  const caption = el('caption', 'wt-cap', 'Watchlist quotes — sortable, one row per symbol');
  const colgroup = el('colgroup');
  const thead = el('thead');
  const headRow = el('tr');
  const tbody = el('tbody');
  thead.appendChild(headRow);
  table.append(caption, colgroup, thead, tbody);
  scroll.appendChild(table);
  root.append(bar, scroll);

  const onBodyClick = (e) => {
    const tr = e.target.closest && e.target.closest('tr[data-sym]');
    if (!tr || !tbody.contains(tr)) return;
    safe(() => ctx.onSelect(tr.dataset.sym), null);
  };
  const onHeadClick = (e) => {
    const btn = e.target.closest && e.target.closest('.wt-hbtn');
    if (!btn) return;
    cycleSort(btn.parentNode && btn.parentNode.dataset.col);
  };
  // The column menu is a <details>, so keyboard open/close is free; only the
  // dismiss-on-outside-click behaviour has to be wired up, and it is wired to
  // the document because that is where the clicks it cares about land.
  const onDocClick = (e) => { if (cols.box.open && !cols.box.contains(e.target)) cols.box.open = false; };
  const onDocKey = (e) => { if (e.key === 'Escape' && cols.box.open) { cols.box.open = false; cols.sum.focus(); } };

  tbody.addEventListener('click', onBodyClick);
  thead.addEventListener('click', onHeadClick);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  if (host) { host.textContent = ''; host.appendChild(root); }

  function cycleSort(id) {
    const col = id ? COL_BY_ID[id] : null;
    if (!col) return;
    const first = col.num ? 'desc' : 'asc';
    if (sort.key !== id) sort = { key: id, dir: first };
    else if (sort.dir === first) sort = { key: id, dir: first === 'desc' ? 'asc' : 'desc' };
    // Third press restores the order the container handed us. Without it a
    // sorted table is a one-way door out of the user's own watchlist order.
    else sort = { key: null, dir: 'desc' };
    render(false);
    emit();
  }

  function model() {
    // Deduplicated: two identical symbols would collide on one row record and
    // leave a permanently orphaned <tr> behind.
    const syms = [];
    const seen = new Set();
    for (const s of ctx.symbols) {
      if (typeof s !== 'string' || !s || seen.has(s)) continue;
      seen.add(s); syms.push(s);
    }
    const threshold = staleThreshold(ctx);
    return syms.map((sym) => rowModel(sym, ctx, threshold));
  }

  function rebuildHead(list) {
    colgroup.textContent = '';
    headRow.textContent = '';
    for (const col of list) {
      const c = el('col');
      c.style.width = col.width || '9ch';
      colgroup.appendChild(c);

      const th = el('th', 'wt-h' + (col.num ? ' wt-num' : ''));
      th.setAttribute('scope', 'col');
      th.dataset.col = col.id;
      const btn = el('button', 'wt-hbtn'); btn.type = 'button';
      btn.title = col.desc || col.label;
      btn.append(el('span', 'wt-hlbl', col.label));
      const arrow = el('span', 'wt-harrow');
      arrow.setAttribute('aria-hidden', 'true');
      btn.appendChild(arrow);
      th.appendChild(btn);
      headRow.appendChild(th);
    }
  }

  function rebuildBody(list, data) {
    rows.clear();
    tbody.textContent = '';
    if (!data.length) {
      const tr = el('tr', 'wt-emptyrow');
      const td = el('td', 'wt-emptycell', (window.CarinoI18n ? window.CarinoI18n.t('No symbols in this watchlist yet.') : 'No symbols in this watchlist yet.'));
      td.colSpan = list.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const r of data) {
      const tr = el('tr');
      tr.dataset.sym = r.sym;
      const cells = new Map();
      for (const col of list) {
        const td = el(col.rowHeader ? 'th' : 'td', 'wt-c wt-c-' + col.id
          + (col.num ? ' wt-num' : '') + (col.amount ? ' amount' : ''));
        if (col.rowHeader) td.setAttribute('scope', 'row');
        const refs = col.build ? col.build(td) : null;
        cells.set(col.id, { td, refs });
        tr.appendChild(td);
      }
      rows.set(r.sym, { tr, cells });
      tbody.appendChild(tr);
    }
  }

  function applySort(list) {
    for (const th of headRow.children) {
      const active = th.dataset.col === sort.key;
      th.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.classList.toggle('wt-sorted', active);
      const arrow = th.querySelector('.wt-harrow');
      if (arrow) setText(arrow, active ? (sort.dir === 'asc' ? '▲' : '▼') : '');
    }
    // Hiding the column a table is sorted by falls back to the caller's order
    // rather than sorting by a key with no visible header: an order nothing on
    // screen explains looks like a bug.
    if (!sort.key || !COL_BY_ID[sort.key] || !list.includes(COL_BY_ID[sort.key])) return null;
    return COL_BY_ID[sort.key];
  }

  function order(data, col) {
    if (!col) return data;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const dec = data.map((r, i) => ({ r, i, v: safe(() => col.sort(r), null) }));
    dec.sort((a, b) => {
      // A missing value is not smaller than anything, it is absent. Sinking it in
      // BOTH directions is the only reading that is never wrong; letting nulls
      // float to the top of a descending sort makes the table look broken.
      const an = isBlank(a.v), bn = isBlank(b.v);
      if (an || bn) return an && bn ? a.i - b.i : (an ? 1 : -1);
      let c;
      if (typeof a.v === 'string' || typeof b.v === 'string') c = String(a.v).localeCompare(String(b.v));
      else c = a.v - b.v;
      // Ties fall back to the incoming index, which makes the sort stable and
      // stops equal rows from shuffling on every poll.
      return c ? c * dir : a.i - b.i;
    });
    return dec.map((d) => d.r);
  }

  function render(structural) {
    const list = visible.map((id) => COL_BY_ID[id]).filter(Boolean);
    const data = model();
    const sigC = list.map((c) => c.id).join(',');
    const sigS = data.map((r) => r.sym).join('|');
    if (structural || sigC !== colSig) { rebuildHead(list); colSig = sigC; symSig = null; }
    if (sigS !== symSig) { rebuildBody(list, data); symSig = sigS; orderSig = null; }

    const col = applySort(list);
    const sorted = order(data, col);
    const sigO = sorted.map((r) => r.sym).join('|');
    // Re-parenting an existing <tr> moves it; it does not recreate it. Scroll
    // offset and any in-cell text selection survive a resort.
    if (sigO !== orderSig) {
      for (const r of sorted) { const rec = rows.get(r.sym); if (rec) tbody.appendChild(rec.tr); }
      orderSig = sigO;
    }

    const hi = ctx.selection;
    for (const r of sorted) patchRow(r, hi, list);
    // Scrolled into view only when the selection actually changed, which is the
    // one moment a row eighty deep needs finding; doing it every render would
    // fight the reader's own scrolling on every poll.
    if (hi !== shown) {
      shown = hi;
      const rec = hi ? rows.get(hi) : null;
      if (rec && typeof rec.tr.scrollIntoView === 'function') safe(() => rec.tr.scrollIntoView({ block: 'nearest' }), null);
    }

    // wg-privacy carries the blur rule every other widget uses; wt-privacy is
    // kept for table-specific styling. Only the first one actually blurs.
    root.classList.toggle('wt-privacy', !!ctx.privacy);
    root.classList.toggle('wg-privacy', !!ctx.privacy);
    root.classList.toggle('wt-stalef', ctx.staleMs > 0);
    setText(count, data.length === 1 ? '1 symbol' : data.length + ' symbols');
    frame.hidden = !(ctx.staleMs > 0);
    if (ctx.staleMs > 0) {
      setText(frame, 'Frame ' + fmtAge(ctx.staleMs) + ' old');
      setAttr(frame, 'title', 'No refresh has completed for ' + fmtAge(ctx.staleMs) + '. Every figure below is that old.');
    }
  }

  function patchRow(r, hi, list) {
    const rec = rows.get(r.sym);
    if (!rec) return;
    rec.tr.classList.toggle('wt-frozen', !!r.stale);
    rec.tr.classList.toggle('wt-uncov', !!r.uncovered);
    rec.tr.classList.toggle('wt-sel', r.sym === hi);
    for (const col of list) {
      const cell = rec.cells.get(col.id);
      if (!cell) continue;
      if (col.patch) col.patch(cell.td, r, cell.refs);
      else setText(cell.td, safe(() => col.text(r), '—'));
      if (col.title) setAttr(cell.td, 'title', safe(() => col.title(r), '') || '');
      if (col.tone) tone(cell.td, safe(() => col.tone(r), null));
      if (col.mark) safe(() => col.mark(cell.td, r), null);
    }
    const sym = rec.cells.get('symbol');
    if (sym && sym.refs && sym.refs.btn) sym.refs.btn.setAttribute('aria-current', r.sym === hi ? 'true' : 'false');
  }

  function emit() {
    if (typeof ctx.onWidgetState === 'function') safe(() => ctx.onWidgetState(state()), null);
  }

  function state() { return { columns: visible.slice(), sortKey: sort.key, sortDir: sort.dir }; }

  cols.sync(visible);
  render(true);

  return {
    kind: 'table',

    update(next) {
      ctx = normCtx(next);
      cols.sync(visible);
      render(false);
    },

    // Column set and sort, for whatever is persisting this widget.
    columns() { return visible.slice(); },
    setColumns(ids) { visible = sanitizeCols(ids) || DEFAULT_COLS.slice(); cols.sync(visible); render(true); },
    sortState() { return { key: sort.key, dir: sort.dir }; },
    setSortState(s) {
      const key = s && typeof s.key === 'string' && COL_BY_ID[s.key] ? s.key : null;
      sort = { key, dir: s && s.dir === 'asc' ? 'asc' : 'desc' };
      render(false);
    },
    state,
    setState(s) {
      if (!s || typeof s !== 'object') return;
      const c = sanitizeCols(s.columns);
      if (c) { visible = c; cols.sync(visible); }
      const key = typeof s.sortKey === 'string' && COL_BY_ID[s.sortKey] ? s.sortKey : null;
      sort = { key, dir: s.sortDir === 'asc' ? 'asc' : 'desc' };
      render(true);
    },

    destroy() {
      tbody.removeEventListener('click', onBodyClick);
      thead.removeEventListener('click', onHeadClick);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      rows.clear();
      if (host) host.textContent = '';
    },
  };
}

/* ---- Row model ------------------------------------------------------------- */

function rowModel(sym, ctx, threshold) {
  const quote = ctx.quotes[sym] || null;
  const prof = safe(() => ctx.profileFor(sym), null);
  const mkt = safe(() => ctx.marketFor(sym), null) || marketForSymbol(sym, quote);
  const sess = safe(() => ctx.sessionFor(sym), null) || sessionAt(Date.now(), mkt);
  // A frozen timestamp only means something while the market can print. Outside
  // hours every quote is "frozen" and dimming the whole table would say nothing.
  const frozen = sess && sess.isTradeable ? (Number(safe(() => ctx.frozenMs(sym), 0)) || 0) : 0;
  const rng = quote && quote.low != null && quote.high != null && quote.price != null && quote.high > quote.low
    ? Math.max(0, Math.min(100, ((quote.price - quote.low) / (quote.high - quote.low)) * 100))
    : null;
  return {
    sym, q: quote, prof, mkt, sess, frozen, rng,
    fx: mkt === 'FX',
    stale: frozen > threshold,
    uncovered: !quote && ctx.uncovered.has(sym),
    basis: basisOf(quote, mkt),
  };
}

/* 'unknown' is a real answer, not a missing one: an FX spot rate has no
   reference close, and printing "vs prev close" over it would invent the
   comparison the provider just said it could not make.

   Three kinds, not two. A rolling-24h baseline the provider STATED and one this
   app inferred from the ticker read the same to a human — 'vs 24h' — so they are
   separated here, by rank for sorting and by kind for the marker, rather than
   being flattened into one row class. */
function basisOf(quote, mkt) {
  if (!quote) return null;
  if (quote.baseline === 'prev_close') {
    return { rank: 0, kind: 'stated', label: 'vs prev close', note: quote.baselineNote || 'Baseline reported by the data provider.' };
  }
  if (quote.baseline === 'rolling_24h') {
    return { rank: 1, kind: 'stated', label: 'vs 24h', note: quote.baselineNote || 'Baseline reported by the data provider.' };
  }
  if (mkt === 'CRYPTO') {
    return { rank: 2, kind: 'inferred', label: 'vs 24h',
      note: quote.baselineNote || 'Baseline inferred from asset class — the provider did not state one.' };
  }
  return { rank: 3, kind: 'none', label: 'no baseline',
    note: quote.baselineNote || 'The provider did not say what this change is measured against.' };
}

// Mirrors app.js: three polls' worth of silence, floored at ninety seconds so a
// fast interval does not flag every symbol between two prints.
function staleThreshold(ctx) {
  return Math.max(90000, (Number(ctx.settings.interval) || 15) * 3000);
}

/* ---- Column menu ----------------------------------------------------------- */

function buildColMenu(set) {
  const box = el('details', 'wt-cols');
  const sum = el('summary', 'wt-colsum', 'Columns');
  const menu = el('div', 'wt-colmenu');
  const list = el('div', 'wt-collist');
  const boxes = new Map();

  for (const col of COL_DEFS) {
    const row = el('label', 'wt-colrow');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = col.id;
    if (col.locked) { cb.checked = true; cb.disabled = true; }
    cb.addEventListener('change', () => {
      const next = COL_DEFS.filter((c) => c.locked || (boxes.get(c.id) && boxes.get(c.id).checked)).map((c) => c.id);
      set(next);
    });
    boxes.set(col.id, cb);
    row.append(cb, el('span', 'wt-collbl', col.label));
    row.title = col.desc || col.label;
    list.appendChild(row);
  }

  const reset = el('button', 'wt-colreset', i18nT('Restore defaults'));
  reset.type = 'button';
  reset.addEventListener('click', () => set(DEFAULT_COLS.slice()));

  menu.append(list, reset);
  box.append(sum, menu);

  return {
    box, sum,
    sync(visible) {
      const on = new Set(visible);
      for (const [id, cb] of boxes) if (!cb.disabled) cb.checked = on.has(id);
    },
  };
}

/* ---- ctx hardening --------------------------------------------------------- */

// Only the fields this widget reads. Everything optional degrades to something
// renderable, so a thin ctx (a popout, a first frame before any quote arrived)
// produces an honest empty table instead of an exception.
function normCtx(input) {
  const c = input && typeof input === 'object' ? input : {};
  const fn = (f, fb) => (typeof f === 'function' ? f : fb);
  return {
    quotes: c.quotes && typeof c.quotes === 'object' ? c.quotes : {},
    symbols: Array.isArray(c.symbols) ? c.symbols : [],
    settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
    selection: typeof c.selection === 'string' && c.selection ? c.selection : null,
    uncovered: c.uncovered instanceof Set ? c.uncovered : new Set(),
    staleMs: Number(c.staleMs) || 0,
    privacy: !!c.privacy,
    profileFor: fn(c.profileFor, () => null),
    marketFor: fn(c.marketFor, null),
    sessionFor: fn(c.sessionFor, null),
    frozenMs: fn(c.frozenMs, () => 0),
    onSelect: fn(c.onSelect, () => {}),
    // Optional, additive: the container's persistence hook. Absent in the frozen
    // ctx, so the widget works without it and merely forgets its columns.
    onWidgetState: fn(c.onWidgetState, null),
    widgetState: c.widgetState && typeof c.widgetState === 'object' ? c.widgetState : null,
    tableColumns: Array.isArray(c.tableColumns) ? c.tableColumns : null,
  };
}

function initialCols(ctx) {
  const from = (ctx.widgetState && ctx.widgetState.columns) || ctx.tableColumns;
  return sanitizeCols(from) || DEFAULT_COLS.slice();
}

function initialSort(ctx) {
  const s = ctx.widgetState;
  const key = s && typeof s.sortKey === 'string' && COL_BY_ID[s.sortKey] ? s.sortKey : null;
  return { key, dir: s && s.sortDir === 'asc' ? 'asc' : 'desc' };
}

// Stored ids are canonicalized rather than trusted: a persisted set written by an
// older version can name a column that no longer exists, or omit the row header.
// A set the caller meant (even a one-column one) is honoured; only an unusable
// input returns null and lets the caller fall back to the defaults.
function sanitizeCols(ids) {
  if (!Array.isArray(ids)) return null;
  const known = ids.filter((i) => typeof i === 'string' && COL_BY_ID[i]);
  if (!known.length) return null;
  const want = new Set(known);
  for (const id of LOCKED) want.add(id);
  return COL_DEFS.filter((c) => want.has(c.id)).map((c) => c.id);
}

/* ---- DOM patch helpers ----------------------------------------------------- */

// Writing an identical value would still collapse a text selection inside the
// node in some engines, so every write is guarded by a read.
function setText(node, s) {
  const v = s == null ? '' : String(s);
  if (node.textContent !== v) node.textContent = v;
}

function setAttr(node, name, v) {
  const s = v == null ? '' : String(v);
  if (!s) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  if (node.getAttribute(name) !== s) node.setAttribute(name, s);
}

function tone(td, v) {
  const up = v != null && v > 0, down = v != null && v < 0;
  td.classList.toggle('wt-up', up);
  td.classList.toggle('wt-down', down);
  td.classList.toggle('wt-flat', v == null || v === 0);
}

function isBlank(v) {
  if (v == null || v === '') return true;
  return typeof v === 'number' && !Number.isFinite(v);
}
