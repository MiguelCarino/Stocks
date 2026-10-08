/* widgets-portfolio.js — the money widgets: portfolio, allocation, performance,
   income and the trade calculator.

   Same contract as widgets.js: build once in create(), patch in update(), never
   fetch or write storage except through a ctx function the host provides
   (ctx.portfolio, ctx.candles, ctx.events, ctx.setTarget, ctx.setBaseCurrency,
   ctx.setCostMethod, ctx.openLedger, ctx.downloadCSV, ctx.onRequestAlert). A
   detached panel hands over a thinner ctx; each widget values the ledger itself
   there (folio.js) and says what it cannot do instead of failing.

   Everything here derives from the transaction ledger through portfolio.js, so a
   figure on screen can always be re-derived from what the user recorded. Money
   is converted to the base currency with FX quotes the app fetches; a currency
   with no rate is named and left out of the totals rather than added at 1:1.
   Calculators and rebalancing amounts are labelled educational: they are
   arithmetic about the user's own inputs, never a recommendation. */

import { computePortfolio, ledgerSymbols, ledgerAccounts, positionsCSV } from './folio.js';
import { holdingsToTxns, allocation, drift, portfolioHistory, twrSeries, investorFlows, xirr, riskMetrics,
  maxDrawdown, annualize, dividendIncome, positionSize, riskReward, breakEven, recoveryGain, localToday, OTHER } from './portfolio.js';
import { createChart } from './chart.js';
import { fmtPrice, fmtPct, fmtNum, fmtAge, priceKind } from './format.js';
import { helpIcon, learnIdFor, levelAllows } from './learn.js';

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);

// Dates follow the interface language (i18n.js sets <html lang>), not the browser's.
const uiLocale = () => { try { return document.documentElement.lang || undefined; } catch (e) { return undefined; } };
const DASH = '—';
const MINUS = '−';
const STALE_FLOOR_MS = 90000;

/* ---- small helpers (each widget module keeps its own, by design) ------------- */
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fb) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { return fb; } };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
function setText(node, txt) { const s = txt == null ? '' : String(txt); if (node.textContent !== s) node.textContent = s; }
function setHidden(node, h) { if (node.hidden !== !!h) node.hidden = !!h; }
function setCls(node, cls) { if (node.className !== cls) node.className = cls; }
function setAttr(node, name, val) {
  if (val == null) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  if (node.getAttribute(name) !== String(val)) node.setAttribute(name, String(val));
}
function quoteOf(ctx, sym) { const q = ctx && ctx.quotes ? ctx.quotes[sym] : null; return q && typeof q === 'object' ? q : null; }
function symbolsOf(ctx) { return (ctx && Array.isArray(ctx.symbols) ? ctx.symbols : []).filter((s) => typeof s === 'string' && s); }
function subjectOf(ctx, pinned) { return pinned || (ctx && typeof ctx.selection === 'string' && ctx.selection) || symbolsOf(ctx)[0] || null; }
function applyPrivacy(root, ctx) { root.classList.toggle('wg-privacy', !!(ctx && ctx.privacy)); }
function priceOpts(ctx, sym) {
  const m = safe(() => ctx.marketFor(sym), '');
  return { fx: m === 'FX', kind: priceKind(m) };
}
function levelOf(ctx) { return (ctx && ctx.level) || (ctx && ctx.settings && ctx.settings.level) || 'standard'; }
const signCls = (v) => (fin(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '');
function eduNote(text) { return el('p', 'field-note wg-edu', i18nT(text || 'Educational, not advice.')); }
function help(kind, id) { const gid = learnIdFor(kind, id); return gid ? safe(() => helpIcon(gid), null) : null; }

function symBtn(sym, cls) {
  const b = el('button', 'wg-pick ' + (cls || ''), sym);
  b.type = 'button';
  b.dataset.sym = sym || '';
  if (sym) b.title = i18nT('Link the workspace to') + ' ' + sym + ' · ' + i18nT('double-click for details');
  return b;
}

function wirePicks(root, getCtx) {
  const pick = (e) => { const t = e.target && e.target.closest ? e.target.closest('[data-sym]') : null; return t && root.contains(t) && t.dataset.sym ? t.dataset.sym : null; };
  const onClick = (e) => { const s = pick(e); const c = getCtx(); if (s && c && typeof c.onSelect === 'function') safe(() => c.onSelect(s)); };
  const onDbl = (e) => { const s = pick(e); const c = getCtx(); if (s && c && typeof c.openDetails === 'function') { e.preventDefault(); safe(() => c.openDetails(s)); } };
  const onKey = (e) => { if (e.key !== 'Enter') return; const s = pick(e); const c = getCtx(); if (s && c && typeof c.openDetails === 'function') { e.preventDefault(); safe(() => c.openDetails(s)); } };
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDbl);
  root.addEventListener('keydown', onKey);
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('dblclick', onDbl); root.removeEventListener('keydown', onKey); };
}

/* Money is a total, so two decimals and the base currency's prefix — not
   fmtPrice, whose precision follows magnitude (right for a unit price, wrong for
   a $24.01 day P/L). */
export function fmtMoney(v, ccy, { signed = false, compact = false } = {}) {
  if (v == null || !fin(Number(v))) return DASH;
  const n = Number(v);
  const p = !ccy || ccy === 'USD' ? '$' : ccy + ' ';
  const a = Math.abs(n);
  let body;
  if (compact && a >= 1e9) body = (a / 1e9).toFixed(2) + 'B';
  else if (compact && a >= 1e6) body = (a / 1e6).toFixed(2) + 'M';
  else body = fmtNum(a, 2);
  const sign = n < 0 ? MINUS : signed ? '+' : '';
  return sign + p + body;
}

function num(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }

/* The valued portfolio for a ctx: the host's memoised one when it offers it,
   else valued here from whatever ledger (or legacy holdings) the ctx carries. */
function pfOf(ctx, account = '') {
  if (ctx && typeof ctx.portfolio === 'function') { const v = safe(() => ctx.portfolio(account), null); if (v) return v; }
  const s = (ctx && ctx.settings) || {};
  const ledger = ctx && Array.isArray(ctx.ledger) ? ctx.ledger
    : safe(() => holdingsToTxns(ctx && ctx.holdings), []);
  return computePortfolio({ ledger, quotes: (ctx && ctx.quotes) || {}, baseCurrency: s.baseCurrency || 'USD',
    method: s.costMethod || 'fifo', profileFor: (x) => safe(() => ctx.profileFor(x), null), account });
}
function ledgerOf(ctx) { return ctx && Array.isArray(ctx.ledger) ? ctx.ledger : []; }
function baseOf(ctx) { return (ctx && ctx.settings && ctx.settings.baseCurrency) || 'USD'; }

function tile(label, learn) {
  const root = el('div', 'stat-tile');
  const lab = el('div', 'st-label', i18nT(label));
  const h = learn ? help('portfolio', learn) : null;
  if (h) lab.appendChild(h);
  const value = el('div', 'st-value amount', DASH);
  const chip = el('span', 'delta flat', '');
  chip.hidden = true;
  root.append(lab, value, chip);
  return { root, value, chip };
}
function setTile(t, text, dir, pct) {
  setText(t.value, text);
  if (dir == null || !fin(dir)) { setHidden(t.chip, true); return; }
  setHidden(t.chip, false);
  setCls(t.chip, 'delta ' + (dir >= 0 ? 'up' : 'down'));
  setText(t.chip, (dir >= 0 ? '▲' : '▼') + (fin(pct) ? ' ' + fmtNum(pct) + '%' : ''));
}

function segControl(items, current, onPick, cls = '') {
  const seg = el('div', 'seg ' + cls);
  const btns = {};
  for (const [id, label, tip] of items) {
    const b = el('button', 'cs-btn seg-btn sm', i18nT(label));
    b.type = 'button';
    if (tip) b.title = i18nT(tip);
    b.addEventListener('click', () => onPick(id));
    btns[id] = b; seg.appendChild(b);
  }
  const set = (v) => { for (const [id, b] of Object.entries(btns)) { b.classList.toggle('active', id === v); b.setAttribute('aria-pressed', id === v ? 'true' : 'false'); } };
  set(current);
  return { seg, set, btns };
}

function paintFrameAge(node, ctx) {
  const ms = Number(ctx && ctx.staleMs);
  if (!Number.isFinite(ms) || ms <= 0) { setHidden(node, true); return; }
  setHidden(node, false);
  setText(node, i18nT('Prices are') + ' ' + fmtAge(ms) + ' ' + i18nT('old — the app has not completed a poll since.'));
}

const BASE_CHOICES = ['USD', 'EUR', 'GBP', 'MXN', 'BRL', 'CAD', 'JPY', 'CHF', 'AUD'];

/* =============================================================================
   PORTFOLIO — positions, totals, cash; simple view for beginners
   ============================================================================= */
const COLS_FULL = [
  ['symbol', 'Symbol', null, false], ['qty', 'Qty', 'qty', true], ['avg', 'Avg cost', 'avgCost', true],
  ['last', 'Last', null, true], ['value', 'Value', 'marketValue', true], ['day', 'Today', 'dayPL', true],
  ['unreal', 'Unrealized', 'unrealized', true], ['real', 'Realized', 'realized', true],
  ['div', 'Dividends', 'dividends', true], ['weight', 'Weight', 'weight', true],
];
const COLS_SIMPLE = [
  ['symbol', 'Symbol', null, false], ['value', 'Value', 'marketValue', true], ['day', 'Today', 'dayPL', true],
  ['gain', 'Total gain', 'totalReturn', true], ['weight', 'Weight', 'weight', true],
];

