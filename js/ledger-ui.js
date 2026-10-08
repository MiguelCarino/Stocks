/* ledger-ui.js — the Transactions dialog, the one-transaction editor and the
   broker CSV import wizard.

   The ledger is the portfolio's source of truth, so every write to it happens
   here (through store.js) and nowhere else: widgets only read. The editor is
   type-aware — a split asks for a ratio, a dividend for an amount, a sell is
   checked against what is held — and a beginner gets the short "add a holding"
   form with everything else one click away.

   The import is a preview first and a write second: a file is parsed in the
   page (csvimport.js), the detected broker format and the column mapping are
   shown, number and date locale can be overridden, rows already in the ledger
   are recognised as duplicates, and nothing is saved until the user presses
   Import. The file never leaves the browser. */

import { importCSV, parseCSV, mapRows, BROKER_PRESETS, dedupe, toCSV } from './csvimport.js';
import { TXN_TYPES } from './store.js';
import { csvCell } from './folio.js';
import { localToday } from './portfolio.js';
import { fmtNum, fmtPriceNum, priceKind } from './format.js';
import { marketForSymbol } from './session.js';

// A stock price in cents, an FX rate in pips: precision follows the symbol.
const priceTxt = (v, sym) => {
  let kind;
  try { kind = sym ? priceKind(marketForSymbol(sym)) : undefined; } catch { kind = undefined; }
  return fmtPriceNum(v, kind);
};

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fb = null) => { try { return fn(); } catch (e) { return fb; } };
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const DASH = '—';

const TYPE_LABEL = {
  buy: 'Buy', sell: 'Sell', dividend: 'Dividend', fee: 'Fee', split: 'Split', deposit: 'Deposit',
  withdraw: 'Withdrawal', interest: 'Interest', tax: 'Tax',
};
// Which inputs each type uses. Everything else is hidden, so a dividend form
// cannot be saved with a stray quantity in it.
const FIELDS = {
  buy: ['symbol', 'qty', 'price', 'fee'], sell: ['symbol', 'qty', 'price', 'fee', 'short'],
  dividend: ['symbol', 'amount', 'fee'], split: ['symbol', 'ratio'],
  fee: ['symbol', 'amount'], tax: ['symbol', 'amount'], interest: ['amount'],
  deposit: ['amount'], withdraw: ['amount'],
};
const HINT = {
  buy: 'Shares (or coins) you bought. The fee is added to what they cost you.',
  sell: 'Shares you sold. The gain is worked out against what those shares cost, using the cost method in Settings.',
  dividend: 'Cash a holding paid you. Enter the total received before tax; put any tax withheld in “More options”.',
  split: 'A stock split changes how many shares you hold, not what they are worth. 4 means every share became 4; 0.1 is a 1-for-10 reverse split.',
  fee: 'A charge not tied to a trade, such as an account or custody fee.',
  tax: 'Tax paid (positive) or refunded (negative), such as tax withheld on a dividend.',
  interest: 'Interest paid to you on cash.',
  deposit: 'Money you put into the account. Recording deposits turns on cash tracking and a more accurate money-weighted return.',
  withdraw: 'Money you took out of the account.',
};
const MAP_KEYS = [['date', 'Date'], ['type', 'Type / action'], ['symbol', 'Symbol'], ['qty', 'Quantity'], ['price', 'Price'],
  ['amount', 'Amount / total'], ['fee', 'Fee'], ['currency', 'Currency'], ['account', 'Account'], ['note', 'Note']];

/* deps: {store, openModal(id, after), toast(msg, kind), onChange(), quotes(), level(),
   portfolio(), profileFor(sym), downloadFile(name, mime, text), positionsCSV()} */
