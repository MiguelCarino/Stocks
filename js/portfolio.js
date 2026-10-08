/* portfolio.js — pure portfolio math over a transaction ledger.

   The old model was one flat row per holding ({symbol, shares, cost}), which can
   answer "what is it worth" and nothing else: no dates means no realized P/L, no
   income, no returns, no lots. Everything here derives from an append-only list
   of dated transactions instead, so every number on screen can be re-derived
   (and re-checked) from what the user actually recorded.

   Conventions that the rest of the file leans on:
   - Quantities on a Txn are POSITIVE; the type says the direction. A 'sell' with
     an explicitly negative qty (or short:true) is a deliberate short sale. A
     plain sell larger than the holding is a ledger mistake, not a short: the
     excess is ignored and reported in `errors`, never silently turned into a
     position the user does not have.
   - Fees are part of the trade: they raise the cost of a buy and reduce the
     proceeds of a sell, so realized P/L is already net of trading fees. A
     standalone 'fee' txn (ADR fee, account fee) is booked separately.
   - Money is kept per currency until the very end. Conversion to the base
     currency happens once, through the injected fx(from, to) callback, and a
     currency it cannot convert is LISTED (totals.currencyMissing) and left out
     of the base totals — adding pesos to dollars is the bug this file replaces.
   - Cash is only tracked once the ledger records money moving in or out
     (a 'deposit' or 'withdraw'). Without that, every buy would drive an
     imaginary cash balance negative and net worth would read as "gain only".

   Educational and informational only: these figures are not tax advice, and
   the realized events do not implement any jurisdiction's wash-sale or
   cost-basis-election rules.

   Pure. The only import is the symbol classifier, itself pure. */

import { classify } from './providers/assetclass.js';

const DAY = 86400000;
const EPS = 1e-10;            // absolute; a satoshi (1e-8) must survive, float dust must not

export const TXN_TYPES = ['buy', 'sell', 'dividend', 'fee', 'split', 'deposit', 'withdraw', 'interest', 'tax'];
export const COST_METHODS = ['fifo', 'avg', 'lifo'];
// Legacy holdings had no date. They are migrated as buys on this marker day so
// they sort first and so date-based math (holding period, XIRR) can skip them.
export const MIGRATED_DATE = '1970-01-01';
export const OTHER = 'Other/Unknown';

const TYPE_ALIASES = { div: 'dividend', dividends: 'dividend', withdrawal: 'withdraw', fees: 'fee', taxes: 'tax' };
// Same-day ordering: money arrives first, a split applies before that day's
// trades (they already print at the split-adjusted price), money leaves last.
// Everything else keeps the order it was entered in.
const DAY_ORDER = { deposit: 0, split: 1, withdraw: 3 };

/* ---- Small helpers --------------------------------------------------------- */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Any date-ish input -> 'YYYY-MM-DD'. Strings already in that shape pass through
// untouched (no timezone round-trip that could shift them a day).
export function toDay(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// 'YYYY-MM-DD' -> whole days since the epoch (UTC), for day arithmetic.
export function dayNum(x) {
  const s = toDay(x);
  if (!s) return null;
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
}

export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseRatio(r) {
  if (fin(r)) return r > 0 ? r : null;
  if (typeof r === 'string') {
    const m = /^\s*([\d.]+)\s*[:/\-xX]\s*([\d.]+)\s*$/.exec(r);
    if (m) { const a = +m[1], b = +m[2]; return a > 0 && b > 0 ? a / b : null; }
    const n = parseFloat(r);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function addTo(map, key, v) { if (v) map[key] = (map[key] || 0) + v; }

// fx wrapper: identity for same currency, null (never NaN, never 1) when unknown.
function makeRate(fx) {
  return (from, to, t) => {
    if (!from || !to || from === to) return 1;
    let r = null;
    try { r = fx ? fx(from, to, t) : null; } catch { r = null; }
    return fin(r) && r > 0 ? r : null;
  };
}

/* ---- Transaction normalization -------------------------------------------- */
/* Returns {txn} or {error}. Unknown extra fields are kept so a UI can store its
   own annotations on a txn without this file stripping them. */
export function normalizeTxn(t, defCurrency = 'USD') {
  if (!t || typeof t !== 'object') return { error: 'Not a transaction' };
  let type = String(t.type || '').toLowerCase().trim();
  type = TYPE_ALIASES[type] || type;
  if (!TXN_TYPES.includes(type)) return { error: `Unknown type "${t.type}"` };
  const date = toDay(t.date);
  if (!date) return { error: 'Missing or invalid date' };
  const symbol = t.symbol ? String(t.symbol).toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '') : '';
  const out = { ...t, type, date, symbol: symbol || undefined,
                currency: String(t.currency || defCurrency).toUpperCase().trim() || defCurrency,
                account: t.account ? String(t.account).trim() : '' };
  out.qty = num(t.qty); out.price = num(t.price); out.amount = num(t.amount);
  out.fee = Math.abs(num(t.fee) || 0);
  if (type === 'buy' || type === 'sell') {
    if (!symbol) return { error: 'Trade without a symbol' };
    if (!fin(out.qty) || out.qty === 0) return { error: 'Trade without a quantity' };
    if (type === 'buy' && out.qty < 0) return { error: 'Negative buy quantity' };
    if (type === 'sell' && out.qty < 0) { out.qty = -out.qty; out.short = true; }
    if (!fin(out.price) || out.price < 0) {
      // A total amount is enough to recover the unit price.
      if (fin(out.amount) && out.amount !== 0) out.price = Math.max(0, (Math.abs(out.amount) - (type === 'buy' ? out.fee : -out.fee)) / out.qty);
      else return { error: 'Trade without a price' };
    }
  } else if (type === 'split') {
    if (!symbol) return { error: 'Split without a symbol' };
    out.ratio = parseRatio(t.ratio);
    if (!out.ratio) return { error: 'Split without a valid ratio' };
  } else if (type === 'dividend') {
    if (!fin(out.amount) && !fin(out.price)) return { error: 'Dividend without an amount' };
  } else if (type === 'fee') {
    if (!fin(out.amount)) { if (out.fee) out.amount = out.fee; else return { error: 'Fee without an amount' }; out.fee = 0; }
  } else if (!fin(out.amount)) {
    return { error: `${type[0].toUpperCase() + type.slice(1)} without an amount` };
  }
  return { txn: out };
}

function sortTxns(list) {
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1
      : ((DAY_ORDER[a.t.type] ?? 2) - (DAY_ORDER[b.t.type] ?? 2)) || a.i - b.i))
    .map((x) => x.t);
}