function createPortfolio(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = {
    acct: typeof saved.acct === 'string' ? saved.acct : '',
    view: ['simple', 'full'].includes(saved.view) ? saved.view : null,
  };
  const persist = () => safe(() => cur.onWidgetState({ acct: st.acct, view: st.view }));
  const viewNow = () => st.view || (levelOf(cur) === 'beginner' ? 'simple' : 'full');

  const root = el('div', 'wg-port wg-folio');
  const bar = el('div', 'wg-bar');
  const acctSel = el('select', 'cs-select sm wg-acct');
  acctSel.title = i18nT('Show one account or all of them');
  acctSel.setAttribute('aria-label', i18nT('Account'));
  acctSel.addEventListener('change', () => { st.acct = acctSel.value; persist(); update(); });
  const baseSel = el('select', 'cs-select sm wg-base');
  baseSel.title = i18nT('Base currency — every total is converted into it');
  baseSel.setAttribute('aria-label', i18nT('Base currency'));
  baseSel.addEventListener('change', () => { if (typeof cur.setBaseCurrency === 'function') safe(() => cur.setBaseCurrency(baseSel.value)); });
  const method = segControl([['fifo', 'FIFO', 'First in, first out: a sale uses up the oldest shares first.'],
    ['avg', 'Avg', 'Average cost: every share costs the average of what you paid.']], 'fifo',
  (m) => { if (typeof cur.setCostMethod === 'function') safe(() => cur.setCostMethod(m)); });
  const methodWrap = el('span', 'wg-inline');
  methodWrap.append(method.seg);
  const mh = help('portfolio', 'fifo'); if (mh) methodWrap.appendChild(mh);
  const view = segControl([['simple', 'Simple'], ['full', 'Full']], viewNow(), (v) => { st.view = v; persist(); update(); });
  const txBtn = el('button', 'cs-btn sm', i18nT('Transactions'));
  txBtn.type = 'button';
  txBtn.title = i18nT('Add, edit or import buys, sells, dividends and cash');
  txBtn.addEventListener('click', () => safe(() => cur.openLedger()));
  const addBtn = el('button', 'cs-btn sm', '＋ ' + i18nT('Add holding'));
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => safe(() => cur.openLedger({ add: true })));
  const csvBtn = el('button', 'cs-btn sm', 'CSV');
  csvBtn.type = 'button';
  csvBtn.title = i18nT('Download the positions as CSV');
  csvBtn.addEventListener('click', () => {
    const pf = pfOf(cur, st.acct);
    if (pf && typeof cur.downloadCSV === 'function') safe(() => cur.downloadCSV('carino-positions', positionsCSV(pf)));
  });
  bar.append(acctSel, baseSel, methodWrap, view.seg, el('span', 'spacer'), addBtn, txBtn, csvBtn);

  const stats = el('div', 'stat-row wg-folio-stats');
  const tiles = {
    value: tile('Value', 'netWorth'), day: tile('Today', 'dayPL'), gain: tile('Total gain', 'totalReturn'),
    unreal: tile('Unrealized', 'unrealized'), real: tile('Realized', 'realized'), div: tile('Dividends', 'dividends'),
    cash: tile('Cash', 'cash'), cost: tile('Cost basis', 'costBasis'),
  };
  for (const t of Object.values(tiles)) stats.appendChild(t.root);

  const notes = el('div', 'wg-folio-notes');
  const frame = el('p', 'field-note wg-port-frame', ''); frame.hidden = true;
  const curNote = el('p', 'field-note warn-note', ''); curNote.hidden = true;
  const unpricedNote = el('p', 'field-note', ''); unpricedNote.hidden = true;
  const errNote = el('p', 'field-note warn-note', ''); errNote.hidden = true;
  const migNote = el('p', 'field-note', ''); migNote.hidden = true;
  const staleNote = el('p', 'field-note wg-port-stale', ''); staleNote.hidden = true;
  notes.append(frame, curNote, unpricedNote, staleNote, errNote, migNote);

  const wrap = el('div', 'table-wrap wg-folio-wrap');
  const table = el('table', 'data wg-folio-table');
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);
  const empty = el('div', 'wg-folio-empty');
  const emptyTxt = el('p', 'empty-cell', i18nT('No holdings yet.'));
  const emptyBtn = el('button', 'btn-primary sm', i18nT('Add your first holding'));
  emptyBtn.type = 'button';
  emptyBtn.addEventListener('click', () => safe(() => cur.openLedger({ add: true })));
  const emptyImp = el('button', 'cs-btn sm', i18nT('Import a broker CSV'));
  emptyImp.type = 'button';
  emptyImp.addEventListener('click', () => safe(() => cur.openLedger({ import: true })));
  empty.append(emptyTxt, emptyBtn, emptyImp);
  empty.hidden = true;
  const foot = el('p', 'field-note wg-edu', i18nT('Entered by you, valued with delayed quotes. Not connected to any brokerage. Not tax advice.'));

  root.append(bar, stats, notes, wrap, empty, foot);
  host.appendChild(root);
  const unwire = wirePicks(root, () => cur);
  const rows = new Map();
  let headSig = '', acctSig = '', baseSig = '';
  let timer = null;
  try { timer = setInterval(() => { try { paintFrameAge(frame, cur); paintStale(); } catch (e) { /* keep ticking */ } }, 1000); } catch (e) { timer = null; }

  function staleMs(sym) {
    const sess = safe(() => cur.sessionFor(sym), null);
    if (!sess || !sess.isTradeable) return 0;
    const ms = Number(safe(() => cur.frozenMs(sym), 0)) || 0;
    const iv = Number(cur.settings && cur.settings.interval) || 15;
    return ms > Math.max(STALE_FLOOR_MS, iv * 3000) ? ms : 0;
  }
  function paintStale() {
    let n = 0;
    for (const ref of rows.values()) {
      const ms = ref.sym && !ref.cash ? staleMs(ref.sym) : 0;
      if (ms) n++;
      if (ref.stale) { setHidden(ref.stale, !ms); if (ms) setText(ref.stale, i18nT('Stale') + ' ' + fmtAge(ms)); }
    }
    setHidden(staleNote, !n);
    if (n) setText(staleNote, n === 1 ? i18nT('One price has stopped updating while its market is open; the totals use it as it stands.')
      : n + ' ' + i18nT('prices have stopped updating while their markets are open; the totals use them as they stand.'));
  }

  function fillAccounts() {
    const accts = ledgerAccounts(ledgerOf(cur));
    const s = accts.join('|') + '#' + st.acct;
    if (s === acctSig) return;
    acctSig = s;
    acctSel.textContent = '';
    const all = el('option', null, i18nT('All accounts')); all.value = ''; acctSel.appendChild(all);
    for (const a of accts) { const o = el('option', null, a); o.value = a; acctSel.appendChild(o); }
    if (st.acct && !accts.includes(st.acct)) st.acct = '';
    acctSel.value = st.acct;
    setHidden(acctSel, accts.length < 1);
  }
  function fillBase() {
    const base = baseOf(cur);
    const seen = new Set(BASE_CHOICES);
    for (const t of ledgerOf(cur)) if (t && t.currency) seen.add(t.currency);
    seen.add(base);
    const list = [...seen];
    const s = list.join('|') + '#' + base;
    if (s === baseSig) return;
    baseSig = s;
    baseSel.textContent = '';
    for (const c of list) { const o = el('option', null, c); o.value = c; baseSel.appendChild(o); }
    baseSel.value = base;
    baseSel.disabled = typeof cur.setBaseCurrency !== 'function';
  }

  function buildHead(cols) {
    const hs = cols.map((c) => c[0]).join(',');
    if (hs === headSig) return;
    headSig = hs;
    thead.textContent = '';
    const tr = el('tr');
    for (const [, label, learn, isNum] of cols) {
      const th = el('th', isNum ? 'num' : '', i18nT(label));
      th.scope = 'col';
      const h = learn ? help('portfolio', learn) : null;
      if (h) th.appendChild(h);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    for (const ref of rows.values()) ref.root.remove();
    rows.clear();
  }

  function rowRefs(cols, cash) {
    const tr = el('tr', cash ? 'wg-cash-row' : '');
    const cells = {};
    for (const [id] of cols) {
      const td = el('td', id === 'symbol' ? 'sym' : 'num amount', DASH);
      cells[id] = td;
      tr.appendChild(td);
    }
    let symEl = null, stale = null, acctTag = null;
    if (!cash) {
      cells.symbol.textContent = '';
      symEl = symBtn('', 'wg-pick-sym');
      acctTag = el('span', 'tag wg-acct-tag', ''); acctTag.hidden = true;
      stale = el('span', 'tag stale', ''); stale.hidden = true;
      cells.symbol.append(symEl, acctTag, stale);
    }
    return { root: tr, cells, symEl, stale, acctTag, cash, sym: '' };
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    fillAccounts();
    fillBase();
    const v = viewNow();
    view.set(v);
    method.set((cur.settings && cur.settings.costMethod) || 'fifo');
    setHidden(methodWrap, v === 'simple' || typeof cur.setCostMethod !== 'function');
    const canEdit = typeof cur.openLedger === 'function';
    setHidden(txBtn, !canEdit); setHidden(addBtn, !canEdit); setHidden(emptyBtn, !canEdit); setHidden(emptyImp, !canEdit);
    setHidden(csvBtn, typeof cur.downloadCSV !== 'function');

    const pf = pfOf(cur, st.acct);
    const base = (pf && pf.baseCurrency) || baseOf(cur);
    const money = (x, o) => fmtMoney(x, base, o);
    if (!pf || pf.empty) {
      setHidden(wrap, true); setHidden(stats, true); setHidden(empty, false);
      setText(emptyTxt, pf ? i18nT('No holdings yet. Record what you own to see its value, today’s move and your gain.') : i18nT('This portfolio could not be valued.'));
      for (const n of [curNote, unpricedNote, errNote, migNote]) setHidden(n, true);
      paintFrameAge(frame, cur);
      return;
    }
    setHidden(wrap, false); setHidden(stats, false); setHidden(empty, true);
    const T = pf.totals;
    const totalPct = T.costBasis ? T.totalReturn / Math.abs(T.costBasis) * 100 : null;
    const prevValue = fin(T.dayPL) ? T.marketValue - T.dayPL : null;
    setTile(tiles.value, money(T.netWorth), null, null);
    setTile(tiles.day, money(T.dayPL, { signed: true }), T.dayPL, prevValue ? T.dayPL / Math.abs(prevValue) * 100 : null);
    setTile(tiles.gain, money(T.totalReturn, { signed: true }), T.totalReturn, totalPct);
    setTile(tiles.unreal, money(T.unrealized, { signed: true }), T.unrealized, T.costBasis ? T.unrealized / Math.abs(T.costBasis) * 100 : null);
    setTile(tiles.real, money(T.realized, { signed: true }), null, null);
    setTile(tiles.div, money(T.dividends), null, null);
    setTile(tiles.cash, money(T.cash), null, null);
    setTile(tiles.cost, money(T.costBasis), null, null);
    const simple = v === 'simple';
    for (const k of ['unreal', 'real', 'div', 'cost']) setHidden(tiles[k].root, simple);
    setHidden(tiles.cash.root, !T.cashTracked);
    tiles.cash.root.title = T.cashTracked && T.cash < 0
      ? i18nT('Negative: the ledger records more bought than deposited. Record your deposits, or the opening cash balance, to fix it.') : '';

    setHidden(curNote, !T.currencyMissing.length);
    if (T.currencyMissing.length) {
      setText(curNote, i18nT('No exchange rate yet for') + ' ' + T.currencyMissing.join(', ') + ' → ' + base + '. '
        + i18nT('Those amounts are left out of the totals until a rate arrives — they are not counted at 1:1.'));
    }
    setHidden(unpricedNote, !T.unpriced.length);
    if (T.unpriced.length) setText(unpricedNote, i18nT('No price yet for') + ' ' + [...new Set(T.unpriced)].join(', ') + '. ' + i18nT('Their value is unknown, not zero, and is not in the totals.'));
    const errs = (pf.errors || []).length;
    setHidden(errNote, !errs);
    if (errs) setText(errNote, errs + ' ' + i18nT(errs === 1 ? 'transaction needs attention (open Transactions to see it).' : 'transactions need attention (open Transactions to see them).'));
    const mig = ledgerOf(cur).filter((t) => t && t.date === '1970-01-01').length;
    setHidden(migNote, !mig || simple);
    if (mig) setText(migNote, mig + ' ' + i18nT('position(s) came from the old holdings list with no purchase date. Add the real date in Transactions for accurate returns.'));
    paintFrameAge(frame, cur);

    const cols = simple ? COLS_SIMPLE : COLS_FULL;
    buildHead(cols);
    const list = pf.positions.slice();
    const cashRows = Object.entries(pf.cash || {}).filter(([, a]) => fin(a) && Math.abs(a) > 1e-9);
    const keys = list.map((p) => 'p|' + p.account + '|' + p.symbol).concat(cashRows.map(([c]) => 'c|' + c));
    const live = new Set(keys);
    for (const [k, ref] of rows) if (!live.has(k)) { ref.root.remove(); rows.delete(k); }
    keys.forEach((k, i) => {
      let ref = rows.get(k);
      const isCash = k.startsWith('c|');
      if (!ref) { ref = rowRefs(cols, isCash); rows.set(k, ref); }
      if (tbody.children[i] !== ref.root) tbody.insertBefore(ref.root, tbody.children[i] || null);
      if (isCash) paintCashRow(ref, cashRows[i - list.length], pf, money);
      else paintPosRow(ref, list[i], pf, money, simple);
    });
    paintStale();
  }

  function paintCashRow(ref, [ccy, amount], pf, money) {
    const c = ref.cells;
    setText(c.symbol, i18nT('Cash') + ' · ' + ccy);
    const r = safe(() => pf.fx(ccy, pf.baseCurrency), null);
    const vb = fin(r) ? amount * r : null;
    setText(c.value, vb != null ? money(vb) : fmtMoney(amount, ccy));
    if (c.weight) setText(c.weight, vb != null && weightOnNetWorth(pf) ? fmtNum(vb / pf.totals.netWorth * 100, 1) + '%' : DASH);
  }

  // One base for the whole Weight column, so it sums to 100%. With positive cash
  // on record that base is net worth (cash is a holding too); otherwise — no cash
  // tracked, or negative cash that would push weights past 100% — it is the
  // invested value, and the cash row shows no weight.
  function weightOnNetWorth(pf) {
    const T = pf.totals;
    return !!(T.cashTracked && fin(T.cash) && T.cash > 0 && fin(T.netWorth) && T.netWorth > 0);
  }

  function paintPosRow(ref, p, pf, money, simple) {
    const c = ref.cells;
    ref.sym = p.symbol;
    setText(ref.symEl, p.symbol);
    setAttr(ref.symEl, 'data-sym', p.symbol);
    setHidden(ref.acctTag, !p.account);
    setText(ref.acctTag, p.account || '');
    const q = quoteOf(cur, p.symbol);
    const r = safe(() => pf.fx(p.currency, pf.baseCurrency), null);
    const conv = (x) => (fin(x) && fin(r) ? x * r : null);
    const uncov = p.price == null && safe(() => cur.uncovered.has(p.symbol), false);
    setText(c.value, uncov ? i18nT('Not covered') : money(p.valueBase));
    setText(c.day, money(p.dayPLBase, { signed: true }));
    setCls(c.day, 'num amount ' + signCls(p.dayPLBase));
    c.day.title = fin(p.dayPLPct) ? fmtPct(p.dayPLPct) + ' ' + i18nT('today') : '';
    const w = weightOnNetWorth(pf) ? (fin(p.valueBase) ? p.valueBase / pf.totals.netWorth * 100 : null) : p.weight;
    setText(c.weight, fin(w) ? fmtNum(w, 1) + '%' : DASH);
    if (simple) {
      const g = fin(p.unrealizedBase) ? p.unrealizedBase + (conv(p.realized + p.dividends) || 0) : null;
      setText(c.gain, money(g, { signed: true }) + (fin(p.unrealizedPct) ? ' (' + fmtPct(p.unrealizedPct) + ')' : ''));
      setCls(c.gain, 'num amount ' + signCls(g));
      return;
    }
    setText(c.qty, Number.isInteger(p.qty) ? fmtNum(p.qty, 0) : String(+p.qty.toFixed(8)));
    const lots = (p.lots || []).map((l) => l.date + '  ' + fmtNum(l.qty, 4) + ' @ ' + fmtNum(l.price, 4)).join('\n');
    c.qty.title = lots ? i18nT('Open lots') + ' (' + pf.method.toUpperCase() + ')\n' + lots : '';
    const ccySuffix = p.currency && p.currency !== pf.baseCurrency ? ' ' + p.currency : '';
    setText(c.avg, fin(p.avgCost) ? fmtNum(p.avgCost, p.avgCost >= 100 ? 2 : 4) + ccySuffix : DASH);
    setText(c.last, uncov ? i18nT('Not covered') : fin(p.price) ? fmtPrice(p.price, q && q.currency ? q.currency : p.currency, priceOpts(cur, p.symbol)) : DASH);
    setText(c.unreal, money(p.unrealizedBase, { signed: true }) + (fin(p.unrealizedPct) ? ' (' + fmtPct(p.unrealizedPct) + ')' : ''));
    setCls(c.unreal, 'num amount ' + signCls(p.unrealizedBase));
    const rb = conv(p.realized);
    setText(c.real, p.realized ? money(rb, { signed: true }) : DASH);
    setCls(c.real, 'num amount ' + signCls(rb));
    setText(c.div, p.dividends ? money(conv(p.dividends)) : DASH);
  }

  update(cur);
  return {
    kind: 'portfolio',
    update,
    setSymbol() { /* the portfolio is every holding, not one of them */ },
    destroy() { if (timer) clearInterval(timer); unwire(); rows.clear(); host.textContent = ''; },
  };
}