export function initLedgerUI(deps) {
  const { store } = deps;
  const filter = { sym: '', type: '', acct: '', from: '', to: '' };
  let editing = null;          // txn being edited, or null for a new one
  let afterSave = 'ledger';    // where the editor returns: 'ledger' | 'close'
  const imp = { text: '', name: '', parsed: null, preset: '', mapping: null, result: null, fresh: [], dups: [] };

  /* ---- ledger list ---------------------------------------------------------- */
  function open(opts = {}) {
    if (opts.add) return openTxn(null, { symbol: opts.symbol || '', type: opts.type || 'buy', back: opts.fromWidget ? 'close' : 'ledger' });
    if (opts.import) return openImport();
    deps.openModal('ledgerModal', render);
  }
  function isOpen() { return !$('ledgerModal').hidden; }

  function fillSelect(sel, items, current, allLabel) {
    const key = items.join('|') + '#' + current;
    if (sel.dataset.sig === key) return;
    sel.dataset.sig = key;
    sel.textContent = '';
    const o = el('option', null, i18nT(allLabel)); o.value = ''; sel.appendChild(o);
    for (const [v, l] of items.map((x) => (Array.isArray(x) ? x : [x, x]))) { const op = el('option', null, l); op.value = v; sel.appendChild(op); }
    sel.value = current;
  }

  function render() {
    const all = Array.isArray(store.ledger) ? store.ledger : [];
    const syms = [...new Set(all.map((t) => t.symbol).filter(Boolean))].sort();
    const accts = [...new Set(all.map((t) => t.account).filter(Boolean))].sort();
    fillSelect($('ledFSym'), syms, filter.sym, 'All symbols');
    fillSelect($('ledFType'), TXN_TYPES.map((t) => [t, i18nT(TYPE_LABEL[t])]), filter.type, 'All types');
    fillSelect($('ledFAcct'), accts, filter.acct, 'All accounts');
    $('ledFAcct').hidden = !accts.length;
    $('ledFFrom').value = filter.from; $('ledFTo').value = filter.to;

    const mig = all.filter((t) => t.date === '1970-01-01');
    const mn = $('ledMigNote');
    mn.hidden = !mig.length;
    if (mig.length) {
      mn.textContent = i18nT('Imported') + ' ' + mig.length + ' ' + i18nT(mig.length === 1 ? 'holding' : 'holdings') + ' '
        + i18nT('from the old format. They have no purchase date (shown as 1970-01-01) — edit each one to add the real date for accurate returns and holding periods.');
    }

    const rows = all.filter((t) => (!filter.sym || t.symbol === filter.sym) && (!filter.type || t.type === filter.type)
      && (!filter.acct || t.account === filter.acct) && (!filter.from || t.date >= filter.from) && (!filter.to || t.date <= filter.to))
      .slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    $('ledCount').textContent = rows.length + ' / ' + all.length + ' ' + i18nT('transactions');
    const body = $('ledBody');
    body.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'empty-cell', all.length ? i18nT('No transactions match these filters.') : i18nT('No transactions yet. Add one, or import a CSV from your broker.'));
      td.colSpan = 11; tr.appendChild(td); body.appendChild(tr);
    }
    const SHOW = 400;
    for (const t of rows.slice(0, SHOW)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'num', t.date === '1970-01-01' ? i18nT('unknown') : t.date));
      const ty = el('td', 'led-type');
      ty.appendChild(el('span', 'tag led-t-' + t.type, i18nT(TYPE_LABEL[t.type] || t.type)));
      if (t.short) ty.appendChild(el('span', 'tag', i18nT('short')));
      if (t.date === '1970-01-01' || t.migrated) ty.appendChild(el('span', 'tag approx', i18nT('migrated')));
      tr.appendChild(ty);
      tr.appendChild(el('td', 'sym', t.symbol || ''));
      tr.appendChild(el('td', 'num amount', fin(t.qty) ? String(+t.qty.toFixed(8)) : t.type === 'split' && fin(t.ratio) ? fmtNum(t.ratio, 4) + ':1' : ''));
      tr.appendChild(el('td', 'num amount', fin(t.price) ? priceTxt(t.price, t.symbol) : ''));
      tr.appendChild(el('td', 'num amount', fin(t.amount) ? fmtNum(t.amount, 2) : fin(t.qty) && fin(t.price) ? fmtNum(t.qty * t.price, 2) : ''));
      tr.appendChild(el('td', 'num amount', fin(t.fee) && t.fee ? fmtNum(t.fee, 2) : ''));
      tr.appendChild(el('td', '', t.currency || ''));
      tr.appendChild(el('td', '', t.account || ''));
      const note = el('td', 'led-note', t.note || '');
      note.title = t.note || '';
      tr.appendChild(note);
      const act = el('td', 'led-act');
      const eb = el('button', 'icon-mini', '✎'); eb.type = 'button';
      eb.title = i18nT('Edit'); eb.setAttribute('aria-label', i18nT('Edit transaction'));
      eb.addEventListener('click', () => openTxn(t));
      const db = el('button', 'icon-mini', '✕'); db.type = 'button';
      db.title = i18nT('Delete'); db.setAttribute('aria-label', i18nT('Delete transaction'));
      db.addEventListener('click', () => {
        if (!confirm(i18nT('Delete this transaction?') + '\n' + describe(t))) return;
        store.removeTxn(t.id); deps.onChange(); render();
      });
      act.append(eb, db);
      tr.appendChild(act);
      body.appendChild(tr);
    }
    if (rows.length > SHOW) {
      const tr = el('tr'); const td = el('td', 'field-note', (rows.length - SHOW) + ' ' + i18nT('older rows not shown — narrow the filters to see them.'));
      td.colSpan = 11; tr.appendChild(td); body.appendChild(tr);
    }

    // Problems the replay found (an oversell, a row it could not read).
    const pf = safe(() => deps.portfolio());
    const issues = $('ledIssues');
    const errs = (pf && pf.errors) || [];
    issues.hidden = !errs.length;
    issues.textContent = '';
    if (errs.length) {
      issues.appendChild(el('div', 'rail-lbl', i18nT('Needs attention')));
      for (const e of errs.slice(0, 12)) issues.appendChild(el('p', 'field-note warn-note', [e.date, e.symbol, i18nT(e.message)].filter(Boolean).join(' · ')));
    }
    renderRealized(pf);
  }

  function renderRealized(pf) {
    const body = $('ledRealBody');
    body.textContent = '';
    const ev = ((pf && pf.realizedEvents) || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    $('ledRealized').hidden = !ev.length;
    for (const e of ev.slice(0, 200)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'num', e.date));
      tr.appendChild(el('td', 'sym', e.symbol));
      tr.appendChild(el('td', 'num amount', fmtNum(e.qty, Number.isInteger(e.qty) ? 0 : 6)));
      tr.appendChild(el('td', 'num', e.openDate === '1970-01-01' ? i18nT('unknown') : e.openDate || DASH));
      tr.appendChild(el('td', 'num amount', fmtNum(e.basis, 2)));
      tr.appendChild(el('td', 'num amount', fmtNum(e.proceeds, 2)));
      tr.appendChild(el('td', 'num amount ' + (e.pl > 0 ? 'pos' : e.pl < 0 ? 'neg' : ''), (e.pl >= 0 ? '+' : '−') + fmtNum(Math.abs(e.pl), 2) + ' ' + (e.currency || '')));
      tr.appendChild(el('td', '', e.term === 'long' ? i18nT('Long (> 1 year)') : e.term === 'short' ? i18nT('Short (≤ 1 year)') : DASH));
      body.appendChild(tr);
    }
  }

  function realizedCSV() {
    const pf = safe(() => deps.portfolio());
    const rows = [['date_sold', 'symbol', 'account', 'side', 'qty', 'date_bought', 'cost_basis', 'proceeds', 'gain', 'currency', 'holding_days', 'term', 'gain_base']];
    for (const e of (pf && pf.realizedEvents) || []) {
      rows.push([e.date, e.symbol, e.account || '', e.side, e.qty, e.openDate || '', +e.basis.toFixed(2), +e.proceeds.toFixed(2), +e.pl.toFixed(2),
        e.currency || '', e.holdingDays ?? '', e.term || '', fin(e.plBase) ? +e.plBase.toFixed(2) : '']);
    }
    deps.downloadFile('carino-realized-' + localToday() + '.csv', 'text/csv', rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }

  function describe(t) {
    const parts = [t.date, i18nT(TYPE_LABEL[t.type] || t.type), t.symbol || ''];
    if (fin(t.qty)) parts.push(fmtNum(t.qty, 4));
    if (fin(t.price)) parts.push('@ ' + priceTxt(t.price, t.symbol));
    if (fin(t.amount)) parts.push(fmtNum(t.amount, 2) + ' ' + (t.currency || ''));
    return parts.filter(Boolean).join(' ');
  }

  /* ---- one transaction ------------------------------------------------------- */
  function openTxn(t, preset = {}) {
    editing = t || null;
    afterSave = preset.back || 'ledger';
    deps.openModal('txnModal', () => {
      const typeSel = $('txType');
      if (!typeSel.options.length) for (const ty of TXN_TYPES) { const o = el('option', null, i18nT(TYPE_LABEL[ty])); o.value = ty; o.dataset.i18nKey = TYPE_LABEL[ty]; typeSel.appendChild(o); }
      else for (const o of typeSel.options) o.textContent = i18nT(TYPE_LABEL[o.value]);
      const beginner = deps.level() === 'beginner';
      const title = t ? 'Edit transaction' : beginner && (preset.type || 'buy') === 'buy' ? 'Add a holding' : 'Add transaction';
      $('txnTitle').dataset.i18nKey = title;
      $('txnTitle').textContent = i18nT(title);
      typeSel.value = t ? t.type : preset.type || 'buy';
      $('txDate').value = t ? t.date : localToday();
      $('txSym').value = t ? t.symbol || '' : preset.symbol || '';
      $('txQty').value = t && fin(t.qty) ? String(t.qty) : '';
      $('txPrice').value = t && fin(t.price) ? String(t.price) : '';
      $('txAmount').value = t && fin(t.amount) ? String(t.amount) : '';
      $('txRatio').value = t && fin(t.ratio) ? String(t.ratio) : '';
      $('txFee').value = t && fin(t.fee) && t.fee ? String(t.fee) : '';
      $('txCcy').value = t && t.currency ? t.currency : '';
      $('txAcct').value = t && t.account ? t.account : '';
      $('txNote').value = t && t.note ? t.note : '';
      $('txShort').checked = !!(t && t.short);
      $('txMore').open = !beginner || !!(t && (t.fee || t.account || t.currency || t.note));
      $('txDelete').hidden = !t;
      $('txErr').hidden = true;
      const dl = $('txAcctList'); dl.textContent = '';
      for (const a of [...new Set(store.ledger.map((x) => x.account).filter(Boolean))]) { const o = el('option'); o.value = a; dl.appendChild(o); }
      syncTxnForm();
      setTimeout(() => safe(() => (t ? $('txQty') : $('txSym')).focus({ preventScroll: true })), 30);
    });
  }

  function syncTxnForm() {
    const type = $('txType').value;
    const used = new Set(FIELDS[type] || []);
    for (const f of document.querySelectorAll('#txnModal .tx-f')) f.hidden = !used.has(f.dataset.for);
    $('txHint').textContent = i18nT(HINT[type] || '');
    const lbl = (id, key) => { $(id).dataset.i18nKey = key; $(id).textContent = i18nT(key); };
    lbl('txQtyLbl', type === 'sell' ? 'Shares sold' : type === 'buy' ? 'Shares bought' : 'Quantity');
    lbl('txPriceLbl', type === 'sell' ? 'Sale price per share' : 'Price per share');
    lbl('txAmountLbl', type === 'dividend' ? 'Total received' : type === 'tax' ? 'Tax amount' : 'Amount');
    const feeLbl = document.querySelector('#txnModal [data-for="fee"] > span');
    if (feeLbl) { const k = type === 'dividend' ? 'Tax withheld' : 'Fee / commission'; feeLbl.dataset.i18nKey = k; feeLbl.textContent = i18nT(k); }
    const sym = normSym($('txSym').value);
    const q = sym ? (deps.quotes() || {})[sym] : null;
    const prof = sym ? safe(() => deps.profileFor(sym)) : null;
    const ccyGuess = (q && q.currency) || (prof && prof.currency) || (sym ? '' : store.settings.baseCurrency || 'USD');
    $('txCcy').placeholder = ccyGuess || i18nT('instrument’s own');
    preview();
  }

  function normSym(v) { return String(v || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, ''); }
  function n(id) { const v = $(id).value.trim().replace(',', '.'); if (v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : NaN; }

  function preview() {
    const type = $('txType').value;
    const qty = n('txQty'), price = n('txPrice'), fee = n('txFee') || 0;
    const sym = normSym($('txSym').value);
    const q = sym ? (deps.quotes() || {})[sym] : null;
    let txt = '';
    if ((type === 'buy' || type === 'sell') && fin(qty) && fin(price)) {
      const gross = qty * price;
      txt = (type === 'buy' ? i18nT('Total cost') + ': ' + fmtNum(gross + fee, 2) : i18nT('Proceeds after fee') + ': ' + fmtNum(gross - fee, 2))
        + ($('txCcy').value || $('txCcy').placeholder ? ' ' + ($('txCcy').value.toUpperCase() || $('txCcy').placeholder) : '');
      if (q && fin(q.price)) txt += ' · ' + i18nT('worth now') + ' ' + fmtNum(qty * q.price, 2);
    } else if (type === 'split' && fin(n('txRatio'))) {
      txt = i18nT('Each share becomes') + ' ' + fmtNum(n('txRatio'), 4) + ' ' + i18nT('shares; the total cost stays the same.');
    }
    $('txPreview').textContent = txt;
  }

  function heldNow(sym, account, excludeId) {
    const pf = safe(() => deps.portfolio(excludeId ? store.ledger.filter((t) => t.id !== excludeId) : null));
    let held = 0;
    for (const p of (pf && pf.positions) || []) if (p.symbol === sym && (p.account || '') === (account || '')) held += p.qty;
    return held;
  }

  function saveTxn() {
    const type = $('txType').value;
    const used = new Set(FIELDS[type] || []);
    const err = (m) => { $('txErr').hidden = false; $('txErr').textContent = i18nT(m); };
    const date = $('txDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('Enter a date.');
    const raw = { type, date };
    const sym = normSym($('txSym').value);
    if (used.has('symbol')) {
      if (!sym && ['buy', 'sell', 'dividend', 'split'].includes(type)) return err('Enter a symbol.');
      if (sym) raw.symbol = sym;
    }
    if (used.has('qty')) { const v = n('txQty'); if (!fin(v) || v <= 0) return err('Enter a quantity greater than zero.'); raw.qty = v; }
    if (used.has('price')) { const v = n('txPrice'); if (!fin(v) || v < 0) return err('Enter the price per share.'); raw.price = v; }
    if (used.has('amount')) { const v = n('txAmount'); if (!fin(v)) return err('Enter an amount.'); raw.amount = v; }
    if (used.has('ratio')) { const v = n('txRatio'); if (!fin(v) || v <= 0) return err('Enter the split ratio, e.g. 4 for a 4-for-1 split.'); raw.ratio = v; }
    if (used.has('fee')) { const v = n('txFee'); if (Number.isNaN(v)) return err('The fee is not a number.'); if (fin(v) && v) raw.fee = Math.abs(v); }
    const ccy = $('txCcy').value.trim().toUpperCase();
    if (ccy && !/^[A-Z]{3}$/.test(ccy)) return err('Currency is a three-letter code such as USD, EUR or MXN.');
    if (ccy) raw.currency = ccy;
    else if (!raw.symbol) raw.currency = store.settings.baseCurrency || 'USD';
    else {
      // Prefer the instrument's quote currency; null means "decide when valued".
      const q = (deps.quotes() || {})[raw.symbol];
      if (q && q.currency) raw.currency = q.currency;
    }
    const acct = $('txAcct').value.trim();
    if (acct) raw.account = acct;
    const note = $('txNote').value.trim();
    if (note) raw.note = note;
    if (type === 'sell' && $('txShort').checked) raw.short = true;
    if (editing && editing.migrated && date === '1970-01-01') raw.migrated = true;

    // A sell larger than the holding is almost always a typo or a missing buy.
    if (type === 'sell' && !raw.short) {
      const held = heldNow(raw.symbol, raw.account, editing && editing.id);
      if (raw.qty > held + 1e-9) {
        return err(held > 0
          ? i18nT('You hold only') + ' ' + String(+held.toFixed(8)) + ' ' + raw.symbol + (raw.account ? ' (' + raw.account + ')' : '') + '. ' + i18nT('Record the missing buy first, or tick “deliberate short sale” under More options.')
          : i18nT('No') + ' ' + raw.symbol + ' ' + i18nT('is held in this account. Record the buy first, or tick “deliberate short sale” under More options.'));
      }
    }

    let saved;
    if (editing) {
      // updateTxn merges; send explicit nulls for fields this type does not use.
      const patch = { ...raw };
      for (const k of ['symbol', 'qty', 'price', 'amount', 'ratio', 'fee', 'account', 'note', 'short', 'currency']) if (!(k in raw)) patch[k] = undefined;
      saved = store.updateTxn(editing.id, patch);
    } else saved = store.addTxn(raw);
    if (!saved) return err('This transaction could not be saved — check the fields.');
    if (raw.symbol && !(store.watchlist || []).includes(raw.symbol) && type === 'buy' && !editing) {
      // A new holding is something the user wants to see priced; watching it is
      // what gets it a quote and a row on the board.
      safe(() => store.addSymbol(raw.symbol));
    }
    deps.onChange();
    deps.toast(i18nT(editing ? 'Transaction updated.' : 'Transaction saved.') + ' ' + describe(saved));
    if (afterSave === 'close') deps.closeModal(); else open();
  }

  function deleteTxn() {
    if (!editing) return;
    if (!confirm(i18nT('Delete this transaction?') + '\n' + describe(editing))) return;
    store.removeTxn(editing.id);
    deps.onChange();
    open();
  }

  /* ---- CSV import ------------------------------------------------------------ */
  function openImport() {
    deps.openModal('importModal', () => {
      const sel = $('impPreset');
      if (!sel.options.length) {
        const auto = el('option', null, i18nT('Detect automatically')); auto.value = ''; sel.appendChild(auto);
        for (const p of BROKER_PRESETS) { const o = el('option', null, i18nT(p.label)); o.value = p.id; sel.appendChild(o); }
        const c = el('option', null, i18nT('Custom mapping')); c.value = 'custom'; sel.appendChild(c);
      }
      if (!imp.text) { $('impStep2').hidden = true; $('impGo').disabled = true; $('impFileName').textContent = ''; }
      if (!$('impCcy').value) $('impCcy').value = '';
      $('impCcy').placeholder = store.settings.baseCurrency || 'USD';
    });
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { deps.toast(i18nT('That file is larger than 8 MB — export a shorter date range.'), 'err'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      imp.text = String(rd.result || '');
      imp.name = file.name;
      imp.mapping = null;
      $('impPreset').value = '';
      $('impFileName').textContent = file.name + ' · ' + fmtNum(file.size / 1024, 0) + ' KB';
      runImport();
    };
    rd.onerror = () => deps.toast(i18nT('The file could not be read.'), 'err');
    rd.readAsText(file);
  }

  function presetColumns(presetId, headers) {
    const p = BROKER_PRESETS.find((x) => x.id === presetId);
    const lc = new Map(headers.map((h) => [String(h).toLowerCase().trim(), h]));
    const out = {};
    for (const [k] of MAP_KEYS) {
      const alts = (p && p.columns && p.columns[k]) || [k];
      const hit = alts.map((a) => lc.get(String(a).toLowerCase())).find(Boolean);
      out[k] = hit || '';
    }
    return out;
  }

  function runImport() {
    if (!imp.text) return;
    $('impStep2').hidden = false;
    const opts = {
      decimal: $('impDecimal').value || undefined,
      dateOrder: $('impDateOrder').value || undefined,
      currency: $('impCcy').value.trim().toUpperCase() || store.settings.baseCurrency || 'USD',
      account: $('impAcct').value.trim() || undefined,
    };
    const choice = $('impPreset').value;
    let res;
    try {
      if (choice === 'custom' || imp.mapping) {
        const parsed = imp.parsed || parseCSV(imp.text);
        imp.parsed = parsed;
        const cols = imp.mapping || presetColumns(parsed.preset || 'generic', parsed.headers);
        imp.mapping = cols;
        res = { headers: parsed.headers, ...mapRows(parsed.rows, { columns: cols, decimal: opts.decimal, dateOrder: opts.dateOrder, currency: opts.currency }, opts) };
      } else {
        imp.parsed = parseCSV(imp.text);
        res = importCSV(imp.text, { preset: choice || null, ...opts });
      }
    } catch (e) {
      res = { headers: [], txns: [], errors: [{ row: 0, message: String(e && e.message || e) }], skipped: [], warnings: [] };
    }
    imp.result = res;
    const { fresh, duplicates } = dedupe(store.ledger, res.txns || []);
    imp.fresh = fresh; imp.dups = duplicates;
    paintMapping(res.headers || (imp.parsed && imp.parsed.headers) || [], res.preset);
    paintPreview(res);
  }

  function paintMapping(headers, presetId) {
    const box = $('impMap');
    box.textContent = '';
    const cols = imp.mapping || presetColumns(presetId || 'generic', headers);
    for (const [k, label] of MAP_KEYS) {
      const f = el('label', 'field');
      f.appendChild(el('span', null, i18nT(label)));
      const sel = el('select', 'input sm');
      const none = el('option', null, '— ' + i18nT('none') + ' —'); none.value = ''; sel.appendChild(none);
      for (const h of headers) { const o = el('option', null, h); o.value = h; sel.appendChild(o); }
      sel.value = cols[k] || '';
      sel.addEventListener('change', () => {
        imp.mapping = { ...cols, ...(imp.mapping || {}), [k]: sel.value };
        $('impPreset').value = 'custom';
        runImport();
      });
      f.appendChild(sel);
      box.appendChild(f);
    }
  }

  function paintPreview(res) {
    const presetLbl = res.preset ? (BROKER_PRESETS.find((p) => p.id === res.preset) || { label: res.preset === 'custom' ? 'Custom mapping' : res.preset }).label : null;
    const sum = $('impSummary');
    sum.textContent = '';
    sum.appendChild(el('strong', null, presetLbl ? i18nT('Format') + ': ' + i18nT(presetLbl) : i18nT('Format not recognised — map the columns below.')));
    const bits = [
      [imp.fresh.length, 'new', 'ok'], [imp.dups.length, 'already in your ledger', ''],
      [(res.skipped || []).length, 'skipped', ''], [(res.errors || []).length, 'with errors', 'err'],
    ];
    for (const [nn, label, cls] of bits) sum.appendChild(el('span', 'tag imp-n ' + (nn ? cls : ''), nn + ' ' + i18nT(label)));
    if (res.locale && res.locale.decimal) sum.appendChild(el('span', 'field-note', i18nT('Numbers read as') + ' ' + (res.locale.decimal === ',' ? '1.234,56' : '1,234.56') + ' · ' + i18nT('dates as') + ' ' + (res.locale.dateOrder === 'DMY' ? i18nT('day/month') : i18nT('month/day'))));
    if (!presetLbl) $('impMapBox').open = true;

    const warn = $('impWarn');
    warn.textContent = '';
    for (const w of res.warnings || []) warn.appendChild(el('p', 'field-note warn-note', i18nT(w)));

    const body = $('impPrevBody');
    body.textContent = '';
    const dupSet = new Set(imp.dups);
    const list = [...imp.fresh, ...imp.dups].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const t of list.slice(0, 60)) {
      const tr = el('tr', dupSet.has(t) ? 'imp-dup' : '');
      tr.appendChild(el('td', '', dupSet.has(t) ? i18nT('duplicate') : '＋'));
      tr.appendChild(el('td', 'num', t.date));
      tr.appendChild(el('td', '', i18nT(TYPE_LABEL[t.type] || t.type) + (t.short ? ' (' + i18nT('short') + ')' : '')));
      tr.appendChild(el('td', 'sym', t.symbol || ''));
      tr.appendChild(el('td', 'num', fin(t.qty) ? String(+Math.abs(t.qty).toFixed(8)) : t.type === 'split' && t.ratio != null ? String(t.ratio) : ''));
      tr.appendChild(el('td', 'num', fin(t.price) ? priceTxt(t.price, t.symbol) : ''));
      tr.appendChild(el('td', 'num', fin(t.amount) ? fmtNum(t.amount, 2) : ''));
      tr.appendChild(el('td', 'num', fin(t.fee) && t.fee ? fmtNum(t.fee, 2) : ''));
      tr.appendChild(el('td', '', t.currency || ''));
      body.appendChild(tr);
    }
    if (list.length > 60) { const tr = el('tr'); const td = el('td', 'field-note', '… ' + (list.length - 60) + ' ' + i18nT('more')); td.colSpan = 9; tr.appendChild(td); body.appendChild(tr); }
    if (!list.length) { const tr = el('tr'); const td = el('td', 'empty-cell', i18nT('Nothing to import from this file yet.')); td.colSpan = 9; tr.appendChild(td); body.appendChild(tr); }

    const errs = $('impErrs');
    errs.textContent = '';
    for (const e of (res.errors || []).slice(0, 25)) errs.appendChild(el('p', 'field-note warn-note', (e.row ? i18nT('Row') + ' ' + e.row + ': ' : '') + i18nT(e.message)));
    if ((res.errors || []).length > 25) errs.appendChild(el('p', 'field-note', '… ' + ((res.errors.length - 25)) + ' ' + i18nT('more errors')));
    // Skip reasons grouped: "12 × Currency conversion" reads better than twelve lines.
    const skipBy = new Map();
    for (const s of res.skipped || []) skipBy.set(s.reason, (skipBy.get(s.reason) || 0) + 1);
    for (const [r, c] of skipBy) errs.appendChild(el('p', 'field-note', i18nT('Skipped') + ' ' + c + ' × ' + i18nT(r)));

    const go = $('impGo');
    go.disabled = !imp.fresh.length;
    go.textContent = imp.fresh.length ? i18nT('Import') + ' ' + imp.fresh.length : i18nT('Import');
  }

  function commitImport() {
    if (!imp.fresh.length) return;
    const r = store.addTxns(imp.fresh);
    for (const t of imp.fresh) if (t.symbol && t.type === 'buy') safe(() => store.addSymbol(t.symbol));
    deps.onChange();
    deps.toast(i18nT('Imported') + ' ' + r.added + ' ' + i18nT('transactions') + (imp.dups.length ? ' · ' + imp.dups.length + ' ' + i18nT('duplicates skipped') : '')
      + (r.dropped ? ' · ' + r.dropped + ' ' + i18nT('could not be stored') : '') + '.');
    imp.text = ''; imp.parsed = null; imp.result = null; imp.fresh = []; imp.dups = []; imp.mapping = null;
    $('impFile').value = '';
    open();
  }

  /* ---- wiring ------------------------------------------------------------------ */
  $('ledAdd').addEventListener('click', () => openTxn(null, { type: 'buy' }));
  $('ledImport').addEventListener('click', openImport);
  $('ledExport').addEventListener('click', () => deps.downloadFile('carino-ledger-' + localToday() + '.csv', 'text/csv', toCSV(store.ledger)));
  $('ledExportPos').addEventListener('click', () => deps.downloadFile('carino-positions-' + localToday() + '.csv', 'text/csv', deps.positionsCSV()));
  $('ledRealCsv').addEventListener('click', realizedCSV);
  for (const [id, k] of [['ledFSym', 'sym'], ['ledFType', 'type'], ['ledFAcct', 'acct'], ['ledFFrom', 'from'], ['ledFTo', 'to']]) {
    $(id).addEventListener('change', (e) => { filter[k] = e.target.value; render(); });
  }
  $('txType').addEventListener('change', syncTxnForm);
  $('txSym').addEventListener('change', syncTxnForm);
  for (const id of ['txQty', 'txPrice', 'txFee', 'txRatio', 'txCcy']) $(id).addEventListener('input', preview);
  $('txSave').addEventListener('click', saveTxn);
  $('txDelete').addEventListener('click', deleteTxn);
  $('txBack').addEventListener('click', () => open());
  for (const id of ['txQty', 'txPrice', 'txAmount', 'txRatio', 'txSym', 'txNote']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTxn(); } });
  }
  const drop = $('impDrop');
  drop.addEventListener('click', () => $('impFile').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('impFile').click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; readFile(f); });
  $('impFile').addEventListener('change', (e) => readFile(e.target.files && e.target.files[0]));
  $('impPreset').addEventListener('change', () => { if ($('impPreset').value !== 'custom') imp.mapping = null; runImport(); });
  for (const id of ['impDecimal', 'impDateOrder', 'impCcy', 'impAcct']) $(id).addEventListener('change', runImport);
  $('impGo').addEventListener('click', commitImport);
  $('impBack').addEventListener('click', () => open());

  return { open, openTxn, openImport, render, isOpen };
}