/* ---- The book: a running ledger state -------------------------------------
   One function applies one transaction. buildPortfolio replays the whole
   ledger; portfolioHistory replays it day by day and snapshots in between —
   the same code path, so the history and the live table can never disagree. */
function newBook(method, today) {
  return {
    method: COST_METHODS.includes(method) ? method : 'fifo',
    today,
    positions: new Map(),
    cash: {},                    // ccy -> amount
    cashByAccount: {},           // account -> ccy -> amount
    cashTracked: false,
    // money not attached to a symbol (attached money lives on the position)
    interest: {}, feesLoose: {}, taxesLoose: {}, dividendsNoSymbol: {},
    realizedEvents: [],
    errors: [],
    flowExternal: {},            // ccy -> deposits − withdrawals (per apply window)
    flowTrades: {},              // ccy -> net money put into holdings (per apply window)
  };
}

function posKey(account, symbol) { return `${account || ''}\u0001${symbol}`; }

function getPos(book, txn) {
  const key = posKey(txn.account, txn.symbol);
  let p = book.positions.get(key);
  if (!p) {
    p = { symbol: txn.symbol, account: txn.account || '', currency: txn.currency, qty: 0, cost: 0, lots: [],
          realized: 0, dividends: 0, fees: 0, feesStandalone: 0, taxes: 0, todayCloses: [], firstDate: txn.date,
          lastPrice: null };
    book.positions.set(key, p);
  }
  return p;
}

function moveCash(book, txn, delta) {
  if (!delta) return;
  addTo(book.cash, txn.currency, delta);
  const acct = txn.account || '';
  if (!book.cashByAccount[acct]) book.cashByAccount[acct] = {};
  addTo(book.cashByAccount[acct], txn.currency, delta);
}

function holdingDays(openDate, closeDate) {
  if (!openDate || openDate === MIGRATED_DATE) return null;
  return dayNum(closeDate) - dayNum(openDate);
}

// A buy (+qty) or sell (−qty). Closes against open lots of the opposite sign
// first, then opens a new lot with whatever is left.
function applyTrade(book, txn) {
  const p = getPos(book, txn);
  const sgn = txn.type === 'buy' ? 1 : -1;
  const absd = txn.qty;
  const fee = txn.fee || 0;
  const price = txn.price;
  let remaining = absd, processed = 0;
  p.lastPrice = price;

  if (Math.abs(p.qty) > EPS && Math.sign(p.qty) !== sgn) {
    const closeQty = Math.min(absd, Math.abs(p.qty));
    const feeClose = fee * closeQty / absd;
    const exitNet = price + sgn * feeClose / closeQty;   // proceeds per unit (long) / cost per unit (cover)
    const lotSign = -sgn;
    const avgPrice = p.cost / p.qty;
    let left = closeQty;
    while (left > EPS && p.lots.length) {
      const idx = book.method === 'lifo' ? p.lots.length - 1 : 0;
      const lot = p.lots[idx];
      const take = Math.min(left, Math.abs(lot.qty));
      const unit = book.method === 'avg' ? avgPrice : lot.price;
      const pl = lotSign * take * (exitNet - unit);
      p.realized += pl;
      const days = holdingDays(lot.date, txn.date);
      book.realizedEvents.push({
        date: txn.date, symbol: p.symbol, account: p.account, currency: p.currency,
        side: lotSign > 0 ? 'long' : 'short', qty: take, openDate: lot.date,
        openPrice: unit, closePrice: exitNet, fee: feeClose * take / closeQty,
        proceeds: lotSign > 0 ? take * exitNet : take * unit,
        basis: lotSign > 0 ? take * unit : take * exitNet,
        pl, holdingDays: days, term: days == null ? null : days > 365 ? 'long' : 'short',
        txnId: txn.id,
      });
      if (txn.date === book.today) p.todayCloses.push({ qty: lotSign * take, exit: price, lotDate: lot.date, lotRaw: lot.raw });
      if (book.method !== 'avg') p.cost -= lotSign * take * lot.price;
      lot.qty -= lotSign * take;
      if (Math.abs(lot.qty) <= EPS) p.lots.splice(idx, 1);
      left -= take;
    }
    p.qty += sgn * closeQty;
    if (Math.abs(p.qty) <= EPS) { p.qty = 0; p.lots = []; p.cost = 0; }
    else if (book.method === 'avg') p.cost = p.qty * avgPrice;
    remaining = absd - closeQty;
    processed = closeQty;
  }

  if (remaining > EPS && sgn < 0 && !txn.short) {
    book.errors.push({ txnId: txn.id, date: txn.date, symbol: p.symbol,
      message: `Sell of ${absd} exceeds the ${processed} held; the extra ${+remaining.toPrecision(12)} was ignored` });
    remaining = 0;
  }
  if (remaining > EPS) {
    const feeOpen = fee * remaining / absd;
    const entry = price + sgn * feeOpen / remaining;
    p.lots.push({ date: txn.date, qty: sgn * remaining, price: entry, raw: price });
    p.qty += sgn * remaining;
    p.cost += sgn * remaining * entry;
    processed += remaining;
  }

  p.fees += fee;
  const gross = processed * price;
  const cashDelta = sgn > 0 ? -(gross + fee) : gross - fee;
  moveCash(book, txn, cashDelta);
  addTo(book.flowTrades, txn.currency, -cashDelta);
}