/* =============================================================================
   ALLOCATION — donut + table, targets and drift (informational)
   ============================================================================= */
const ALLOC_BY = [['assetClass', 'Asset class'], ['symbol', 'Holding'], ['sector', 'Sector'], ['currency', 'Currency'], ['account', 'Account']];
const DRIFT_BAND = 5;   // percentage points either side of a target
const SVGNS = 'http://www.w3.org/2000/svg';

function createAllocation(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = { by: ALLOC_BY.some((b) => b[0] === saved.by) ? saved.by : 'assetClass', cash: saved.cash !== false };
  const persist = () => safe(() => cur.onWidgetState({ by: st.by, cash: st.cash }));
  const root = el('div', 'wg-alloc');
  const bar = el('div', 'wg-bar');
  const by = segControl(ALLOC_BY, st.by, (v) => { st.by = v; persist(); sig = ''; update(); });
  const cashLbl = el('label', 'chk wg-chk');
  const cashChk = el('input'); cashChk.type = 'checkbox'; cashChk.checked = st.cash;
  cashChk.addEventListener('change', () => { st.cash = cashChk.checked; persist(); sig = ''; update(); });
  cashLbl.append(cashChk, el('span', null, i18nT('Include cash')));
  const ah = help('portfolio', 'allocation');
  bar.append(by.seg, cashLbl);
  if (ah) bar.appendChild(ah);
  const body = el('div', 'wg-alloc-body');
  const svgBox = el('div', 'wg-donut');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('role', 'img');
  svgBox.appendChild(svg);
  const center = el('div', 'wg-donut-c');
  const centerV = el('div', 'wg-donut-v amount', DASH);
  const centerL = el('div', 'wg-donut-l', '');
  center.append(centerV, centerL);
  svgBox.appendChild(center);
  const tWrap = el('div', 'table-wrap wg-alloc-wrap');
  const table = el('table', 'data wg-alloc-table');
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  tWrap.appendChild(table);
  body.append(svgBox, tWrap);
  const warn = el('p', 'field-note warn-note', ''); warn.hidden = true;
  const note = el('p', 'field-note', '');
  root.append(bar, body, warn, note, eduNote('Differences to target are informational arithmetic, not instructions to buy or sell. Fees and taxes are ignored.'));
  host.appendChild(root);
  const unwire = wirePicks(tbody, () => cur);
  let sig = '', headSig = '';

  function header(showTargets) {
    const hs = String(showTargets);
    if (hs === headSig) return;
    headSig = hs;
    thead.textContent = '';
    const tr = el('tr');
    const cols = [['', null, false], ['Value', null, true], ['Weight', 'weight', true]];
    if (showTargets) cols.push(['Target %', 'targets', true], ['Drift', 'drift', true], ['To target', 'drift', true]);
    for (const [l, learn, isNum] of cols) {
      const th = el('th', isNum ? 'num' : '', i18nT(l)); th.scope = 'col';
      const h = learn ? help('portfolio', learn) : null; if (h) th.appendChild(h);
      if (l === 'To target') th.title = i18nT('Difference to target (informational)');
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    by.set(st.by);
    const pf = pfOf(cur, '');
    const base = (pf && pf.baseCurrency) || baseOf(cur);
    const showTargets = levelAllows(levelOf(cur), 'portfolio.targets') && typeof cur.setTarget === 'function';
    header(showTargets);
    if (!pf || pf.empty) {
      svg.textContent = ''; tbody.textContent = ''; setText(centerV, DASH); setText(centerL, '');
      setText(note, i18nT('Record holdings in Transactions to see how your money is spread.'));
      setHidden(warn, true); sig = ''; return;
    }
    // A negative cash balance (more bought than the ledger shows deposited) is
    // not a slice of anything; it is left out and said so below.
    const cashV = st.cash && pf.totals.cashTracked && pf.totals.cash > 0 ? pf.totals.cash : 0;
    const rows = allocation(pf.positions, (s) => safe(() => cur.profileFor(s), null), st.by, { cash: cashV });
    const targets = {};
    const tsrc = (cur.targets && typeof cur.targets === 'object') ? cur.targets : {};
    const prefix = st.by + ':';
    for (const [k, v] of Object.entries(tsrc)) if (k.startsWith(prefix)) targets[k.slice(prefix.length)] = v;
    const dr = drift(rows, targets);
    const total = rows.reduce((s, r) => s + (fin(r.value) ? r.value : 0), 0);
    setText(centerV, fmtMoney(total, base, { compact: true }));
    setText(centerL, i18nT(ALLOC_BY.find((b) => b[0] === st.by)[1]));

    // Never rebuild under a focused target input: the user is typing in it.
    const editing = tbody.contains(document.activeElement);
    const newSig = st.by + '|' + showTargets + '|' + dr.map((r) => r.key + ':' + (r.value || 0).toFixed(0) + ':' + r.target).join(',');
    if (newSig !== sig && !editing) {
      sig = newSig;
      // Symbols and account names are the user's own words; bucket names
      // (sectors, asset classes) are ours and translate.
      const labelOf = (r) => r.key === OTHER ? i18nT('Other/Unknown') : r.key === 'Cash' ? i18nT('Cash')
        : st.by === 'symbol' || st.by === 'account' ? (r.label || r.key) : i18nT(r.label || r.key);
      // One colour per key in donut AND table: drift() may order or extend the
      // rows differently (a target with no holding), so index by key, not position.
      const colorIdx = new Map(rows.map((r, i) => [r.key, i]));
      const swatch = (key) => swatchCls(key, colorIdx.has(key) ? colorIdx.get(key) : rows.length);
      paintDonut(svg, rows, labelOf, swatch);
      tbody.textContent = '';
      dr.forEach((r) => {
        const tr = el('tr');
        const th = el('td', 'sym');
        const sw = el('span', 'wg-sw ' + swatch(r.key));
        th.appendChild(sw);
        const label = labelOf(r);
        if (st.by === 'symbol' && r.key !== 'Cash') th.appendChild(symBtn(r.key, 'wg-pick-sym'));
        else th.appendChild(el('span', null, label));
        tr.appendChild(th);
        tr.appendChild(el('td', 'num amount', fmtMoney(r.value, base)));
        tr.appendChild(el('td', 'num', fin(r.weight) ? fmtNum(r.weight, 1) + '%' : DASH));
        if (showTargets) {
          const td = el('td', 'num');
          const inp = el('input', 'input sm wg-target');
          inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = 'any';
          inp.value = r.target == null ? '' : String(r.target);
          inp.placeholder = '—';
          inp.setAttribute('aria-label', i18nT('Target %') + ' ' + label);
          inp.addEventListener('change', () => {
            const n = num(inp.value);
            safe(() => cur.setTarget(prefix + r.key, n == null ? null : Math.max(0, Math.min(100, n))));
            sig = ''; inp.blur(); update();
          });
          td.appendChild(inp);
          tr.appendChild(td);
          const out = fin(r.drift) && Math.abs(r.drift) > DRIFT_BAND;
          const dTd = el('td', 'num' + (out ? ' wg-drift-out' : ''), fin(r.drift) ? (r.drift >= 0 ? '+' : MINUS) + fmtNum(Math.abs(r.drift), 1) + ' pp' : DASH);
          if (out) dTd.title = i18nT('Outside the ±5 percentage-point band');
          tr.appendChild(dTd);
          tr.appendChild(el('td', 'num amount ' + signCls(r.toRebalance), fin(r.toRebalance) ? fmtMoney(r.toRebalance, base, { signed: true }) : DASH));
        }
        tbody.appendChild(tr);
      });
    }
    const sum = dr.targetSum;
    const hasT = Object.keys(targets).length > 0;
    setHidden(warn, !(showTargets && hasT && Math.abs(sum - 100) > 0.05));
    if (showTargets && hasT) setText(warn, i18nT('Targets add up to') + ' ' + fmtNum(sum, 1) + '% — ' + i18nT('they should total 100%.'));
    const parts = [];
    if (rows.excluded) parts.push(rows.excluded + ' ' + i18nT('position(s) without a price are left out.'));
    if (st.cash && pf.totals.cashTracked && pf.totals.cash < 0) parts.push(i18nT('Cash is negative in the ledger and is left out.'));
    if (st.by === 'sector') parts.push(i18nT('Sectors come from cached company profiles; funds and coins usually have none.'));
    if (st.by === 'account' && !ledgerAccounts(ledgerOf(cur)).length) parts.push(i18nT('No accounts recorded — set one on each transaction to split by account.'));
    parts.push(i18nT('Values in') + ' ' + base + '.');
    setText(note, parts.join(' '));
  }

  update(cur);
  return { kind: 'allocation', update, setSymbol() {}, destroy() { unwire(); host.textContent = ''; } };
}

function swatchCls(key, i) {
  if (key === OTHER) return 'al-other';
  if (key === 'Cash') return 'al-cash';
  return 'al-c' + (i % 6) + (i >= 6 ? ' al-dim' : '');
}

function paintDonut(svg, rows, labelOf, swatch) {
  svg.textContent = '';
  const total = rows.reduce((s, r) => s + (fin(r.value) && r.value > 0 ? r.value : 0), 0);
  const cx = 60, cy = 60, R = 54, r0 = 34;
  const ring = document.createElementNS(SVGNS, 'circle');
  ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', (R + r0) / 2);
  ring.setAttribute('class', 'wg-donut-ring'); ring.setAttribute('stroke-width', R - r0); ring.setAttribute('fill', 'none');
  svg.appendChild(ring);
  if (!total) return;
  let a = -Math.PI / 2;
  rows.forEach((r) => {
    if (!(r.value > 0)) return;
    const frac = r.value / total;
    const a2 = a + frac * Math.PI * 2;
    const path = document.createElementNS(SVGNS, 'path');
    if (frac >= 0.9999) {
      path.setAttribute('d', `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R} L ${cx - 0.01} ${cy - r0} A ${r0} ${r0} 0 1 0 ${cx} ${cy - r0} Z`);
    } else {
      const large = a2 - a > Math.PI ? 1 : 0;
      const p = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)].map((v) => v.toFixed(3)).join(' ');
      path.setAttribute('d', `M ${p(R, a)} A ${R} ${R} 0 ${large} 1 ${p(R, a2)} L ${p(r0, a2)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a)} Z`);
    }
    path.setAttribute('class', 'wg-slice ' + swatch(r.key));
    const t = document.createElementNS(SVGNS, 'title');
    t.textContent = labelOf(r) + ' · ' + fmtNum(frac * 100, 1) + '%';
    path.appendChild(t);
    svg.appendChild(path);
    a = a2;
  });
}

