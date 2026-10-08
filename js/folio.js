/* folio.js — the one place the live portfolio is assembled from the ledger.

   portfolio.js is the arithmetic; this file is the glue every window shares
   around it, so the main window, a workspace widget and a detached panel can
   never value the same ledger three different ways:

   - FX comes from the quotes the app already fetches (EURUSD, USDMXN, ...).
     A rate is looked up direct, then inverted, then crossed through USD, and
     an answer that needs a pair nobody quoted is null — never 1. portfolio.js
     lists the currency it could not convert rather than adding pesos to dollars.
   - A ledger entry with no currency on record (a migrated holding) is read in
     its instrument's quote currency, then the cached profile's, then USD. That
     is the same answer the old holdings table gave, so a migration never
     changes what a position is worth.
   - The result is memoised on (ledger, quotes, settings): a board of six
     portfolio widgets repaints every second, and one replay of the ledger per
     changed input is all of them together.

   Pure apart from the memo. No DOM, no storage, no fetching. */

import { buildPortfolio } from './portfolio.js';
import { classify } from './providers/assetclass.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const CCY = /^[A-Z]{3}$/;

// Quoted the way the market quotes them, so the symbol asked for is the one a
// provider actually lists. Everything else is quoted as USDxxx.
const USD_SECOND = new Set(['EUR', 'GBP', 'AUD', 'NZD']);

/* (from, to) -> rate | null from a quote map. A pair quote's price is units
   of the second currency per one unit of the first (EURUSD 1.08). */
export function fxFromQuotes(quotes) {
  const qs = quotes && typeof quotes === 'object' ? quotes : {};
  const px = (sym) => { const q = qs[sym]; return q && fin(q.price) && q.price > 0 ? q.price : null; };
  const direct = (a, b) => {
    if (a === b) return 1;
    const d = px(a + b); if (d != null) return d;
    const i = px(b + a); if (i != null) return 1 / i;
    return null;
  };
  return (from, to) => {
    const a = String(from || '').toUpperCase(), b = String(to || '').toUpperCase();
    if (!a || !b) return null;
    if (a === b) return 1;
    const d = direct(a, b);
    if (d != null) return d;
    if (a !== 'USD' && b !== 'USD') {
      const x = direct(a, 'USD'), y = direct('USD', b);
      if (x != null && y != null) return x * y;
    }
    return null;
  };
}

// The quote symbol that prices `ccy` against USD, in market convention.
export function usdPair(ccy) {
  const c = String(ccy || '').toUpperCase();
  if (!CCY.test(c) || c === 'USD') return null;
  return USD_SECOND.has(c) ? c + 'USD' : 'USD' + c;
}

/* The pairs a ledger needs fetched to be valued in `base`: one USD leg per
   foreign currency plus the base's own USD leg, so any cross can be built. */
export function fxPairsNeeded(ledger, quotes, base) {
  const b = String(base || 'USD').toUpperCase();
  const seen = new Set();
  const add = (c) => { const u = String(c || '').toUpperCase(); if (CCY.test(u) && u !== b) seen.add(u); };
  for (const t of Array.isArray(ledger) ? ledger : []) {
    if (!t) continue;
    add(t.currency);
    const q = t.symbol && quotes ? quotes[t.symbol] : null;
    if (q) add(q.currency);
  }
  const out = new Set();
  for (const c of seen) {
    // A crypto "currency" (BTC as a quote leg) is not an FX pair any provider here quotes.
    if (classify(c) === 'crypto') continue;
    const p = usdPair(c); if (p) out.add(p);
    if (b !== 'USD' && c !== 'USD') { const pb = usdPair(b); if (pb) out.add(pb); }
  }
  if (seen.size && b !== 'USD') { const pb = usdPair(b); if (pb) out.add(pb); }
  return [...out];
}

/* Ledger entries with currency:null get the instrument's own currency. A new
   array of new objects only where something changed; the stored ledger is
   never touched. */
export function resolveLedger(ledger, quotes, profileFor) {
  const list = Array.isArray(ledger) ? ledger : [];
  let changed = false;
  const out = list.map((t) => {
    // Only an instrument has a currency of its own to fall back on; a cash row
    // with none stays null and portfolio.js books it in the base currency.
    if (!t || !t.symbol || (t.currency && CCY.test(t.currency))) return t;
    const q = t.symbol && quotes ? quotes[t.symbol] : null;
    let p = null;
    try { p = t.symbol && profileFor ? profileFor(t.symbol) : null; } catch (e) { p = null; }
    const ccy = (q && q.currency) || (p && p.currency) || 'USD';
    changed = true;
    return { ...t, currency: String(ccy).toUpperCase() };
  });
  return changed ? out : list;
}