function applySplit(book, txn) {
  const r = txn.ratio;
  for (const p of book.positions.values()) {
    if (p.symbol !== txn.symbol) continue;
    if (txn.account && p.account !== txn.account) continue;
    p.qty *= r;
    for (const lot of p.lots) { lot.qty *= r; lot.price /= r; lot.raw /= r; }
    if (p.lastPrice != null) p.lastPrice /= r;
    // cost basis is unchanged by a split: same money, more (or fewer) shares
  }
}

export function applyTxn(book, txn) {
  switch (txn.type) {
    case 'buy': case 'sell': applyTrade(book, txn); break;
    case 'split': applySplit(book, txn); break;
    case 'dividend': {
      let amount = txn.amount;
      if (!fin(amount)) {
        // per-share dividend: amount = rate × shares (given, or held right now)
        let held = txn.qty;
        if (!fin(held)) {
          held = 0;
          for (const p of book.positions.values()) if (p.symbol === txn.symbol && (!txn.account || p.account === txn.account)) held += p.qty;
        }
        amount = txn.price * held;
      }
      if (txn.symbol) {
        const p = getPos(book, txn);
        p.dividends += amount;
        p.feesStandalone += txn.fee || 0; p.fees += txn.fee || 0;
      } else addTo(book.dividendsNoSymbol, txn.currency, amount);
      moveCash(book, txn, amount - (txn.fee || 0));
      addTo(book.flowTrades, txn.currency, -(amount - (txn.fee || 0)));
      break;
    }
    case 'interest':
      addTo(book.interest, txn.currency, txn.amount);
      moveCash(book, txn, txn.amount);
      addTo(book.flowTrades, txn.currency, -txn.amount);
      break;
    case 'fee': {
      const a = txn.amount;
      if (txn.symbol) { const p = getPos(book, txn); p.fees += a; p.feesStandalone += a; }
      else addTo(book.feesLoose, txn.currency, a);
      moveCash(book, txn, -a);
      addTo(book.flowTrades, txn.currency, a);
      break;
    }
    case 'tax': {
      const a = txn.amount;   // positive = paid, negative = refund
      if (txn.symbol) { const p = getPos(book, txn); p.taxes += a; }
      else addTo(book.taxesLoose, txn.currency, a);
      moveCash(book, txn, -a);
      addTo(book.flowTrades, txn.currency, a);
      break;
    }
    case 'deposit':
      book.cashTracked = true;
      moveCash(book, txn, Math.abs(txn.amount));
      addTo(book.flowExternal, txn.currency, Math.abs(txn.amount));
      break;
    case 'withdraw':
      book.cashTracked = true;
      moveCash(book, txn, -Math.abs(txn.amount));
      addTo(book.flowExternal, txn.currency, -Math.abs(txn.amount));
      break;
  }
}

// Normalize + sort + replay. Shared by every entry point below.
function prepare(txns, baseCurrency) {
  const errors = [], list = [];
  (Array.isArray(txns) ? txns : []).forEach((t, i) => {
    const r = normalizeTxn(t, baseCurrency);
    if (r.error) errors.push({ txnId: t?.id, index: i, date: t?.date, symbol: t?.symbol, message: r.error });
    else list.push(r.txn);
  });
  return { list: sortTxns(list), errors };
}

export function runLedger(txns, { method = 'fifo', baseCurrency = 'USD', today = localToday() } = {}) {
  const { list, errors } = prepare(txns, baseCurrency);
  const book = newBook(method, today);
  book.errors.push(...errors);
  for (const t of list) applyTxn(book, t);
  return book;
}