/* =============================================================================
   PERFORMANCE — value history vs a benchmark, TWR, XIRR and risk
   ============================================================================= */
const PERF_RANGES = [['1M', '1M'], ['3M', '3M'], ['YTD', 'YTD'], ['1Y', '1Y'], ['ALL', 'All']];
const BAR_TTL = 30 * 60 * 1000;
const BARS = new Map();      // `${sym}|${range}` -> {at, res}
const BARS_INFLIGHT = new Map();

function fetchBars(ctx, sym, range) {
  const key = sym + '|' + range;
  const hit = BARS.get(key);
  if (hit && Date.now() - hit.at < BAR_TTL) return Promise.resolve(hit.res);
  if (BARS_INFLIGHT.has(key)) return BARS_INFLIGHT.get(key);
  if (typeof (ctx && ctx.candles) !== 'function') return Promise.resolve(null);
  const p = Promise.resolve(ctx.candles(sym, { range, interval: '1d', priority: 0, maxWait: 240000 }))
    .then((res) => { BARS.set(key, { at: Date.now(), res: res || null }); return res || null; })
    .catch(() => null)
    .finally(() => BARS_INFLIGHT.delete(key));
  BARS_INFLIGHT.set(key, p);
  return p;
}

// At most two requests in flight: free tiers are counted per minute.
async function fetchAllBars(ctx, syms, range, onProgress) {
  const out = {};
  let i = 0, done = 0;
  const worker = async () => {
    while (i < syms.length) {
      const s = syms[i++];
      out[s] = await fetchBars(ctx, s, range);
      done++;
      if (onProgress) safe(() => onProgress(done, syms.length));
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

function periodStart(id, today) {
  const d = new Date(today + 'T00:00:00Z');
  if (id === '1M') d.setUTCMonth(d.getUTCMonth() - 1);
  else if (id === '3M') d.setUTCMonth(d.getUTCMonth() - 3);
  else if (id === 'YTD') return today.slice(0, 4) + '-01-01';
  else if (id === '1Y') d.setUTCFullYear(d.getUTCFullYear() - 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

function createPerformance(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = {
    r: PERF_RANGES.some((x) => x[0] === saved.r) ? saved.r : '1Y',
    bench: typeof saved.bench === 'string' && /^[A-Z0-9.\-]{1,15}$/.test(saved.bench) ? saved.bench : 'SPY',
    rf: fin(Number(saved.rf)) ? Number(saved.rf) : 0,
  };
  const persist = () => safe(() => cur.onWidgetState({ r: st.r, bench: st.bench, rf: st.rf }));
  const root = el('div', 'wg-perf');
  const bar = el('div', 'wg-bar');
  const ranges = segControl(PERF_RANGES, st.r, (v) => { st.r = v; persist(); load(); });
  const benchIn = el('input', 'input sm wg-bench');
  benchIn.type = 'text'; benchIn.value = st.bench; benchIn.spellcheck = false;
  benchIn.title = i18nT('Benchmark symbol to compare against (an index fund such as SPY)');
  benchIn.setAttribute('aria-label', i18nT('Benchmark'));
  benchIn.addEventListener('change', () => {
    const s = benchIn.value.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15) || 'SPY';
    benchIn.value = s; st.bench = s; persist(); load();
  });
  const bl = el('label', 'wg-inline field-note');
  bl.append(el('span', null, i18nT('vs')), benchIn);
  const bh = help('portfolio', 'benchmark'); if (bh) bl.appendChild(bh);
  const rfIn = el('input', 'input sm wg-rf');
  rfIn.type = 'number'; rfIn.step = 'any'; rfIn.value = String(st.rf);
  rfIn.title = i18nT('Risk-free rate, % per year, used by Sharpe and Sortino (e.g. a T-bill or CETES yield)');
  rfIn.addEventListener('change', () => { st.rf = num(rfIn.value) || 0; persist(); lastPf = null; compute(); });
  const rfl = el('label', 'wg-inline field-note');
  rfl.append(el('span', null, i18nT('Risk-free %')), rfIn);
  const reload = el('button', 'cs-btn sm', '↻');
  reload.type = 'button'; reload.title = i18nT('Reload prices');
  reload.addEventListener('click', () => { for (const k of [...BARS.keys()]) if (k.endsWith('|' + rangeFor())) BARS.delete(k); load(); });
  bar.append(ranges.seg, bl, rfl, el('span', 'spacer'), reload);
  const chartHost = el('div', 'wg-cmp-chart wg-perf-chart amount-chart');
  const grid = el('div', 'kv-grid wg-perf-kv');
  const prog = el('p', 'field-note wg-prog', '');
  const note = el('p', 'field-note', '');
  root.append(bar, chartHost, prog, grid, note, eduNote('Past performance says nothing certain about the future. Educational, not advice.'));
  host.appendChild(root);
  const chart = createChart(chartHost, { readOnly: true, fitAll: true });
  chart.setType('line');
  chart.setVolume(false);
  const cells = {};
  const ROWS = [
    ['twr', 'Time-weighted return', 'twr', 'beginner'], ['bench', 'Benchmark return', 'benchmark', 'beginner'],
    ['ann', 'Annualized', 'twr', 'standard'], ['xirr', 'Money-weighted (XIRR, all time)', 'xirr', 'standard'],
    ['mdd', 'Max drawdown', 'maxDrawdown', 'beginner'], ['vol', 'Volatility (annual)', 'volatility', 'standard'],
    ['sharpe', 'Sharpe ratio', 'sharpe', 'standard'], ['sortino', 'Sortino ratio', 'sortino', 'standard'],
    ['beta', 'Beta', 'beta', 'standard'], ['corr', 'Correlation', 'correlation', 'pro'], ['alpha', 'Alpha (annual)', 'alpha', 'pro'],
  ];
  for (const [k, label, learn, lv] of ROWS) {
    const kk = el('div', 'kv-k', i18nT(label));
    const h = help('portfolio', learn); if (h) kk.appendChild(h);
    const vv = el('div', 'kv-v num', DASH);
    cells[k] = { kk, vv, lv };
    grid.append(kk, vv);
  }
  let token = 0, data = null, lastSig = '', lastPf = null, lastLv = '';

  function rangeFor() {
    if (st.r !== 'ALL') return '1Y';
    const first = ledgerOf(cur).map((t) => t && t.date).filter((d) => d && d !== '1970-01-01').sort()[0];
    if (!first) return '1Y';
    const days = (Date.now() - Date.parse(first + 'T00:00:00Z')) / 86400000;
    return days > 720 ? '5Y' : days > 360 ? '2Y' : '1Y';
  }

  async function load() {
    const my = ++token;
    ranges.set(st.r);
    const ledger = ledgerOf(cur);
    const syms = ledgerSymbols(ledger);
    if (!syms.length) { data = null; chart.setData({ bars: [] }); chart.setState('empty', i18nT('Record holdings in Transactions to see performance.')); setText(prog, ''); compute(); return; }
    if (typeof cur.candles !== 'function') { chart.setState('empty', i18nT('Performance is computed in the main window.')); return; }
    const range = rangeFor();
    chart.setState('loading');
    const all = [...new Set([...syms, st.bench])];
    setText(prog, i18nT('Loading daily prices') + ' 0/' + all.length + '…');
    const res = await fetchAllBars(cur, all, range, (d, n) => { if (my === token) setText(prog, i18nT('Loading daily prices') + ' ' + d + '/' + n + '…'); });
    if (my !== token) return;
    setText(prog, '');
    data = { res, range, syms };
    lastSig = ''; lastPf = null;
    compute();
  }

  function compute() {
    if (!data) { for (const c of Object.values(cells)) setText(c.vv, DASH); setText(note, ''); return; }
    const pf = pfOf(cur, '');
    if (!pf) return;
    // The widget is handed a fresh ctx every second; the history only changes
    // when the valued portfolio (a new poll, an edit) or the level does.
    if (pf === lastPf && levelOf(cur) === lastLv) return;
    lastPf = pf; lastLv = levelOf(cur);
    const base = pf.baseCurrency;
    const barsBy = {};
    let demo = false;
    const missing = [];
    for (const s of data.syms) {
      const r = data.res[s];
      if (r && Array.isArray(r.bars) && r.bars.length) { barsBy[s] = r.bars; if (r.isDemo) demo = true; } else missing.push(s);
    }
    const hist = safe(() => portfolioHistory(pf.ledger, barsBy, pf.fx, { baseCurrency: base, method: pf.method }), []);
    const today = localToday();
    const from = periodStart(st.r, today);
    const rowsP = hist.filter((h) => (!from || h.date >= from) && h.value > 0);
    // The benchmark is measured over exactly the days the portfolio is, so the
    // two returns side by side cover the same window.
    const start = rowsP.length ? rowsP[0].date : from;
    const benchRes = data.res[st.bench];
    const benchBars = benchRes && Array.isArray(benchRes.bars) ? benchRes.bars.filter((b) => fin(b.c) && (!start || new Date(b.t).toISOString().slice(0, 10) >= start)) : [];
    if (benchRes && benchRes.isDemo) demo = true;
    if (rowsP.length < 2) {
      chart.setData({ bars: [] });
      chart.setState('empty', i18nT('Not enough price history for this period yet.'));
      for (const c of Object.values(cells)) setText(c.vv, DASH);
      setText(note, missing.length ? i18nT('No daily prices for') + ' ' + missing.join(', ') + '.' : '');
      return;
    }
    const tw = twrSeries(rowsP.map((h) => ({ date: h.date, value: h.value })), rowsP.map((h) => ({ date: h.date, amount: h.flow })));
    const idx = tw.map((p, i) => ({ t: rowsP[i].t, c: 100 * (1 + p.cum) }));
    const bars = idx.map((p) => ({ t: p.t, o: p.c, h: p.c, l: p.c, c: p.c, v: null }));
    const s = bars.length + ':' + (bars.length ? bars[bars.length - 1].c.toFixed(4) : '') + ':' + st.bench + ':' + benchBars.length;
    if (s !== lastSig) {
      lastSig = s;
      chart.setData({ bars, symbol: i18nT('Portfolio'), interval: '1d', isDemo: demo, source: 'TWR' });
      chart.setCompare(benchBars.length ? [{ symbol: st.bench, bars: benchBars }] : []);
      chart.setPercent(true);
    }
    const totalTwr = tw.length ? tw[tw.length - 1].cum : null;
    const days = (rowsP[rowsP.length - 1].t - rowsP[0].t) / 86400000;
    const benchRet = benchBars.length > 1 ? benchBars[benchBars.length - 1].c / benchBars[0].c - 1 : null;
    // Daily returns of the TWR index, aligned with the benchmark by date.
    const bMap = new Map(benchBars.map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c]));
    const pr = [], br = [];
    for (let i = 1; i < idx.length; i++) {
      const a = idx[i - 1].c, b = idx[i].c;
      if (!(a > 0)) continue;
      const r = b / a - 1;
      pr.push(r);
      const d0 = rowsP[i - 1].date, d1 = rowsP[i].date;
      const x = bMap.get(d0), y = bMap.get(d1);
      br.push(fin(x) && fin(y) && x > 0 ? y / x - 1 : null);
    }
    const risk = riskMetrics(pr, br, { periodsPerYear: 252, rf: (st.rf || 0) / 100 });
    const mdd = maxDrawdown(idx.map((p) => p.c));
    const flows = safe(() => investorFlows(pf.ledger, { baseCurrency: base, fx: pf.fx, terminalValue: pf.totals.netWorth }), null);
    const irr = flows ? safe(() => xirr(flows.flows), null) : null;
    const enough = pr.length >= 30;
    const pctTxt = (v) => (fin(v) ? fmtPct(v * 100) : DASH);
    const ratio = (v) => (fin(v) && enough ? fmtNum(v, 2) : DASH);
    const vals = {
      twr: pctTxt(totalTwr), bench: benchBars.length > 1 ? pctTxt(benchRet) + ' (' + st.bench + ')' : DASH,
      ann: pctTxt(annualize(totalTwr, days)), xirr: pctTxt(irr),
      mdd: mdd ? pctTxt(mdd.maxDrawdown) : DASH, vol: enough && fin(risk.volatility) ? fmtNum(risk.volatility * 100, 1) + '%' : DASH,
      sharpe: ratio(risk.sharpe), sortino: ratio(risk.sortino), beta: ratio(risk.beta), corr: ratio(risk.correlation),
      alpha: enough && fin(risk.alpha) ? pctTxt(risk.alpha) : DASH,
    };
    const lv = levelOf(cur);
    for (const [k, c] of Object.entries(cells)) {
      const show = levelAllows(lv, c.lv);
      setHidden(c.kk, !show); setHidden(c.vv, !show);
      setText(c.vv, vals[k]);
      setCls(c.vv, 'kv-v num ' + (['twr', 'bench', 'ann', 'xirr', 'alpha'].includes(k) ? signCls(k === 'twr' ? totalTwr : k === 'bench' ? benchRet : null) : ''));
    }
    const parts = [];
    parts.push(i18nT('Time-weighted return removes the effect of money you added or withdrew; money-weighted (XIRR) includes it.'));
    if (!enough) parts.push(i18nT('Risk ratios need at least 30 daily returns.'));
    if (ledgerOf(cur).some((t) => t && t.date === '1970-01-01')) parts.push(i18nT('Holdings with no purchase date are treated as held since the start of the chart.'));
    if (missing.length) parts.push(i18nT('No daily prices for') + ' ' + missing.join(', ') + ' — ' + i18nT('their last trade price is used.'));
    if (rowsP.some((h) => h.partial)) parts.push(i18nT('Some days are missing an exchange rate or price.'));
    parts.push(i18nT('Converted at today’s exchange rate. Benchmark is price only (no dividends).'));
    if (demo) parts.push(i18nT('Demo data.'));
    setText(note, parts.join(' '));
  }

  function update(next) {
    const prevSig = next && cur ? safe(() => ledgerSymbols(ledgerOf(cur)).join(','), '') : null;
    if (next) cur = next;
    applyPrivacy(host, cur);
    // Holdings changed underneath: the symbol set to price is different.
    const nowSig = safe(() => ledgerSymbols(ledgerOf(cur)).join(','), '');
    if (prevSig != null && prevSig !== nowSig) { load(); return; }
    if (data) compute();
  }
  update(cur);
  load();
  return { kind: 'performance', update, setSymbol() {}, destroy() { token++; safe(() => chart.destroy()); host.textContent = ''; } };
}

/* =============================================================================
   INCOME — dividends received, forward estimate, yield on cost, ex-dates
   ============================================================================= */
const EV_TTL = 6 * 3600 * 1000;
const EVENTS = new Map();   // sym -> {at, ev}
const EV_INFLIGHT = new Map();
function fetchEvents(ctx, sym) {
  const hit = EVENTS.get(sym);
  if (hit && Date.now() - hit.at < EV_TTL) return Promise.resolve(hit.ev);
  if (EV_INFLIGHT.has(sym)) return EV_INFLIGHT.get(sym);
  if (typeof (ctx && ctx.events) !== 'function') return Promise.resolve(null);
  const p = Promise.resolve(ctx.events(sym)).then((ev) => { EVENTS.set(sym, { at: Date.now(), ev: ev || null }); return ev || null; })
    .catch(() => null).finally(() => EV_INFLIGHT.delete(sym));
  EV_INFLIGHT.set(sym, p);
  return p;
}

function createIncome(host, ctx) {
  let cur = ctx || {};
  const root = el('div', 'wg-income');
  const stats = el('div', 'stat-row');
  const tiles = { ttm: tile('Last 12 months', 'trailing12m'), fwd: tile('Next 12 months (est.)', 'forward12m'), yoc: tile('Yield on cost', 'yieldOnCost') };
  stats.append(tiles.ttm.root, tiles.fwd.root, tiles.yoc.root);
  const months = el('div', 'wg-inc-months');
  const tWrap = el('div', 'table-wrap');
  const table = el('table', 'data wg-inc-table');
  const thead = el('thead');
  const htr = el('tr');
  for (const [l, learn, isNum] of [['Symbol', null, false], ['Per share (12m)', 'dividends', true], ['Yearly income', 'forward12m', true],
    ['Yield on cost', 'yieldOnCost', true], ['Current yield', null, true], ['Next ex-date', 'exDate', true]]) {
    const th = el('th', isNum ? 'num' : '', i18nT(l)); th.scope = 'col';
    const h = learn ? (learn === 'exDate' ? help('fundamentals', 'exDate') : help('portfolio', learn)) : null;
    if (h) th.appendChild(h);
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  tWrap.appendChild(table);
  const upHead = el('div', 'wg-sec rail-lbl', i18nT('Upcoming dividend dates'));
  const upList = el('div', 'wg-inc-up');
  const note = el('p', 'field-note', '');
  root.append(stats, months, tWrap, upHead, upList, note, eduNote('Forward income is an estimate from the last 12 months of payments; companies can cut or change dividends.'));
  host.appendChild(root);
  const unwire = wirePicks(root, () => cur);
  let sig = '', loading = false;

  function ensureEvents(syms) {
    if (loading || typeof cur.events !== 'function') return;
    const need = syms.filter((s) => { const h = EVENTS.get(s); return !h || Date.now() - h.at > EV_TTL; });
    if (!need.length) return;
    loading = true;
    let i = 0;
    const worker = async () => { while (i < need.length) { await fetchEvents(cur, need[i++]); } };
    Promise.all([worker(), worker()]).finally(() => { loading = false; sig = ''; update(); });
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const pf = pfOf(cur, '');
    if (!pf || pf.empty) {
      for (const t of Object.values(tiles)) setTile(t, DASH);
      tbody.textContent = ''; months.textContent = ''; upList.textContent = '';
      setText(note, i18nT('Record holdings and dividends in Transactions to track income.'));
      return;
    }
    const base = pf.baseCurrency;
    const held = pf.positions.filter((p) => p.qty > 0).map((p) => p.symbol);
    ensureEvents([...new Set(held)]);
    const evFor = (s) => { const h = EVENTS.get(s); return h ? h.ev : null; };
    const inc = safe(() => dividendIncome(pf.ledger, pf.positions, evFor, { fx: pf.fx, baseCurrency: base }), null);
    if (!inc) return;
    setTile(tiles.ttm, fmtMoney(inc.trailing12m, base));
    setTile(tiles.fwd, fmtMoney(inc.forward12m, base));
    setTile(tiles.yoc, fin(inc.yieldOnCost) ? fmtNum(inc.yieldOnCost, 2) + '%' : DASH);

    const today = localToday();
    const upcoming = [];
    for (const s of new Set(held)) {
      const ev = evFor(s);
      for (const d of (ev && ev.dividends) || []) if (d && d.exDate && d.exDate >= today) upcoming.push({ sym: s, ...d });
    }
    upcoming.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    const nextEx = new Map();
    for (const u of upcoming) if (!nextEx.has(u.sym)) nextEx.set(u.sym, u.exDate);

    // Monthly received (base currency), last 12 calendar months.
    const buckets = [];
    const now = new Date();
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      buckets.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: d.toLocaleString(uiLocale(), { month: 'short' }), v: 0 });
    }
    const bIdx = new Map(buckets.map((b, i) => [b.key, i]));
    for (const t of pf.ledger) {
      if (!t || t.type !== 'dividend' || !fin(Number(t.amount))) continue;
      const i = bIdx.get(String(t.date).slice(0, 7));
      if (i == null) continue;
      const r = safe(() => pf.fx(t.currency || base, base), null);
      if (fin(r)) buckets[i].v += (Number(t.amount) - (Number(t.fee) || 0)) * r;
    }
    const s = inc.rows.map((r) => r.symbol + r.dps + r.forward).join('|') + '#' + buckets.map((b) => b.v.toFixed(2)).join(',') + '#' + upcoming.length + '#' + base;
    if (s !== sig) {
      sig = s;
      months.textContent = '';
      const max = Math.max(...buckets.map((b) => b.v), 0) || 1;
      for (const b of buckets) {
        const col = el('div', 'wg-inc-m');
        col.title = b.label + ' · ' + fmtMoney(b.v, base);
        const barEl = el('div', 'wg-inc-bar');
        barEl.style.height = Math.max(b.v > 0 ? 4 : 0, (b.v / max) * 100).toFixed(1) + '%';
        col.append(el('div', 'wg-inc-track'), el('div', 'wg-inc-lab', b.label));
        col.firstChild.appendChild(barEl);
        months.appendChild(col);
      }
      tbody.textContent = '';
      for (const r of inc.rows) {
        const tr = el('tr');
        const td = el('td', 'sym'); td.appendChild(symBtn(r.symbol, 'wg-pick-sym'));
        tr.appendChild(td);
        tr.appendChild(el('td', 'num', fmtNum(r.dps, 4) + (r.source === 'ledger' ? ' *' : '')));
        tr.appendChild(el('td', 'num amount', fmtMoney(r.forwardBase, base)));
        tr.appendChild(el('td', 'num', fin(r.yieldOnCost) ? fmtNum(r.yieldOnCost, 2) + '%' : DASH));
        tr.appendChild(el('td', 'num', fin(r.currentYield) ? fmtNum(r.currentYield, 2) + '%' : DASH));
        tr.appendChild(el('td', 'num', nextEx.get(r.symbol) || DASH));
        tbody.appendChild(tr);
      }
      if (!inc.rows.length) {
        const tr = el('tr'); const td = el('td', 'empty-cell', i18nT('No dividend history for your holdings yet.'));
        td.colSpan = 6; tr.appendChild(td); tbody.appendChild(tr);
      }
      upList.textContent = '';
      for (const u of upcoming.slice(0, 8)) {
        const row = el('div', 'wg-inc-ev');
        row.append(el('span', 'num', u.exDate), symBtn(u.sym, 'wg-pick-sym'),
          el('span', 'field-note', fin(Number(u.amount)) ? fmtNum(Number(u.amount), 4) + ' ' + (u.currency || '') + ' ' + i18nT('per share') : ''),
          el('span', 'field-note', u.payDate ? i18nT('paid') + ' ' + u.payDate : ''));
        upList.appendChild(row);
      }
      if (!upcoming.length) upList.appendChild(el('p', 'field-note', typeof cur.events === 'function'
        ? (loading ? i18nT('Loading…') : i18nT('No upcoming ex-dividend dates from your data provider.'))
        : i18nT('Dividend dates load in the main window.')));
    }
    const parts = [i18nT('Income in') + ' ' + base + '.'];
    if (inc.rows.some((r) => r.source === 'ledger')) parts.push('* ' + i18nT('from your own recorded dividends; the provider had no history.'));
    if (inc.currencyMissing.length) parts.push(i18nT('No exchange rate yet for') + ' ' + inc.currencyMissing.join(', ') + '.');
    setText(note, parts.join(' '));
  }
  update(cur);
  return { kind: 'income', update, setSymbol() {}, destroy() { unwire(); host.textContent = ''; } };
}