export function ledgerAccounts(ledger) {
  const set = new Set();
  for (const t of Array.isArray(ledger) ? ledger : []) if (t && t.account) set.add(t.account);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function ledgerSymbols(ledger) {
  const set = new Set();
  for (const t of Array.isArray(ledger) ? ledger : []) if (t && t.symbol) set.add(t.symbol);
  return [...set];
}

// Cheap identity for a ledger that is edited in place (push, splice, replace).
export function ledgerSig(ledger) {
  const l = Array.isArray(ledger) ? ledger : [];
  let h = l.length;
  for (const t of l) {
    if (!t) continue;
    // Every field the arithmetic reads: an edit that changes only the symbol, a
    // split ratio or the short flag must still invalidate the memo.
    const s = (t.id || '') + '|' + (t.date || '') + '|' + (t.type || '') + '|' + (t.symbol || '') + '|' + (t.qty ?? '') + '|' + (t.price ?? '')
      + '|' + (t.amount ?? '') + '|' + (t.fee ?? '') + '|' + (t.ratio ?? '') + '|' + (t.short ? 1 : 0) + '|' + (t.account || '') + '|' + (t.currency || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return l.length + ':' + h;
}

/* computePortfolio({ledger, quotes, baseCurrency, method, profileFor, account})
   -> buildPortfolio's result plus {fx, ledger (resolved), account, empty}.
   `account` filters to one account ('' = all). Memoised on its inputs. */
// A few slots, not one: an account-filtered widget and an all-accounts widget
// on the same board would otherwise evict each other every second.
const memo = new Map();   // key -> {quotes, value}
const MEMO_MAX = 8;
export function computePortfolio(opts = {}) {
  const ledger = Array.isArray(opts.ledger) ? opts.ledger : [];
  const quotes = opts.quotes && typeof opts.quotes === 'object' ? opts.quotes : {};
  const base = CCY.test(String(opts.baseCurrency || '')) ? opts.baseCurrency : 'USD';
  const method = opts.method || 'fifo';
  const account = typeof opts.account === 'string' ? opts.account : '';
  const key = ledgerSig(ledger) + '|' + base + '|' + method + '|' + account;
  const hit = memo.get(key);
  if (hit && hit.quotes === quotes && hit.value) return hit.value;

  const fx = fxFromQuotes(quotes);
  let list = resolveLedger(ledger, quotes, opts.profileFor);
  if (account) list = list.filter((t) => t && (t.account || '') === account);
  let pf;
  try { pf = buildPortfolio(list, quotes, { method, baseCurrency: base, fx }); }
  catch (e) { pf = null; }
  const value = pf ? { ...pf, fx, ledger: list, account, baseCurrency: base, empty: !list.length } : null;
  memo.delete(key);
  memo.set(key, { quotes, value });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return value;
}

/* Positions as CSV rows (base-currency columns included). Spreadsheet-safe:
   a text cell that starts like a formula is prefixed. */
export function positionsCSV(pf) {
  const cols = ['symbol', 'account', 'currency', 'qty', 'avg_cost', 'price', 'market_value', 'cost_basis', 'unrealized',
    'unrealized_pct', 'realized', 'dividends', 'fees', 'day_pl', 'weight_pct', 'value_base', 'base_currency'];
  const rows = [cols];
  const n = (v, d = 6) => (fin(v) ? +v.toFixed(d) : '');
  for (const p of (pf && pf.positions) || []) {
    rows.push([p.symbol, p.account || '', p.currency || '', n(p.qty, 8), n(p.avgCost), n(p.price), n(p.marketValue, 2), n(p.costBasis, 2),
      n(p.unrealized, 2), n(p.unrealizedPct, 2), n(p.realized, 2), n(p.dividends, 2), n(p.fees, 2), n(p.dayPL, 2), n(p.weight, 2),
      n(p.valueBase, 2), pf.baseCurrency || '']);
  }
  for (const [ccy, v] of Object.entries((pf && pf.cash) || {})) {
    rows.push(['CASH', '', ccy, '', '', '', n(v, 2), '', '', '', '', '', '', '', '', '', pf.baseCurrency || '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) s = '\'' + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