/* ---- buildPortfolio ------------------------------------------------------- */
export function buildPortfolio(txns, quotes = {}, opts = {}) {
  const { method = 'fifo', baseCurrency = 'USD', fx = null, today = localToday() } = opts;
  const rate = makeRate(fx);
  const book = runLedger(txns, { method, baseCurrency, today });
  const missing = new Set();
  const toBase = (v, ccy) => {
    if (!fin(v)) return null;
    const r = rate(ccy, baseCurrency);
    if (r == null) { missing.add(ccy); return null; }
    return v * r;
  };

  const totals = { marketValue: 0, costBasis: 0, unrealized: 0, realized: 0, dividends: 0, fees: 0,
                   feesStandalone: 0, taxes: 0, interest: 0, dayPL: 0, cash: 0, netWorth: 0, totalReturn: 0,
                   cashTracked: book.cashTracked, currencyMissing: [], unpriced: [], baseCurrency };
  let dayKnown = false;
  const positions = [], closedPositions = [];

  for (const p of book.positions.values()) {
    const q = quotes ? quotes[p.symbol] : null;
    let price = fin(q?.price) ? q.price : null;
    let prev = fin(q?.prevClose) ? q.prevClose : (price != null && fin(q?.change) ? price - q.change : null);
    if (price != null && q?.currency && q.currency !== p.currency) {
      // Quote in a different currency than the trades (e.g. a USD quote for a
      // position bought in MXN): bring the price into the position's currency.
      const r = rate(q.currency, p.currency);
      if (r == null) { missing.add(q.currency); price = null; prev = null; }
      else { price *= r; if (prev != null) prev *= r; }
    }
    const open = Math.abs(p.qty) > EPS;
    const marketValue = open && price != null ? p.qty * price : (open ? null : 0);
    const unrealized = marketValue != null && open ? marketValue - p.cost : (open ? null : 0);

    // Day P/L: lots opened today move from their own fill price, not from a
    // close they never experienced; lots closed today count up to the exit.
    let dayPL = null, prevValue = null;
    if (price != null || p.todayCloses.length) {
      let pl = 0, pv = 0, ok = true;
      for (const lot of (open ? p.lots : [])) {
        const ref = lot.date === today ? lot.raw : prev;
        if (ref == null || price == null) { ok = false; break; }
        pl += lot.qty * (price - ref); pv += lot.qty * ref;
      }
      for (const c of p.todayCloses) {
        const ref = c.lotDate === today ? c.lotRaw : prev;
        if (ref == null) { ok = false; break; }
        pl += c.qty * (c.exit - ref); pv += c.qty * ref;
      }
      if (ok) { dayPL = pl; prevValue = pv; }
    }

    const row = {
      symbol: p.symbol, account: p.account, currency: p.currency, qty: open ? p.qty : 0,
      avgCost: open ? p.cost / p.qty : null, costBasis: open ? p.cost : 0, price,
      marketValue, unrealized, unrealizedPct: open && unrealized != null && p.cost ? unrealized / Math.abs(p.cost) * 100 : null,
      realized: p.realized, dividends: p.dividends, fees: p.fees, taxes: p.taxes,
      dayPL, dayPLPct: dayPL != null && prevValue ? dayPL / Math.abs(prevValue) * 100 : null,
      weight: null, firstDate: p.firstDate,
      lots: open ? p.lots.map((l) => ({ date: l.date, qty: l.qty, price: l.price, raw: l.raw })) : [],
      valueBase: null, costBase: null, unrealizedBase: null, dayPLBase: null,
    };
    const r = rate(p.currency, baseCurrency);
    if (r == null) missing.add(p.currency);
    else {
      row.valueBase = marketValue != null ? marketValue * r : null;
      row.costBase = row.costBasis * r;
      row.unrealizedBase = unrealized != null ? unrealized * r : null;
      row.dayPLBase = dayPL != null ? dayPL * r : null;
      totals.realized += p.realized * r;
      totals.dividends += p.dividends * r;
      totals.fees += p.fees * r;
      totals.feesStandalone += p.feesStandalone * r;
      totals.taxes += p.taxes * r;
      if (row.dayPLBase != null) { totals.dayPL += row.dayPLBase; dayKnown = true; }
      if (open) {
        if (row.valueBase != null) {
          totals.marketValue += row.valueBase; totals.costBasis += row.costBase; totals.unrealized += row.unrealizedBase;
        } else totals.unpriced.push(p.symbol);
      }
    }
    (open ? positions : closedPositions).push(row);
  }

  for (const row of positions) row.weight = row.valueBase != null && totals.marketValue ? row.valueBase / totals.marketValue * 100 : null;

  for (const [ccy, v] of Object.entries(book.dividendsNoSymbol)) { const b = toBase(v, ccy); if (b != null) totals.dividends += b; }
  for (const [ccy, v] of Object.entries(book.interest)) { const b = toBase(v, ccy); if (b != null) totals.interest += b; }
  for (const [ccy, v] of Object.entries(book.feesLoose)) {
    const b = toBase(v, ccy); if (b != null) { totals.fees += b; totals.feesStandalone += b; }
  }
  for (const [ccy, v] of Object.entries(book.taxesLoose)) { const b = toBase(v, ccy); if (b != null) totals.taxes += b; }

  const cash = book.cashTracked ? { ...book.cash } : {};
  if (book.cashTracked) for (const [ccy, v] of Object.entries(cash)) { const b = toBase(v, ccy); if (b != null) totals.cash += b; }
  totals.netWorth = totals.marketValue + totals.cash;
  if (!dayKnown) totals.dayPL = null;
  // Total return = what the holdings did + what they paid − money lost to
  // standalone fees and taxes. Trade fees are already inside cost and proceeds.
  totals.totalReturn = totals.unrealized + totals.realized + totals.dividends + totals.interest - totals.feesStandalone - totals.taxes;
  totals.currencyMissing = [...missing].sort();

  const realizedEvents = book.realizedEvents.map((e) => {
    const r = rate(e.currency, baseCurrency);
    return { ...e, plBase: r == null ? null : e.pl * r };
  });

  positions.sort((a, b) => (b.valueBase ?? -Infinity) - (a.valueBase ?? -Infinity));
  return { positions, closedPositions, cash, cashByAccount: book.cashTracked ? book.cashByAccount : {},
           totals, realizedEvents, errors: book.errors, method: book.method };
}

/* ---- Legacy migration ----------------------------------------------------- */
export function holdingsToTxns(legacy, { currency = 'USD' } = {}) {
  const out = [];
  for (const h of Array.isArray(legacy) ? legacy : []) {
    const shares = Number(h?.shares);
    if (!h?.symbol || !Number.isFinite(shares) || shares === 0) continue;
    const c = Number(h.cost) || 0;
    const per = h.costMode === 'total' ? c / Math.abs(shares) : c;
    out.push({
      id: `mig-${h.id || h.symbol}-${out.length}`, date: MIGRATED_DATE,
      type: shares > 0 ? 'buy' : 'sell', symbol: String(h.symbol).toUpperCase(),
      qty: shares,   // a negative legacy row becomes an explicit short (see normalizeTxn)
      price: per, fee: 0, currency: (h.currency || currency).toUpperCase(),
      note: h.note ? `migrated · ${h.note}` : 'migrated', migrated: true,
    });
  }
  return out;
}

/* ---- Returns: XIRR, TWR ---------------------------------------------------- */
/* flows: [{date, amount}] from the investor's side — money in is negative,
   money out (and the terminal value) positive. Same convention as Excel XIRR,
   with the same Actual/365 day count. */