/* =============================================================================
   CALCULATOR — position size, risk/reward, break-even, % change & compounding
   ============================================================================= */
const CALC_TABS = [['size', 'Position size'], ['rr', 'Risk / reward'], ['be', 'Break-even'], ['pct', '% & growth']];

function createCalculator(host, ctx) {
  let cur = ctx || {};
  let pinned = null;
  const saved = cur.widgetState || {};
  const st = { tab: CALC_TABS.some((t) => t[0] === saved.tab) ? saved.tab : 'size', v: saved.v && typeof saved.v === 'object' ? { ...saved.v } : {} };
  let persistT = 0;
  const persist = () => { clearTimeout(persistT); persistT = setTimeout(() => safe(() => cur.onWidgetState({ tab: st.tab, v: st.v })), 400); };

  const root = el('div', 'wg-calc');
  const head = el('div', 'wg-bar');
  const symEl = symBtn('', 'wg-sym');
  const lastEl = el('span', 'field-note amount', '');
  const tabs = segControl(CALC_TABS, st.tab, (t) => { st.tab = t; persist(); show(); });
  head.append(symEl, lastEl, el('span', 'spacer'), tabs.seg);
  const panes = {};
  for (const [id] of CALC_TABS) { panes[id] = el('div', 'wg-calc-pane'); }
  const out = el('div', 'wg-calc-out');
  const warn = el('p', 'field-note warn-note', ''); warn.hidden = true;
  const acts = el('div', 'wg-calc-acts');
  root.append(head, ...Object.values(panes), out, warn, acts,
    eduNote('Calculator — educational arithmetic on your own numbers, not a recommendation. It places no orders.'));
  host.appendChild(root);
  const unwire = wirePicks(head, () => cur);
  const inputs = {};

  function field(pane, key, label, { def = '', step = 'any', learn = null, useLast = false, unit = '' } = {}) {
    const f = el('label', 'field wg-calc-f');
    const lab = el('span', null, i18nT(label));
    if (learn) { const h = help('portfolio', learn); if (h) lab.appendChild(h); }
    const row = el('div', 'wg-inline');
    const inp = el('input', 'input sm');
    inp.type = 'number'; inp.step = step; inp.inputMode = 'decimal';
    inp.value = st.v[key] != null ? st.v[key] : def;
    inp.addEventListener('input', () => { st.v[key] = inp.value; persist(); calc(); });
    row.appendChild(inp);
    if (unit) row.appendChild(el('span', 'field-note', unit));
    if (useLast) {
      const b = el('button', 'cs-btn sm', i18nT('Last'));
      b.type = 'button';
      b.title = i18nT('Use the linked symbol’s last price');
      b.addEventListener('click', () => { const p = lastPrice(); if (fin(p)) { inp.value = String(+p.toPrecision(8)); st.v[key] = inp.value; persist(); calc(); } });
      row.appendChild(b);
    }
    f.append(lab, row);
    pane.appendChild(f);
    inputs[key] = inp;
    return inp;
  }
  const val = (k) => num(inputs[k] && inputs[k].value);

  // Position size
  field(panes.size, 'equity', 'Account size', { learn: 'netWorth' });
  field(panes.size, 'riskPct', 'Risk per trade', { def: '1', unit: '%', learn: 'positionSize' });
  field(panes.size, 'entry', 'Entry price', { useLast: true });
  field(panes.size, 'stop', 'Stop price', { learn: 'stop' });
  field(panes.size, 'fee', 'Fee per trade', { def: '0' });
  field(panes.size, 'step', 'Lot step', { def: '1' });
  field(panes.size, 'maxPos', 'Max position', { def: '', unit: '%' });
  const fillEq = el('button', 'cs-btn sm', i18nT('Use portfolio value'));
  fillEq.type = 'button';
  fillEq.addEventListener('click', () => { const pf = pfOf(cur, ''); const v = pf && pf.totals && pf.totals.netWorth; if (fin(v) && v > 0) { inputs.equity.value = v.toFixed(2); st.v.equity = inputs.equity.value; persist(); calc(); } });
  panes.size.appendChild(fillEq);
  // Risk / reward
  field(panes.rr, 'rrEntry', 'Entry price', { useLast: true });
  field(panes.rr, 'rrStop', 'Stop price', { learn: 'stop' });
  field(panes.rr, 'rrTarget', 'Target price', { learn: 'riskReward' });
  field(panes.rr, 'rrQty', 'Quantity (optional)');
  // Break-even
  field(panes.be, 'beQty', 'Quantity');
  field(panes.be, 'beAvg', 'Average cost', { learn: 'avgCost' });
  field(panes.be, 'beFees', 'Fees already paid', { def: '0' });
  field(panes.be, 'beSellFee', 'Sell fee (flat)', { def: '0' });
  field(panes.be, 'beSellPct', 'Sell fee (%)', { def: '0', unit: '%' });
  const fillPos = el('button', 'cs-btn sm', i18nT('Use my position'));
  fillPos.type = 'button';
  fillPos.addEventListener('click', () => {
    const sym = subjectOf(cur, pinned); const pf = pfOf(cur, '');
    const p = pf && pf.positions.find((x) => x.symbol === sym);
    if (!p) return;
    inputs.beQty.value = String(p.qty); inputs.beAvg.value = String(+p.avgCost.toPrecision(8));
    st.v.beQty = inputs.beQty.value; st.v.beAvg = inputs.beAvg.value; persist(); calc();
  });
  panes.be.appendChild(fillPos);
  // % and growth
  field(panes.pct, 'pFrom', 'From price', { useLast: true });
  field(panes.pct, 'pTo', 'To price');
  field(panes.pct, 'pLoss', 'A loss of', { unit: '%' });
  field(panes.pct, 'cStart', 'Starting amount');
  field(panes.pct, 'cRate', 'Yearly return', { unit: '%' });
  field(panes.pct, 'cYears', 'Years', { def: '10' });
  field(panes.pct, 'cAdd', 'Added each year', { def: '0' });

  function lastPrice() { const s = subjectOf(cur, pinned); const q = s ? quoteOf(cur, s) : null; return q && fin(q.price) ? q.price : null; }

  function outRows(list) {
    out.textContent = '';
    const g = el('div', 'kv-grid wg-calc-kv');
    for (const [k, v, cls, learn] of list) {
      const kk = el('div', 'kv-k', i18nT(k));
      if (learn) { const h = help('portfolio', learn); if (h) kk.appendChild(h); }
      g.append(kk, el('div', 'kv-v num ' + (cls || ''), v));
    }
    out.appendChild(g);
  }
  function setWarn(list) { setHidden(warn, !list.length); setText(warn, list.map((w) => i18nT(w)).join(' ')); }
  const n4 = (v) => (fin(v) ? fmtNum(v, Math.abs(v) >= 100 ? 2 : 4) : DASH);

  function calc() {
    acts.textContent = '';
    const sym = subjectOf(cur, pinned);
    if (st.tab === 'size') {
      const r = positionSize({ equity: val('equity'), riskPct: val('riskPct'), entry: val('entry'), stop: val('stop'), fee: val('fee') || 0, step: val('step') || 1, maxPositionPct: val('maxPos') });
      if (!r) { outRows([['Quantity', DASH]]); setWarn([val('entry') != null && val('stop') === val('entry') ? 'Stop must differ from entry.' : 'Enter account size, risk %, entry and stop.']); return; }
      outRows([
        ['Quantity', fmtNum(r.qty, r.qty % 1 ? 6 : 0), 'wg-calc-big', 'positionSize'],
        ['Direction', i18nT(r.direction === 'long' ? 'Long (stop below entry)' : 'Short (stop above entry)')],
        ['Risk per unit', n4(r.riskPerUnit)],
        ['Money at risk', fmtNum(r.actualRisk, 2) + ' / ' + fmtNum(r.riskBudget, 2), 'amount'],
        ['Position value', fmtNum(r.positionValue, 2), 'amount'],
        ['Share of account', fin(r.pctOfEquity) ? fmtNum(r.pctOfEquity, 1) + '%' : DASH],
      ]);
      setWarn(r.warnings);
    } else if (st.tab === 'rr') {
      const r = riskReward({ entry: val('rrEntry'), stop: val('rrStop'), target: val('rrTarget'), qty: val('rrQty') });
      if (!r) { outRows([['Reward : risk', DASH]]); setWarn(['Enter entry, stop and target.']); }
      else {
        outRows([
          ['Reward : risk', r.valid ? fmtNum(r.ratio, 2) + ' : 1' : DASH, 'wg-calc-big', 'rMultiple'],
          ['Break-even win rate', fin(r.breakevenWinRate) ? fmtNum(r.breakevenWinRate, 1) + '%' : DASH, '', 'riskReward'],
          ['Risk', n4(r.risk) + ' (' + fmtNum(r.riskPct, 2) + '%)', 'neg'],
          ['Reward', n4(r.reward) + ' (' + fmtNum(r.rewardPct, 2) + '%)', r.valid ? 'pos' : 'neg'],
          ['Money at risk', fin(r.riskAmount) ? fmtNum(r.riskAmount, 2) : DASH, 'amount'],
          ['Money at target', fin(r.rewardAmount) ? fmtNum(r.rewardAmount, 2) : DASH, 'amount'],
        ]);
        setWarn(r.valid ? [] : ['The target is on the wrong side of the entry for this stop.']);
      }
      // Alerts, not orders: one click arms a price rule at each level.
      if (sym && typeof cur.onRequestAlert === 'function') {
        for (const [k, label] of [['rrStop', 'Alert at stop'], ['rrTarget', 'Alert at target']]) {
          const p = val(k);
          if (!fin(p)) continue;
          const b = el('button', 'cs-btn sm', '🔔 ' + i18nT(label));
          b.type = 'button';
          b.addEventListener('click', () => safe(() => cur.onRequestAlert(sym, p)));
          acts.appendChild(b);
        }
      }
    } else if (st.tab === 'be') {
      const be = breakEven({ qty: val('beQty'), avgCost: val('beAvg'), feesPaid: val('beFees') || 0, sellFee: val('beSellFee') || 0, sellFeePct: val('beSellPct') || 0 });
      const last = lastPrice();
      outRows([
        ['Break-even price', n4(be), 'wg-calc-big', 'breakEven'],
        ['Last price', n4(last)],
        ['Distance', fin(be) && fin(last) && last ? fmtPct((be / last - 1) * 100) : DASH],
      ]);
      setWarn(be == null ? ['Enter quantity and average cost.'] : []);
    } else {
      const from = val('pFrom'), to = val('pTo'), loss = val('pLoss');
      const ch = fin(from) && fin(to) && from ? (to / from - 1) * 100 : null;
      const rec = fin(loss) ? recoveryGain(loss) : null;
      const P = val('cStart'), rate = val('cRate'), yrs = val('cYears'), add = val('cAdd') || 0;
      let fv = null;
      if (fin(P) && fin(rate) && fin(yrs) && yrs >= 0 && yrs <= 100) {
        fv = P; for (let i = 0; i < Math.floor(yrs); i++) fv = fv * (1 + rate / 100) + add;
      }
      const contrib = fin(P) && fin(yrs) ? P + add * Math.floor(yrs) : null;
      outRows([
        ['Change', fin(ch) ? fmtPct(ch) : DASH, signCls(ch)],
        ['Gain needed to recover', fin(rec) ? '+' + fmtNum(rec, 2) + '%' : DASH, '', 'drawdown'],
        ['Value after growth', fin(fv) ? fmtNum(fv, 2) : DASH, 'wg-calc-big amount'],
        ['Of which you added', fin(contrib) ? fmtNum(contrib, 2) : DASH, 'amount'],
      ]);
      setWarn([]);
    }
  }

  function show() {
    tabs.set(st.tab);
    for (const [id, p] of Object.entries(panes)) setHidden(p, id !== st.tab);
    calc();
  }

  function update(next) {
    if (next) cur = next;
    applyPrivacy(host, cur);
    const sym = subjectOf(cur, pinned);
    setText(symEl, sym || i18nT('No symbol'));
    setAttr(symEl, 'data-sym', sym || '');
    const q = sym ? quoteOf(cur, sym) : null;
    setText(lastEl, q && fin(q.price) ? i18nT('Last') + ' ' + fmtPrice(q.price, q.currency, priceOpts(cur, sym)) : '');
  }
  update(cur);
  show();
  return {
    kind: 'calculator', update,
    setSymbol(sym) { pinned = typeof sym === 'string' && sym ? sym : null; update(); calc(); },
    destroy() { clearTimeout(persistT); unwire(); host.textContent = ''; },
  };
}