export function xirr(flows, guess = 0.1) {
  const pts = (flows || []).map((f) => ({ d: dayNum(f.date ?? f.t), a: Number(f.amount) }))
    .filter((f) => f.d != null && Number.isFinite(f.a) && f.a !== 0);
  if (pts.length < 2 || !pts.some((f) => f.a > 0) || !pts.some((f) => f.a < 0)) return null;
  const d0 = Math.min(...pts.map((f) => f.d));
  const f = (r) => pts.reduce((s, p) => s + p.a / Math.pow(1 + r, (p.d - d0) / 365), 0);
  const df = (r) => pts.reduce((s, p) => { const t = (p.d - d0) / 365; return s - t * p.a / Math.pow(1 + r, t + 1); }, 0);
  const scale = pts.reduce((s, p) => s + Math.abs(p.a), 0);

  let r = guess;
  for (let i = 0; i < 100; i++) {
    const v = f(r), d = df(r);
    if (!Number.isFinite(v) || !Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) { if (Math.abs(f(next)) < 1e-6 * scale) return next; break; }
    r = next;
  }
  // Newton wandered off (or the function is nasty): bracket and bisect.
  const grid = [-0.999999, -0.99, -0.9, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 5, 10, 100, 1000];
  for (let i = 0; i < grid.length - 1; i++) {
    let lo = grid[i], hi = grid[i + 1], flo = f(lo), fhi = f(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) continue;
    for (let k = 0; k < 300; k++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(hi - lo) < 1e-12 || fm === 0) return mid;
      if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  }
  return null;
}

/* Chain-linked time-weighted return. valuePoints [{t|date, value}] are
   valuations; flows [{date, amount}] are external money (+ in, − out). Each
   flow belongs to the sub-period that ends on or after it. timing 'start'
   (default) assumes the money was invested at the start of that sub-period:
   r = V1 / (V0 + F) − 1; 'end' assumes it arrived just before V1 was taken:
   r = (V1 − F) / V0 − 1. With a valuation on every flow day both are exact. */
export function twrSeries(valuePoints, flows = [], { timing = 'start' } = {}) {
  const pts = (valuePoints || []).map((p) => ({ d: dayNum(p.t ?? p.date), v: Number(p.value), t: p.t ?? p.date }))
    .filter((p) => p.d != null && Number.isFinite(p.v)).sort((a, b) => a.d - b.d);
  const fl = (flows || []).map((f) => ({ d: dayNum(f.date ?? f.t), a: Number(f.amount) }))
    .filter((f) => f.d != null && Number.isFinite(f.a));
  if (pts.length < 2) return [];
  const out = [{ t: pts[0].t, cum: 0 }];
  let growth = 1;
  for (let i = 1; i < pts.length; i++) {
    const F = fl.reduce((s, f) => (f.d > pts[i - 1].d && f.d <= pts[i].d ? s + f.a : s), 0);
    const den = timing === 'end' ? pts[i - 1].v : pts[i - 1].v + F;
    const numr = timing === 'end' ? pts[i].v - F : pts[i].v;
    if (den > EPS) growth *= numr / den;       // an empty portfolio has no return to link
    out.push({ t: pts[i].t, cum: growth - 1 });
  }
  return out;
}

export function twr(valuePoints, flows = [], opts = {}) {
  const s = twrSeries(valuePoints, flows, opts);
  return s.length ? s[s.length - 1].cum : null;
}

// Annualize a cumulative return over `days`. Below a year this would extrapolate
// a lucky month into a fantasy CAGR, so it answers null unless forced.
export function annualize(total, days, { force = false } = {}) {
  if (!fin(total) || !fin(days) || days <= 0 || total <= -1) return null;
  if (days < 365 && !force) return null;
  return Math.pow(1 + total, 365 / days) - 1;
}

/* Cash flows for XIRR straight from a ledger. If the ledger records deposits,
   those are the investor's flows; otherwise each trade/dividend is (money into
   the holdings is negative). The terminal value closes the series. Migrated,
   undated buys make a money-weighted return meaningless, so they are skipped
   and a warning says so. */
export function investorFlows(txns, { baseCurrency = 'USD', fx = null, terminalValue = null, asOf = localToday() } = {}) {
  const rate = makeRate(fx);
  const { list } = prepare(txns, baseCurrency);
  const tracked = list.some((t) => t.type === 'deposit' || t.type === 'withdraw');
  const flows = [], warnings = [], missing = new Set();
  let migrated = 0;
  for (const t of list) {
    if (t.date === MIGRATED_DATE) { migrated++; continue; }
    let a = null;
    if (tracked) {
      if (t.type === 'deposit') a = -Math.abs(t.amount);
      else if (t.type === 'withdraw') a = Math.abs(t.amount);
    } else if (t.type === 'buy') a = -(t.qty * t.price + t.fee);
    else if (t.type === 'sell') a = t.qty * t.price - t.fee;
    else if (t.type === 'dividend' && fin(t.amount)) a = t.amount - t.fee;
    else if (t.type === 'interest') a = t.amount;
    else if (t.type === 'fee' || t.type === 'tax') a = -t.amount;
    if (a == null || !a) continue;
    const r = rate(t.currency, baseCurrency, Date.parse(t.date));
    if (r == null) { missing.add(t.currency); continue; }
    flows.push({ date: t.date, amount: a * r });
  }
  if (migrated) warnings.push(`${migrated} migrated holding(s) have no purchase date and were left out`);
  if (missing.size) warnings.push(`No exchange rate for ${[...missing].join(', ')}`);
  if (fin(terminalValue)) flows.push({ date: toDay(asOf), amount: terminalValue });
  return { flows, warnings, cashTracked: tracked };
}

/* ---- Risk ------------------------------------------------------------------ */
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function stdev(a, { sample = true } = {}) {
  const v = (a || []).filter(fin);
  if (v.length < (sample ? 2 : 1)) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - (sample ? 1 : 0)));
}

export function simpleReturns(values) {
  const out = [];
  for (let i = 1; i < (values || []).length; i++) {
    const a = values[i - 1], b = values[i];
    out.push(fin(a) && fin(b) && a !== 0 ? b / a - 1 : null);
  }
  return out;
}

/* Deepest peak-to-trough fall of a value series, as a NEGATIVE fraction
   (−0.25 = a 25% drawdown; 0 when it never fell). */
export function maxDrawdown(values) {
  let peak = null, peakI = -1, mdd = 0, pI = -1, tI = -1, last = null;
  (values || []).forEach((v, i) => {
    if (!fin(v)) return;
    if (peak == null || v > peak) { peak = v; peakI = i; }
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < mdd) { mdd = dd; pI = peakI; tI = i; }
    last = v;
  });
  if (peak == null) return null;
  let recoveryIndex = null;
  if (tI >= 0) for (let i = tI + 1; i < values.length; i++) if (fin(values[i]) && values[i] >= values[pI]) { recoveryIndex = i; break; }
  return { maxDrawdown: mdd, peakIndex: pI, troughIndex: tI, recoveryIndex, current: peak > 0 && last != null ? last / peak - 1 : 0 };
}

/* returns / benchReturns: per-period simple returns, aligned by index (when
   the lengths differ, the trailing overlap is used). rf is ANNUAL (0.05 = 5%).
   maxDrawdown is negative, from the compounded return series. */
export function riskMetrics(returns, benchReturns = null, { periodsPerYear = 252, rf = 0 } = {}) {
  const r = (returns || []).filter(fin);
  const out = { n: r.length, meanAnnual: null, volatility: null, sharpe: null, sortino: null,
                maxDrawdown: null, beta: null, alpha: null, correlation: null };
  if (r.length < 2) return out;
  const ppy = periodsPerYear, rfp = rf / ppy;
  const m = mean(r);
  out.meanAnnual = m * ppy;
  const sd = stdev(r);
  out.volatility = sd * Math.sqrt(ppy);
  out.sharpe = out.volatility > 0 ? (out.meanAnnual - rf) / out.volatility : null;
  const down = Math.sqrt(r.reduce((s, x) => s + Math.min(0, x - rfp) ** 2, 0) / r.length) * Math.sqrt(ppy);
  out.sortino = down > 0 ? (out.meanAnnual - rf) / down : null;
  const eq = [1];
  for (const x of r) eq.push(eq[eq.length - 1] * (1 + x));
  out.maxDrawdown = maxDrawdown(eq).maxDrawdown;

  if (Array.isArray(benchReturns) && benchReturns.length) {
    const n = Math.min(returns.length, benchReturns.length);
    const a = returns.slice(returns.length - n), b = benchReturns.slice(benchReturns.length - n);
    const pa = [], pb = [];
    for (let i = 0; i < n; i++) if (fin(a[i]) && fin(b[i])) { pa.push(a[i]); pb.push(b[i]); }
    if (pa.length >= 2) {
      const ma = mean(pa), mb = mean(pb);
      let cov = 0, va = 0, vb = 0;
      for (let i = 0; i < pa.length; i++) { cov += (pa[i] - ma) * (pb[i] - mb); va += (pa[i] - ma) ** 2; vb += (pb[i] - mb) ** 2; }
      cov /= pa.length - 1; va /= pa.length - 1; vb /= pa.length - 1;
      if (vb > 0) {
        out.beta = cov / vb;
        // Jensen's alpha, annualized: excess return beyond what beta explains.
        out.alpha = (ma * ppy - rf) - out.beta * (mb * ppy - rf);
      }
      if (va > 0 && vb > 0) out.correlation = cov / Math.sqrt(va * vb);
    }
  }
  return out;
}

/* ---- Allocation and drift --------------------------------------------------- */
function assetClassOf(sym, prof) {
  if (prof?.assetClass) return prof.assetClass;
  const t = String(prof?.type || '').toLowerCase();
  if (/etf|fund|trust/.test(t)) return 'ETF/Fund';
  const c = classify(String(sym || ''));
  if (c === 'crypto' || prof?.sector === 'Cryptocurrency' || prof?.exchange === 'Crypto') return 'Crypto';
  if (c === 'fx') return 'FX';
  return sym ? 'Equity' : OTHER;
}

/* positions: rows from buildPortfolio (valueBase is what gets summed);
   profileFor(sym) -> cached profile or null. opts.cash (base currency) adds a
   'Cash' slice. Positions with no base value are left out and counted. */
export function allocation(positions, profileFor = () => null, by = 'symbol', { cash = 0 } = {}) {
  const buckets = new Map();
  let total = 0, excluded = 0;
  for (const p of positions || []) {
    if (!fin(p.valueBase)) { excluded++; continue; }
    let prof = null;
    try { prof = profileFor ? profileFor(p.symbol) : null; } catch { prof = null; }
    let key;
    switch (by) {
      case 'sector': key = prof?.sector || (assetClassOf(p.symbol, prof) === 'Crypto' ? 'Cryptocurrency' : OTHER); break;
      case 'assetClass': key = assetClassOf(p.symbol, prof); break;
      case 'currency': key = p.currency || OTHER; break;
      case 'account': key = p.account || OTHER; break;
      case 'country': key = prof?.country || OTHER; break;
      default: key = p.symbol || OTHER;
    }
    const b = buckets.get(key) || { key, label: key, value: 0, count: 0, symbols: [] };
    b.value += p.valueBase; b.count++; if (!b.symbols.includes(p.symbol)) b.symbols.push(p.symbol);
    buckets.set(key, b);
    total += p.valueBase;
  }
  if (fin(cash) && cash !== 0) { buckets.set('Cash', { key: 'Cash', label: 'Cash', value: cash, count: 0, symbols: [] }); total += cash; }
  const rows = [...buckets.values()];
  for (const r of rows) r.weight = total ? r.value / total * 100 : null;
  // Largest first, but the unknown bucket always last — it is a to-do, not a holding.
  rows.sort((a, b) => (a.key === OTHER) - (b.key === OTHER) || b.value - a.value);
  rows.excluded = excluded;
  return rows;
}