/* ---- registry entries -------------------------------------------------------- */
export const PORTFOLIO_WIDGETS = [
  { id: 'portfolio', label: 'Portfolio', desc: 'Positions, value, today’s move, gains, dividends and cash — from your transactions.', needsSymbol: false, minW: 4, minH: 3, defaultW: 8, defaultH: 6, create: createPortfolio },
  { id: 'allocation', label: 'Allocation', desc: 'How your money is spread by asset class, holding, sector, currency or account, with optional targets.', needsSymbol: false, minW: 3, minH: 4, defaultW: 4, defaultH: 6, create: createAllocation },
  { id: 'performance', label: 'Performance', desc: 'Portfolio value over time against a benchmark, with returns and risk measures.', needsSymbol: false, minW: 4, minH: 5, defaultW: 8, defaultH: 7, create: createPerformance },
  { id: 'income', label: 'Income', desc: 'Dividends received, an estimate of the next 12 months, yield on cost and upcoming ex-dates.', needsSymbol: false, minW: 3, minH: 4, defaultW: 4, defaultH: 6, create: createIncome },
  { id: 'calculator', label: 'Calculator', desc: 'Position size, risk/reward, break-even and growth arithmetic. Educational.', needsSymbol: true, minW: 3, minH: 4, defaultW: 4, defaultH: 6, create: createCalculator },
];