/* targets: {[key]: percent}. toRebalance is the amount (base currency) that
   would bring the slice to its target: positive = add, negative = trim.
   Informational only — it ignores fees, taxes and lot sizes. */
export function drift(allocationRows, targets = {}) {
  const rows = allocationRows || [];
  const total = rows.reduce((s, r) => s + (fin(r.value) ? r.value : 0), 0);
  const out = rows.map((r) => {
    const target = fin(Number(targets?.[r.key])) && targets[r.key] !== '' && targets[r.key] != null ? Number(targets[r.key]) : null;
    const weight = r.weight ?? (total ? r.value / total * 100 : 0);
    return { key: r.key, label: r.label ?? r.key, value: r.value, weight, target,
             drift: target == null ? null : weight - target,
             toRebalance: target == null ? null : target / 100 * total - r.value };
  });
  for (const [key, v] of Object.entries(targets || {})) {
    if (rows.some((r) => r.key === key) || !fin(Number(v))) continue;
    const target = Number(v);
    out.push({ key, label: key, value: 0, weight: 0, target, drift: -target, toRebalance: target / 100 * total });
  }
  out.targetSum = Object.values(targets || {}).reduce((s, v) => s + (fin(Number(v)) ? Number(v) : 0), 0);
  return out;
}

/* ---- Trade calculators (educational, not advice) ---------------------------- */
/* Risk-based position size: risk at most riskPct% of equity if the stop is hit.
   fee is a flat per-trade fee, charged twice (in and out) against the budget.
   step is the lot increment (1 share, 0.001 for fractional, 1e-8 for BTC).
   maxPositionPct caps the position's value as a % of equity. */
export function positionSize({ equity, riskPct, riskAmount = null, entry, stop, fee = 0, step = 1, maxPositionPct = null } = {}) {
  equity = num(equity); entry = num(entry); stop = num(stop); fee = Math.abs(num(fee) || 0);
  step = num(step) > 0 ? num(step) : 1;
  const budget = num(riskAmount) ?? (equity != null && num(riskPct) != null ? equity * num(riskPct) / 100 : null);
  if (budget == null || budget <= 0 || entry == null || entry <= 0 || stop == null || stop < 0 || stop === entry) return null;
  const direction = stop < entry ? 'long' : 'short';
  const riskPerUnit = Math.abs(entry - stop);
  const warnings = [];
  const usable = budget - 2 * fee;
  if (usable <= 0) return { qty: 0, direction, riskPerUnit, riskBudget: budget, actualRisk: 0, positionValue: 0,
                            pctOfEquity: 0, capped: false, warnings: ['Fees exceed the risk budget'] };
  const floorStep = (x) => Math.floor(x / step + 1e-9) * step;
  let qty = floorStep(usable / riskPerUnit);
  let capped = false;
  if (fin(num(maxPositionPct)) && equity) {
    const maxQty = floorStep(equity * num(maxPositionPct) / 100 / entry);
    if (qty > maxQty) { qty = maxQty; capped = true; warnings.push('Capped by the maximum position size'); }
  }
  qty = +qty.toFixed(12);
  const positionValue = qty * entry;
  if (equity && positionValue > equity) warnings.push('Position is larger than the account (needs leverage)');
  if (qty === 0) warnings.push('Risk budget is smaller than one unit');
  return { qty, direction, riskPerUnit, riskBudget: budget, actualRisk: qty * riskPerUnit + (qty ? 2 * fee : 0),
           positionValue, pctOfEquity: equity ? positionValue / equity * 100 : null, capped, warnings };
}

/* Reward-to-risk. breakevenWinRate (percent) is the win rate at which a
   strategy with exactly this ratio neither makes nor loses money. */
export function riskReward({ entry, stop, target, qty = null } = {}) {
  entry = num(entry); stop = num(stop); target = num(target); qty = num(qty);
  if (entry == null || stop == null || target == null || stop === entry) return null;
  const direction = stop < entry ? 'long' : 'short';
  const risk = Math.abs(entry - stop);
  const reward = direction === 'long' ? target - entry : entry - target;
  const valid = reward > 0;
  const ratio = reward / risk;
  return { direction, risk, reward, ratio, valid,
           breakevenWinRate: valid ? risk / (risk + reward) * 100 : null,
           riskAmount: qty != null ? risk * Math.abs(qty) : null,
           rewardAmount: qty != null ? reward * Math.abs(qty) : null,
           riskPct: risk / entry * 100, rewardPct: reward / entry * 100 };
}

/* Price at which selling everything returns the money put in (fees included).
   Optional: feesPaid already spent, sellFee flat or sellFeePct of proceeds. */
export function breakEven({ qty, avgCost, feesPaid = 0, sellFee = 0, sellFeePct = 0 } = {}) {
  qty = num(qty); avgCost = num(avgCost);
  if (!qty || avgCost == null) return null;
  const pct = (num(sellFeePct) || 0) / 100;
  if (pct >= 1) return null;
  return (qty * avgCost + (num(feesPaid) || 0) + (num(sellFee) || 0)) / (qty * (1 - pct));
}

// The asymmetry beginners miss: a 50% loss needs a 100% gain to recover.
export function recoveryGain(lossPct) {
  const l = num(lossPct);
  if (l == null || l >= 100 || l < 0) return null;
  return (1 / (1 - l / 100) - 1) * 100;
}

/* ---- Dividend income ------------------------------------------------------- */
/* events: {[sym]: {dividends:[{exDate, amount}]}} or a function sym -> that.
   forward12m is an ESTIMATE: trailing-12-month dividends per share × current
   qty (provider history when available, else the ledger's own dividends). */
export function dividendIncome(txns, positions, events = null, { today = localToday(), fx = null, baseCurrency = 'USD' } = {}) {
  const rate = makeRate(fx);
  const { list } = prepare(txns, baseCurrency);
  const now = dayNum(today), from = now - 365;
  const missing = new Set();
  let trailing12m = 0;
  const bySym = {};
  for (const t of list) {
    if (t.type !== 'dividend') continue;
    const d = dayNum(t.date);
    if (d <= from || d > now) continue;
    const amount = fin(t.amount) ? t.amount : null;
    if (t.symbol) {
      const s = (bySym[t.symbol] ||= { total: 0, perShare: 0, perShareKnown: true });
      if (amount != null) s.total += amount;
      if (fin(t.price)) s.perShare += t.price; else s.perShareKnown = false;
    }
    if (amount == null) continue;
    const r = rate(t.currency, baseCurrency);
    if (r == null) missing.add(t.currency); else trailing12m += amount * r;
  }
  const evFor = (sym) => { try { return typeof events === 'function' ? events(sym) : events?.[sym]; } catch { return null; } };
  const rows = [];
  let forward12m = 0, costIncluded = 0;
  for (const p of positions || []) {
    if (!(p.qty > 0)) continue;
    let dps = null, source = null;
    const ev = evFor(p.symbol);
    if (ev && Array.isArray(ev.dividends) && ev.dividends.length) {
      const recent = ev.dividends.filter((x) => { const d = dayNum(x.exDate); return d != null && d > from && d <= now && fin(Number(x.amount)); });
      if (recent.length) { dps = recent.reduce((s, x) => s + Number(x.amount), 0); source = 'provider'; }
    }
    if (dps == null && bySym[p.symbol]) {
      const s = bySym[p.symbol];
      dps = s.perShareKnown && s.perShare ? s.perShare : s.total / p.qty;
      source = 'ledger';
    }
    if (dps == null) continue;
    const forward = dps * p.qty;
    const r = rate(p.currency, baseCurrency);
    const forwardBase = r == null ? null : forward * r;
    if (r == null) missing.add(p.currency);
    else { forward12m += forwardBase; costIncluded += (p.costBasis || 0) * r; }
    rows.push({ symbol: p.symbol, account: p.account, dps, forward, forwardBase, source, currency: p.currency,
                yieldOnCost: p.avgCost ? dps / p.avgCost * 100 : null,
                currentYield: fin(p.price) && p.price ? dps / p.price * 100 : null });
  }
  return { trailing12m, forward12m, yieldOnCost: costIncluded ? forward12m / costIncluded * 100 : null,
           rows, currencyMissing: [...missing].sort(), estimate: true };
}

/* ---- Portfolio history ------------------------------------------------------ */
/* Daily value series from the ledger and DAILY bars ({[sym]: Bar[]}). Days are
   the union of the bars' UTC dates from the first dated transaction on; a
   symbol with no bar that day keeps its last close (or its last trade price
   before its first bar). fx(from, to, t) may use t for historical rates.
   flow: external money that day in base currency (+ in) — deposits/withdrawals
   when cash is tracked, otherwise the net cash put into holdings. Feed
   value/flow straight into twr().
   Provider daily bars are split-ADJUSTED (every past close divided by later
   splits) while the ledger holds the share count actually owned on each day, so
   a pre-split day's close is multiplied back by the ratios of the ledger's later
   splits; otherwise a 4:1 split shows as a 75% loss followed by a 300% gain.
   Pass splitAdjusted:false for bars that are raw. */
export function portfolioHistory(txns, barsBySymbol = {}, fx = null, { baseCurrency = 'USD', method = 'fifo', from = null, to = null, splitAdjusted = true } = {}) {
  const rate = makeRate(fx);
  const { list } = prepare(txns, baseCurrency);
  if (!list.length) return [];
  const closes = {};
  const daySet = new Set();
  for (const [sym, bars] of Object.entries(barsBySymbol || {})) {
    const m = new Map();
    for (const b of bars || []) { const d = toDay(b?.t); if (d && fin(b.c)) { m.set(d, b.c); daySet.add(d); } }
    closes[sym] = m;
  }
  const firstDated = list.find((t) => t.date !== MIGRATED_DATE)?.date || null;
  let days = [...daySet].sort();
  const start = toDay(from) || firstDated || days[0];
  const end = toDay(to) || days[days.length - 1];
  days = days.filter((d) => d >= start && d <= end);
  if (!days.length) return [];

  const splits = splitAdjusted ? list.filter((t) => t.type === 'split') : [];
  const unadjust = (sym, day) => {
    let f = 1;
    for (const sp of splits) if (sp.symbol === sym && sp.date > day) f *= sp.ratio;
    return f;
  };
  const book = newBook(method, null);
  const lastClose = {};
  const out = [];
  let i = 0;
  for (const day of days) {
    book.flowExternal = {}; book.flowTrades = {};
    while (i < list.length && list[i].date <= day) applyTxn(book, list[i++]);
    for (const sym of Object.keys(closes)) { const c = closes[sym].get(day); if (c != null) lastClose[sym] = splits.length ? c * unadjust(sym, day) : c; }
    const t = Date.parse(day + 'T00:00:00Z');
    let holdings = 0, cost = 0, cash = 0, partial = false;
    for (const p of book.positions.values()) {
      if (Math.abs(p.qty) <= EPS) continue;
      const r = rate(p.currency, baseCurrency, t);
      const px = lastClose[p.symbol] ?? p.lastPrice;
      if (r == null || px == null) { partial = true; continue; }
      holdings += p.qty * px * r; cost += p.cost * r;
    }
    if (book.cashTracked) for (const [ccy, v] of Object.entries(book.cash)) {
      const r = rate(ccy, baseCurrency, t); if (r == null) partial = true; else cash += v * r;
    }
    const src = book.cashTracked ? book.flowExternal : book.flowTrades;
    let flow = 0;
    for (const [ccy, v] of Object.entries(src)) { const r = rate(ccy, baseCurrency, t); if (r != null) flow += v * r; }
    const row = { t, date: day, value: holdings + cash, holdings, cost, cash, flow };
    if (partial) row.partial = true;
    out.push(row);
  }
  return out;
}
