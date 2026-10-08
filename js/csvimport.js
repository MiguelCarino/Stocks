/* csvimport.js — broker CSV exports -> ledger transactions (Txn[]).

   Nobody types two hundred trades by hand; an import that understands what
   brokers actually export is what makes the ledger usable at all. Everything
   happens in the page: the file is read locally and never leaves the browser.

   Three layers, each usable on its own:
   1. parseCSV(text): RFC 4180 tokenizing with delimiter sniffing (, ; tab),
      BOM stripping, preamble/footer tolerance (Schwab, Fidelity and Coinbase
      all put prose above the header), and Interactive Brokers' multi-section
      activity statement flattened into one table.
   2. BROKER_PRESETS + detectPreset(headers): one entry per broker with the
      column names it is known to use and a row() function that turns a row
      into a Txn, including that broker's sign conventions (negative quantities
      on sells, "($1,000.00)" amounts, "Reinvest Dividend" actions, ...).
   3. mapRows(rows, mapping): runs a preset (or a user's own column mapping)
      over the rows with the file's number and date locale resolved ONCE per
      file: 1.234,56 vs 1,234.56 and DD/MM vs MM/DD are decided from all the
      values in a column, never guessed per cell.

   Presets for brokers whose layout is not publicly documented (GBM+, Bitso)
   are best-effort and say so in `notes`; the preview step is where a user
   confirms the mapping before anything is saved.

   Pure (no DOM, no storage). Imports only portfolio.js for txn validation. */

import { normalizeTxn } from './portfolio.js';

/* ---- Tokenizing ------------------------------------------------------------ */
const DELIMS = [',', ';', '\t', '|'];

// Count delimiters outside quotes on one line.
function countOutside(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/* The delimiter that splits the most lines into the same number of fields.
   Consistency beats raw count: a decimal-comma file split on ',' produces a
   different field count on every line. */
export function detectDelimiter(text) {
  const lines = String(text).split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 30);
  let best = ',', bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutside(l, d)).filter((n) => n > 0);
    if (!counts.length) continue;
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    const [mode, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const score = hits * 1000 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// RFC 4180: quoted fields, "" escapes, newlines inside quotes. Returns records
// with the 1-based line each started on (for error messages users can find).
function tokenize(text, d) {
  const rows = [], lines = [];
  let row = [], field = '', q = false, line = 1, start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    if (c === '"' && field.trim() === '') { field = ''; q = true; }
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); lines.push(start);
      row = []; field = ''; line++; start = line;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); lines.push(start); }
  return { rows, lines };
}

const lc = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const nonEmpty = (r) => r.filter((c) => String(c).trim() !== '').length;

// Blank header cells inherit "<previous> [n]" (Degiro puts each amount's
// currency in an unnamed column right after it); duplicates get " [n]".
function nameHeaders(cells) {
  const seen = new Map(), out = [];
  let prev = 'Column';
  cells.forEach((c, i) => {
    let h = String(c).trim();
    if (!h) h = `${prev} [2]`;
    else prev = h;
    let name = h, k = 2;
    while (seen.has(lc(name))) name = `${h} [${k++}]`;
    seen.set(lc(name), i);
    out.push(name);
  });
  return out;
}

function toObjects(headers, rows, lines, startIdx) {
  const out = [];
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (!nonEmpty(r)) continue;
    const o = {};
    headers.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    Object.defineProperty(o, '_line', { value: lines[i], enumerable: false });
    out.push(o);
  }
  return out;
}

const IBKR_KINDS = new Set(['Header', 'Data', 'Total', 'SubTotal', 'Notes']);

// IBKR activity statement: "Section,Header|Data,..." repeated per section.
// Flattened to one table with a synthetic `_section` column.
function flattenIBKR(rows, lines) {
  const headersBySection = {}, out = [], all = new Set(['_section']);
  rows.forEach((r, i) => {
    const sec = (r[0] || '').trim(), kind = (r[1] || '').trim();
    if (kind === 'Header') { headersBySection[sec] = nameHeaders(r.slice(2)); headersBySection[sec].forEach((h) => all.add(h)); }
    else if (kind === 'Data' && headersBySection[sec]) {
      const o = { _section: sec };
      headersBySection[sec].forEach((h, j) => { o[h] = (r[j + 2] ?? '').trim(); });
      Object.defineProperty(o, '_line', { value: lines[i], enumerable: false });
      out.push(o);
    }
  });
  return { headers: [...all], rows: out };
}

/* parseCSV(text, {delimiter?}) -> {headers, rows (objects keyed by header),
   raw (string[][]), delimiter, headerIndex, preset (detected id or null)}. */
export function parseCSV(text, { delimiter = null } = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const d = delimiter || detectDelimiter(s);
  const { rows: raw, lines } = tokenize(s, d);

  const filled = raw.filter((r) => nonEmpty(r));
  if (filled.length >= 3 && filled.filter((r) => IBKR_KINDS.has((r[1] || '').trim())).length / filled.length > 0.6) {
    const { headers, rows } = flattenIBKR(raw, lines);
    return { headers, rows, raw, delimiter: d, headerIndex: -1, preset: 'ibkr-statement' };
  }

  // Header row: the first one a preset recognizes; else the first row of mostly
  // text cells whose width matches the rows that follow it.
  let headerIndex = -1, preset = null;
  for (let i = 0; i < Math.min(raw.length, 60); i++) {
    if (nonEmpty(raw[i]) < 2) continue;
    const p = detectPreset(raw[i]);
    if (p && p.id !== 'generic') { headerIndex = i; preset = p.id; break; }
    if (p && headerIndex < 0) { headerIndex = i; preset = p.id; break; }
  }
  if (headerIndex < 0) {
    for (let i = 0; i < Math.min(raw.length, 60); i++) {
      const r = raw[i], n = nonEmpty(r);
      if (n < 2) continue;
      const texty = r.filter((c) => c.trim() && parseNumber(c) == null && parseDate(c) == null).length;
      const next = raw.slice(i + 1, i + 4).filter((x) => nonEmpty(x));
      if (texty >= Math.ceil(n * 0.7) && (!next.length || next.some((x) => Math.abs(x.length - r.length) <= 1))) { headerIndex = i; break; }
    }
    if (headerIndex < 0) headerIndex = 0;
  }
  const headers = nameHeaders(raw[headerIndex] || []);
  return { headers, rows: toObjects(headers, raw, lines, headerIndex + 1), raw, delimiter: d, headerIndex, preset };
}

/* ---- Numbers ---------------------------------------------------------------- */
const DATEISH = /^\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

/* decimal: '.' | ',' | 'auto'. Handles currency symbols and codes, NBSP and
   apostrophe grouping (1'234.50), parentheses and trailing minus for
   negatives, and unit suffixes such as Robinhood's "12S". */
export function parseNumber(v, decimal = 'auto') {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim();
  if (!s || /^(-+|—|n\/?a|null|none)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\u00A0\u202F\s']/g, '');
  // a minus anywhere before the first digit ("-$5", "$-5", "USD -5") or trailing ("5-")
  if (/^[^\d.,]*[-−–]/.test(s) || /[-−–]$/.test(s)) { neg = !neg; }
  if (/[eE][-+]?\d+$/.test(s) && /^[-−–]?\d*\.?\d+[eE][-+]?\d+$/.test(s)) {
    const n = Number(s.replace(/^[-−–]/, '')); return Number.isFinite(n) ? (neg ? -n : n) : null;
  }
  s = s.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(s)) return null;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  let dec;
  if (hasDot && hasComma) dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (hasComma) {
    if (decimal === '.') dec = '.';
    else if (decimal === ',') dec = (s.match(/,/g).length > 1) ? '.' : ',';
    else dec = /^\d{1,3}(,\d{3})+$/.test(s) ? '.' : ',';
  } else if (hasDot) {
    if (decimal === ',') dec = (s.match(/\./g).length > 1 || /^\d{1,3}(\.\d{3})+$/.test(s)) ? ',' : '.';
    else dec = (s.match(/\./g).length > 1) ? ',' : '.';
  } else dec = '.';
  const thou = dec === '.' ? ',' : '.';
  s = s.split(thou).join('');
  if (dec === ',') s = s.replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/* Votes across many values: which separator is the DECIMAL one in this file?
   Returns '.', ',' or null when nothing in the data disambiguates. */
export function detectDecimal(values) {
  let dot = 0, comma = 0;
  for (const raw of values || []) {
    const v = String(raw ?? '').trim();
    if (!v || DATEISH.test(v) || /\d:\d/.test(v)) continue;
    const s = v.replace(/[^0-9.,]/g, '');
    if (!/\d/.test(s)) continue;
    const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
    if (dots && commas) { s.lastIndexOf('.') > s.lastIndexOf(',') ? dot++ : comma++; continue; }
    if (commas > 1) { dot++; continue; }
    if (dots > 1) { comma++; continue; }
    if (commas === 1 && !/,\d{3}$/.test(s)) { comma++; continue; }
    if (dots === 1 && !/\.\d{3}$/.test(s)) { dot++; continue; }
  }
  if (dot === comma) return null;
  return dot > comma ? '.' : ',';
}

/* ---- Dates ------------------------------------------------------------------ */
const MONTHS = { jan: 1, ene: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7,
                 aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dic: 12, dez: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const yr = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

function ymd(y, m, d) {
  y = yr(+y); m = +m; d = +d;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;   // 31/02 is not a date
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/* order: 'MDY' | 'DMY' | 'auto' (auto only decides when a part is > 12, and
   otherwise falls back to MDY — callers should resolve order per COLUMN with
   detectDateOrder first). Times and timezone suffixes are ignored; the date is
   taken as written. "08/15/2024 as of 08/14/2024" reads the first date. */
export function parseDate(v, order = 'auto') {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.split(/\s+as of\s+/i)[0];
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/.exec(s))) return ymd(m[1], m[2], m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:$|[;,\sT])/.exec(s))) return ymd(m[1], m[2], m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?![\d])/.exec(s))) {
    const a = +m[1], b = +m[2];
    let o = order;
    if (o !== 'MDY' && o !== 'DMY') o = a > 12 ? 'DMY' : 'MDY';
    return o === 'DMY' ? ymd(m[3], b, a) : ymd(m[3], a, b);
  }
  if ((m = /^(\d{1,2})[\s\-./]+([A-Za-zÀ-ÿ]{3,})\.?[\s\-./,]+(\d{2,4})/.exec(s))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? ymd(m[3], mo, m[1]) : null;
  }
  if ((m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? ymd(m[3], mo, m[2]) : null;
  }
  return null;
}

// 'DMY' | 'MDY' | null (every value is ambiguous, e.g. all days <= 12).
export function detectDateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const raw of values || []) {
    const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(String(raw ?? ''));
    if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dmy++;
    else if (+m[2] > 12 && +m[1] <= 12) mdy++;
  }
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return null;
}

/* ---- Type vocabulary ------------------------------------------------------ */
/* [regex, type] rules on the lower-cased action text, first match wins.
   Pseudo-types resolved by mapRows: 'cash' (deposit or withdraw by the sign of
   the amount), 'sellShort', 'skip:<reason>'. Spanish and Portuguese included. */
const GENERIC_TYPES = [
  [/sell short|short sale|venta en corto/, 'sellShort'],
  [/buy to cover/, 'buy'],
  [/reinvest(ment)? shares?|^reinvestment$/, 'buy'],
  [/\b(buy|bought|purchase|compra|comprar)\b/, 'buy'],
  [/\b(sell|sold|venta|vender|venda)\b/, 'sell'],
  [/withholding|\btax(es)?\b|impuesto|\bisr\b|imposto|retenci[oó]n/, 'tax'],
  [/div/, 'dividend'],
  [/split|desdoblamiento|desdobramento/, 'split'],
  [/interest|inter[eé]s|juros|rendimiento/, 'interest'],
  [/\bfees?\b|commission|comisi[oó]n|taxa|tarifa|corretagem/, 'fee'],
  [/deposit|dep[oó]sito|contribution|aporte|funds received/, 'deposit'],
  [/withdraw|retiro|saque|resgate/, 'withdraw'],
  [/transfer|journal|moneylink|wire|ach\b/, 'cash'],
];
const EXACT = new Set(['buy', 'sell', 'dividend', 'fee', 'split', 'deposit', 'withdraw', 'interest', 'tax']);

export function classifyType(raw, rules = GENERIC_TYPES) {
  const s = lc(raw);
  if (!s) return null;
  if (EXACT.has(s)) return s;
  for (const [re, type] of rules) if (type && re.test(s)) return type;
  return null;
}

/* ---- Presets ---------------------------------------------------------------- */
// Columns whose values are numbers (feed the per-file decimal detection).
const NUMERIC_KEYS = /^(qty|price|amount|fee|fee\d|total|subtotal|net|cost|vol|units|rate|fx|tax|value|principal)$/;

const sym = (s) => String(s || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');

// IBKR: "AAPL(US0378331005) Cash Dividend USD 0.24 per Share" -> AAPL
function symbolFromDescription(desc) {
  const m = /^\s*([A-Z0-9.\-]{1,12})\s*\(/.exec(desc || '') || /^\s*([A-Z0-9.\-]{1,12})\s/.exec(desc || '');
  return m ? m[1] : '';
}

// "4 for 1", "4:1", "4-for-1" -> 4 ; "1 for 10" -> 0.1
function ratioFromText(s) {
  const m = /(\d+(?:\.\d+)?)\s*(?:for|:|-for-|por|para)\s*(\d+(?:\.\d+)?)/i.exec(s || '');
  return m && +m[1] > 0 && +m[2] > 0 ? +m[1] / +m[2] : null;
}

// Kraken asset codes: XXBT -> BTC, ZUSD -> USD, XETH -> ETH, XXDG -> DOGE.
const KRAKEN_ALIAS = { XBT: 'BTC', XDG: 'DOGE' };
function krakenAsset(a) {
  let s = String(a || '').toUpperCase().trim();
  if (s.length === 4 && /^[XZ]/.test(s) && !['USDT', 'USDC', 'DOGE', 'ALGO', 'ATOM', 'LINK', 'MANA', 'GRT'].includes(s)) s = s.slice(1);
  return KRAKEN_ALIAS[s] || s;
}
const KRAKEN_QUOTES = ['ZUSD', 'ZEUR', 'ZGBP', 'ZCAD', 'ZJPY', 'USDT', 'USDC', 'USD', 'EUR', 'GBP', 'CAD', 'JPY', 'CHF', 'AUD', 'XXBT', 'XBT', 'XETH', 'ETH'];
export function krakenPair(pair) {
  const p = String(pair || '').toUpperCase().trim();
  if (p.includes('/')) { const [a, b] = p.split('/'); return [krakenAsset(a), krakenAsset(b)]; }
  for (const q of KRAKEN_QUOTES) if (p.length > q.length && p.endsWith(q)) return [krakenAsset(p.slice(0, -q.length)), krakenAsset(q)];
  return [krakenAsset(p), null];
}

export const BROKER_PRESETS = [
  {
    id: 'generic', label: 'Generic (Carino ledger)',
    match: [['date', 'type', 'symbol'], ['date', 'type', 'amount']],
    columns: { date: ['date'], type: ['type', 'action'], symbol: ['symbol', 'ticker'], qty: ['qty', 'quantity', 'shares', 'units'],
               price: ['price'], amount: ['amount', 'total'], fee: ['fee', 'fees', 'commission'], currency: ['currency', 'ccy'],
               account: ['account'], note: ['note', 'notes', 'description'], ratio: ['ratio'] },
    row(h) {
      const r = genericRow(h, GENERIC_TYPES);
      // Our own export writes an explicit short sale as a negative sell quantity.
      if (r.type === 'sell' && r.qty < 0) r.type = 'sellShort';
      return r;
    },
  },
  {
    id: 'ibkr-flex', label: 'Interactive Brokers (Flex Query trades)',
    match: [['tradedate', 'quantity', 'tradeprice'], ['symbol', 'quantity', 'tradeprice', 'currencyprimary']],
    columns: { date: ['tradedate', 'datetime', 'date/time'], symbol: ['symbol'], qty: ['quantity'], price: ['tradeprice'],
               fee: ['ibcommission', 'commission'], currency: ['currencyprimary', 'currency'], type: ['buy/sell'],
               account: ['clientaccountid', 'accountid'], asset: ['assetclass'], note: ['description'], amount: ['netcash'] },
    dateOrder: 'MDY',
    row(h) {
      const asset = lc(h.get('asset'));
      if (asset && !['stk', 'crypto', 'etf', 'fund'].includes(asset)) return { skip: `Asset class ${h.get('asset')} is not supported` };
      const q = h.num('qty');
      const bs = lc(h.get('type'));
      return { date: h.date('date'), type: bs.startsWith('sell') || (!bs && q < 0) ? 'sell' : 'buy',
               symbol: h.get('symbol'), qty: q, price: h.num('price'), fee: h.num('fee'),
               currency: h.get('currency'), account: h.get('account'), note: h.get('note') };
    },
  },
  {
    id: 'ibkr-statement', label: 'Interactive Brokers (Activity Statement)',
    match: [['_section']],
    columns: { date: ['date/time', 'date', 'settle date'], symbol: ['symbol'], qty: ['quantity'], price: ['t. price'],
               fee: ['comm/fee', 'comm in usd'], currency: ['currency'], amount: ['amount', 'proceeds'], note: ['description'],
               asset: ['asset category'], disc: ['datadiscriminator'] },
    dateOrder: 'MDY',
    notes: ['Reads the Trades, Dividends, Withholding Tax, Deposits & Withdrawals, Fees, Interest and Corporate Actions sections.'],
    row(h) {
      const sec = h.raw._section, cur = h.get('currency');
      if (/^total/i.test(cur) || /^total/i.test(h.get('asset'))) return null;
      const desc = h.get('note');
      switch (sec) {
        case 'Trades': {
          const disc = h.get('disc');
          if (disc && !/^(order|trade)$/i.test(disc)) return null;
          const ac = lc(h.get('asset'));
          if (/forex/.test(ac)) return { skip: 'Currency conversion' };
          if (/option|future|bond|warrant|cfd/.test(ac)) return { skip: `${h.get('asset')} are not supported` };
          const q = h.num('qty');
          return { date: h.date('date'), type: q < 0 ? 'sell' : 'buy', symbol: h.get('symbol'), qty: q,
                   price: h.num('price'), fee: h.num('fee'), currency: cur };
        }
        case 'Dividends':
          return { date: h.date('date'), type: 'dividend', symbol: symbolFromDescription(desc), amount: h.num('amount'), currency: cur, note: desc };
        case 'Withholding Tax':
          return { date: h.date('date'), type: 'tax', symbol: symbolFromDescription(desc), amount: -h.num('amount'), currency: cur, note: desc, signed: true };
        case 'Deposits & Withdrawals':
          return { date: h.date('date'), type: 'cash', amount: h.num('amount'), currency: cur, note: desc };
        case 'Fees':
          return { date: h.date('date'), type: 'fee', amount: -h.num('amount'), currency: cur, note: desc, signed: true };
        case 'Interest':
          return { date: h.date('date'), type: 'interest', amount: h.num('amount'), currency: cur, note: desc };
        case 'Corporate Actions': {
          const r = /split/i.test(desc) ? ratioFromText(desc) : null;
          if (!r) return { skip: 'Corporate action other than a split' };
          return { date: h.date('date'), type: 'split', symbol: symbolFromDescription(desc), ratio: r, currency: cur, note: desc };
        }
        default: return null;
      }
    },
  },
  {
    id: 'schwab', label: 'Charles Schwab',
    match: [['date', 'action', 'symbol', 'quantity', 'fees & comm', 'amount']],
    columns: { date: ['date'], type: ['action'], symbol: ['symbol'], note: ['description'], qty: ['quantity'],
               price: ['price'], fee: ['fees & comm'], amount: ['amount'] },
    dateOrder: 'MDY', currency: 'USD',
    types: [
      [/sell short/, 'sellShort'], [/buy to cover/, 'buy'], [/reinvest shares|^buy/, 'buy'], [/^sell/, 'sell'],
      [/margin interest/, 'fee'], [/foreign tax|nra tax|nra withholding|tax withh/, 'tax'],
      [/reinvest dividend|dividend|div\b|cap gain|qual/, 'dividend'], [/interest/, 'interest'],
      [/stock split/, 'split'], [/cash in lieu/, 'skip:Cash in lieu'], [/fee/, 'fee'],
      [/moneylink|wire|journal|transfer|deposit|funds/, 'cash'],
    ],
    row(h, p) {
      if (/total/i.test(h.get('date'))) return null;
      const type = classifyType(h.get('type'), p.types);
      const r = genericRow(h, p.types, type);
      if (type === 'split') { r.addedQty = h.num('qty'); r.ratio = ratioFromText(h.get('note')); }
      return r;
    },
  },
  {
    id: 'fidelity', label: 'Fidelity',
    match: [['run date', 'action', 'symbol', 'quantity']],
    columns: { date: ['run date'], type: ['action'], symbol: ['symbol'], note: ['description', 'security description'],
               qty: ['quantity'], price: ['price ($)', 'price'], fee: ['commission ($)', 'commission'], fee2: ['fees ($)', 'fees'],
               amount: ['amount ($)', 'amount'], account: ['account', 'account name'], currency: ['currency'] },
    dateOrder: 'MDY', currency: 'USD',
    types: [
      [/short sale|sold short/, 'sellShort'], [/bought to cover/, 'buy'], [/you bought|reinvestment|^buy/, 'buy'], [/you sold|^sell/, 'sell'],
      [/foreign tax|tax withheld|withholding/, 'tax'], [/dividend|cap gain/, 'dividend'], [/interest/, 'interest'],
      [/split/, 'split'], [/fee|commission/, 'fee'],
      [/electronic funds transfer|transferred|contribution|direct deposit|deposit|withdrawal|check|wire|journal/, 'cash'],
    ],
    row(h, p) {
      if (!h.get('date') || !h.date('date')) return null;   // trailing disclaimer lines
      const type = classifyType(h.get('type'), p.types);
      const r = genericRow(h, p.types, type);
      r.fee = (h.num('fee') || 0) + (h.num('fee2') || 0);
      if (type === 'split') { r.addedQty = h.num('qty'); r.ratio = ratioFromText(h.get('type')); }
      return r;
    },
  },
  {
    id: 'vanguard', label: 'Vanguard',
    match: [['trade date', 'transaction type', 'symbol', 'shares', 'share price']],
    columns: { date: ['trade date'], type: ['transaction type'], note: ['transaction description', 'investment name'],
               symbol: ['symbol'], qty: ['shares'], price: ['share price'], amount: ['net amount', 'principal amount'],
               fee: ['commission fees', 'commissions and fees', 'commission'], account: ['account number'] },
    dateOrder: 'MDY', currency: 'USD',
    types: [
      [/^reinvestment|^buy/, 'buy'], [/^sell/, 'sell'], [/capital gain|dividend/, 'dividend'], [/interest/, 'interest'],
      [/sweep/, 'skip:Money-market sweep'], [/split/, 'split'], [/fee/, 'fee'], [/withholding|tax/, 'tax'],
      [/funds received|contribution|deposit/, 'deposit'], [/withdrawal|distribution/, 'withdraw'],
      [/transfer|conversion/, 'cash'], [/corp action|exchange/, 'skip:Corporate action'],
    ],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      const r = genericRow(h, p.types, type);
      if (type === 'split') { r.addedQty = h.num('qty'); r.ratio = ratioFromText(h.get('note')); }
      return r;
    },
  },
  {
    id: 'robinhood', label: 'Robinhood',
    match: [['activity date', 'instrument', 'trans code', 'quantity', 'amount']],
    columns: { date: ['activity date'], symbol: ['instrument'], note: ['description'], type: ['trans code'],
               qty: ['quantity'], price: ['price'], amount: ['amount'] },
    dateOrder: 'MDY', currency: 'USD',
    codes: { buy: 'buy', sell: 'sell', cdiv: 'dividend', mdiv: 'dividend', dtax: 'tax', ach: 'cash', rtp: 'cash',
             int: 'interest', slip: 'interest', mint: 'interest', gold: 'fee', afee: 'fee', dfee: 'fee', spl: 'split',
             spr: 'split', rec: 'skip:Share transfer', acati: 'skip:Account transfer', acato: 'skip:Account transfer',
             conv: 'skip:Conversion', bto: 'skip:Options are not supported', stc: 'skip:Options are not supported',
             sto: 'skip:Options are not supported', btc: 'skip:Options are not supported', oexp: 'skip:Options are not supported',
             oasgn: 'skip:Options are not supported', oexcs: 'skip:Options are not supported', futswp: 'skip:Futures sweep' },
    row(h, p) {
      const code = lc(h.get('type'));
      if (!code && !h.date('date')) return null;    // trailing disclaimer
      const type = p.codes[code] || classifyType(code) || (code ? `skip:Unknown code ${h.get('type')}` : null);
      const r = genericRow(h, GENERIC_TYPES, type);
      if (type === 'split') { r.addedQty = h.num('qty'); r.ratio = ratioFromText(h.get('note')); }
      return r;
    },
  },
  {
    id: 'etoro', label: 'eToro (account activity)',
    match: [['date', 'type', 'details', 'amount', 'units']],
    columns: { date: ['date'], type: ['type'], details: ['details'], amount: ['amount'], units: ['units'],
               note: ['position id'], asset: ['asset type'] },
    dateOrder: 'DMY', currency: 'USD',
    notes: ['eToro reports amounts in USD and does not distinguish real shares from CFDs here; short (sell) CFD positions are imported as long positions — review them.'],
    types: [
      [/adjustment|corp action|cancel|edit stop/, 'skip:Adjustment'],
      [/open position/, 'buy'], [/position closed/, 'sell'], [/dividend/, 'dividend'], [/deposit/, 'deposit'],
      [/fee|sdrt|tax/, 'fee'], [/withdraw/, 'withdraw'], [/interest|staking/, 'interest'],
    ],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      const symbol = (h.get('details').split('/')[0] || '').trim();
      const amount = h.num('amount'), units = h.num('units');
      if (type === 'buy' || type === 'sell') {
        if (!units) return { error: 'Trade without units' };
        return { date: h.date('date'), type, symbol, qty: units, price: Math.abs(amount) / Math.abs(units), currency: 'USD', note: h.get('note') ? `eToro position ${h.get('note')}` : '' };
      }
      return { date: h.date('date'), type: type || `skip:${h.get('type')}`, symbol: type === 'dividend' ? symbol : '', amount, currency: 'USD' };
    },
  },
  {
    id: 'trading212', label: 'Trading 212',
    match: [['action', 'time', 'ticker', 'no. of shares', 'price / share']],
    columns: { type: ['action'], date: ['time'], symbol: ['ticker'], qty: ['no. of shares'], price: ['price / share'],
               currency: ['currency (price / share)'], fx: ['exchange rate'], total: ['total'], totalCcy: ['currency (total)'],
               tax: ['withholding tax'], taxCcy: ['currency (withholding tax)'],
               fee: ['currency conversion fee'], fee2: ['stamp duty reserve tax', 'stamp duty'], fee3: ['transaction fee'],
               fee4: ['french transaction tax'], fee5: ['finra fee'], note: ['name'], id: ['id'] },
    types: [
      [/buy/, 'buy'], [/sell/, 'sell'], [/dividend/, 'dividend'], [/deposit/, 'deposit'], [/withdrawal/, 'withdraw'],
      [/interest/, 'interest'], [/currency conversion/, 'skip:Currency conversion'], [/stock split/, 'skip:Stock split rows (check share counts)'],
    ],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      const ccy = h.get('currency') || h.get('totalCcy');
      if (type === 'buy' || type === 'sell') {
        // Fees are charged in the ACCOUNT currency; "Exchange rate" is how many
        // instrument-currency units one account-currency unit bought.
        let fee = ['fee', 'fee2', 'fee3', 'fee4', 'fee5'].reduce((s, k) => s + Math.abs(h.num(k) || 0), 0);
        const fx = h.num('fx');
        if (fee && h.get('totalCcy') && h.get('totalCcy') !== ccy && fx) fee *= fx;
        return { date: h.date('date'), type, symbol: h.get('symbol'), qty: h.num('qty'), price: h.num('price'), fee, currency: ccy, note: h.get('note') };
      }
      if (type === 'dividend') {
        const out = [{ date: h.date('date'), type, symbol: h.get('symbol'), amount: (h.num('qty') || 0) * (h.num('price') || 0), currency: ccy, note: h.get('note') }];
        const tax = Math.abs(h.num('tax') || 0);
        if (tax) out.push({ date: h.date('date'), type: 'tax', symbol: h.get('symbol'), amount: tax, currency: h.get('taxCcy') || ccy, signed: true, note: 'Withholding tax' });
        return out;
      }
      return { date: h.date('date'), type: type || `skip:${h.get('type')}`, amount: h.num('total'), currency: h.get('totalCcy') || ccy };
    },
  },
  {
    id: 'degiro', label: 'Degiro (transactions)',
    match: [['date', 'product', 'isin', 'quantity', 'price'], ['fecha', 'producto', 'isin', 'número'], ['datum', 'product', 'isin', 'aantal']],
    columns: { date: ['date', 'fecha', 'datum'], symbol: ['isin'], note: ['product', 'producto'], qty: ['quantity', 'número', 'numero', 'aantal'],
               price: ['price', 'precio', 'koers'], currency: ['price [2]', 'precio [2]', 'koers [2]'],
               fee: ['transaction and/or third', 'transaction and/or third party fees', 'transaction costs', 'costes de transacción', 'transactiekosten en/of kosten van derden'],
               feeCcy: ['transaction and/or third [2]', 'transaction and/or third party fees [2]', 'transaction costs [2]', 'costes de transacción [2]', 'transactiekosten en/of kosten van derden [2]'],
               fx: ['exchange rate', 'tipo de cambio', 'wisselkoers'], id: ['order id', 'id orden'] },
    dateOrder: 'DMY',
    notes: ['Degiro exports the ISIN, not the ticker: symbols are imported as ISINs — rename them to the ticker you watch.',
            'Dividends are in the separate Account Statement export, which this preset does not read.'],
    row(h) {
      const q = h.num('qty');
      const ccy = h.get('currency');
      let fee = Math.abs(h.num('fee') || 0);
      const fx = h.num('fx');
      if (fee && h.get('feeCcy') && ccy && h.get('feeCcy') !== ccy && fx) fee *= fx;
      return { date: h.date('date'), type: q < 0 ? 'sell' : 'buy', symbol: h.get('symbol'), qty: q, price: h.num('price'),
               fee, currency: ccy, note: h.get('note') };
    },
  },
  {
    id: 'gbm', label: 'GBM+ (México)',
    match: [['fecha', 'emisora', 'títulos'], ['fecha', 'emisora', 'titulos'], ['fecha', 'emisora', 'operación'], ['fecha de operación', 'emisora']],
    columns: { date: ['fecha', 'fecha de operación', 'fecha operación', 'fecha de operacion'], symbol: ['emisora'], serie: ['serie'],
               type: ['operación', 'operacion', 'tipo de operación', 'tipo', 'movimiento', 'concepto'],
               qty: ['títulos', 'titulos', 'cantidad'], price: ['precio', 'precio unitario', 'precio promedio'],
               amount: ['importe', 'monto', 'neto', 'importe neto'], fee: ['comisión', 'comision'], fee2: ['iva'] },
    dateOrder: 'DMY', currency: 'MXN',
    notes: ['GBM+ does not publish its export layout; this mapping is best-effort — check the preview.',
            'Tickers are imported as EMISORA+SERIE (e.g. AMXB); add the exchange suffix your data provider expects.'],
    types: [
      [/compra/, 'buy'], [/venta/, 'sell'], [/isr|retenci|impuesto/, 'tax'], [/dividendo/, 'dividend'],
      [/inter[eé]s|rendimiento/, 'interest'], [/comisi/, 'fee'], [/split|canje/, 'split'],
      [/dep[oó]sito|abono|entrada/, 'deposit'], [/retiro|salida/, 'withdraw'],
    ],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      const serie = h.get('serie').trim();
      const symbol = h.get('symbol').trim() + (serie && serie !== '*' ? serie : '');
      const r = genericRow(h, p.types, type);
      r.symbol = symbol;
      r.fee = Math.abs(h.num('fee') || 0) + Math.abs(h.num('fee2') || 0);
      if (type === 'split') { r.addedQty = h.num('qty'); }
      return r;
    },
  },
  {
    id: 'bitso', label: 'Bitso',
    match: [['book', 'side', 'price'], ['libro', 'tipo', 'precio'], ['type', 'major', 'minor', 'rate']],
    columns: { date: ['date', 'created_at', 'fecha'], book: ['book', 'libro'], type: ['side', 'type', 'tipo'],
               major: ['major', 'amount', 'cantidad'], minor: ['minor', 'value', 'total', 'valor'], price: ['price', 'rate', 'precio'],
               fee: ['fee', 'fees', 'comisión', 'comision'], feeCcy: ['fee_currency', 'fee currency', 'moneda comisión'],
               majorCcy: ['major_currency', 'currency', 'moneda'], minorCcy: ['minor_currency'], amount: ['amount', 'monto'] },
    notes: ['Bitso does not publish a stable export layout; this mapping is best-effort — check the preview.',
            'Crypto funding/withdrawals are transfers without a cost basis and are skipped.'],
    types: [[/buy|compra/, 'buy'], [/sell|venta/, 'sell'], [/funding|fondeo|dep[oó]sito/, 'deposit'], [/withdrawal|retiro/, 'withdraw']],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      let base = h.get('majorCcy'), quote = h.get('minorCcy');
      const book = h.get('book');
      if (book && /[_\-/]/.test(book)) [base, quote] = book.toUpperCase().split(/[_\-/]/);
      base = sym(base); quote = sym(quote) || 'MXN';
      if (type === 'buy' || type === 'sell') {
        const price = h.num('price'), qty = Math.abs(h.num('major') || 0);
        let fee = Math.abs(h.num('fee') || 0);
        // A buy's fee is usually taken in the coin received: price it in the quote currency.
        if (fee && sym(h.get('feeCcy')) === base && price) fee *= price;
        return { date: h.date('date'), type, symbol: base, qty, price: price ?? (Math.abs(h.num('minor') || 0) / qty), fee, currency: quote };
      }
      if (type === 'deposit' || type === 'withdraw') {
        const ccy = sym(h.get('majorCcy') || base);
        if (!/^(MXN|USD|ARS|BRL|COP|EUR)$/.test(ccy)) return { skip: `Crypto ${type === 'deposit' ? 'funding' : 'withdrawal'} (transfer)` };
        return { date: h.date('date'), type, amount: Math.abs(h.num('amount') ?? h.num('major') ?? 0), currency: ccy };
      }
      return { skip: h.get('type') || 'Unknown row' };
    },
  },
  {
    id: 'coinbase', label: 'Coinbase',
    match: [['timestamp', 'transaction type', 'asset', 'quantity transacted']],
    columns: { date: ['timestamp'], type: ['transaction type'], symbol: ['asset'], qty: ['quantity transacted'],
               currency: ['spot price currency', 'price currency'], price: ['spot price at transaction', 'price at transaction'],
               subtotal: ['subtotal'], total: ['total (inclusive of fees and/or spread)', 'total (inclusive of fees)'],
               fee: ['fees and/or spread', 'fees'], note: ['notes'] },
    types: [
      [/sell/, 'sell'], [/buy/, 'buy'], [/convert/, 'convert'],
      [/reward|staking|earn|interest|learning|inflation/, 'income'],
      [/^deposit/, 'deposit'], [/^withdrawal/, 'withdraw'], [/send|receive|transfer/, 'skip:Transfer between wallets'],
    ],
    notes: ['Staking and rewards income is booked as interest plus a buy at the spot price (cost basis = value received).'],
    row(h, p) {
      const type = classifyType(h.get('type'), p.types);
      const ccy = h.get('currency') || 'USD';
      const asset = sym(h.get('symbol')), qty = Math.abs(h.num('qty') || 0), price = h.num('price');
      const date = h.date('date'), fee = Math.abs(h.num('fee') || 0);
      if (type === 'buy' || type === 'sell') return { date, type, symbol: asset, qty, price, fee, currency: ccy, note: h.get('note') };
      if (type === 'income') {
        if (!price) return { skip: 'Income without a spot price' };
        return [{ date, type: 'interest', amount: qty * price, currency: ccy, note: `${h.get('type')} ${asset}` },
                { date, type: 'buy', symbol: asset, qty, price, fee: 0, currency: ccy, note: h.get('type') }];
      }
      if (type === 'convert') {
        const m = /converted\s+([\d.,]+)\s+([A-Z0-9]+)\s+to\s+([\d.,]+)\s+([A-Z0-9]+)/i.exec(h.get('note'));
        if (!m) return { error: 'Convert row without "Converted X A to Y B" notes' };
        const toQty = parseNumber(m[3], '.'), toSym = m[4].toUpperCase();
        const value = (h.num('subtotal') ?? qty * price);
        return [{ date, type: 'sell', symbol: asset, qty, price, fee, currency: ccy, note: 'Convert' },
                { date, type: 'buy', symbol: toSym, qty: toQty, price: toQty ? value / toQty : 0, fee: 0, currency: ccy, note: 'Convert' }];
      }
      if (type === 'deposit' || type === 'withdraw') {
        if (asset !== ccy && !/^(USD|EUR|GBP|CAD)$/.test(asset)) return { skip: 'Crypto transfer' };
        return { date, type, amount: h.num('total') ?? h.num('subtotal') ?? qty, currency: asset };
      }
      return { skip: type?.startsWith('skip:') ? type.slice(5) : (h.get('type') || 'Unknown row') };
    },
  },
  {
    id: 'kraken', label: 'Kraken (trades.csv)',
    match: [['txid', 'pair', 'time', 'type', 'price', 'cost', 'fee', 'vol']],
    columns: { date: ['time'], pair: ['pair'], type: ['type'], price: ['price'], cost: ['cost'], fee: ['fee'], qty: ['vol'], id: ['txid'] },
    notes: ['Reads trades.csv. Deposits, withdrawals and staking live in ledgers.csv, which this preset does not read.'],
    row(h) {
      const [base, quote] = krakenPair(h.get('pair'));
      const t = lc(h.get('type'));
      if (t !== 'buy' && t !== 'sell') return { skip: h.get('type') };
      return { date: h.date('date'), type: t, symbol: base, qty: Math.abs(h.num('qty') || 0), price: h.num('price'),
               fee: Math.abs(h.num('fee') || 0), currency: quote || 'USD', note: h.get('id') ? `Kraken ${h.get('id')}` : '' };
    },
  },
];

const PRESET_BY_ID = Object.fromEntries(BROKER_PRESETS.map((p) => [p.id, p]));

/* The most specific preset whose required headers are all present (generic
   last, as the fallback). Returns the preset object or null. */
export function detectPreset(headers) {
  const set = new Set((headers || []).map(lc));
  const ok = (p) => p.match.some((need) => need.every((n) => set.has(n)));
  return BROKER_PRESETS.find((p) => p.id !== 'generic' && ok(p)) || (ok(PRESET_BY_ID.generic) ? PRESET_BY_ID.generic : null);
}

/* A row of a generic table. type may be pre-classified by the caller. */
function genericRow(h, rules, preType) {
  const rawType = h.get('type');
  let type = preType !== undefined ? preType : classifyType(rawType, rules);
  const qty = h.num('qty'), amount = h.num('amount');
  if (!type && !rawType) type = qty != null && qty !== 0 ? (qty < 0 ? 'sell' : 'buy') : amount != null ? 'cash' : null;
  if (!type && rawType) type = `skip:Unrecognized action "${rawType}"`;
  return { date: h.date('date'), type, symbol: h.get('symbol'), qty, price: h.num('price'), amount,
           fee: h.num('fee'), currency: h.get('currency'), account: h.get('account'), note: h.get('note'),
           ratio: h.has('ratio') ? h.get('ratio') : undefined };
}

/* A user's own mapping: {columns: {date: 'Header', type: 'Header', ...},
   typeMap?: {'their action text': 'buy'|...}, dateOrder?, decimal?, currency?} */
function customPreset(m) {
  const columns = {};
  for (const [k, v] of Object.entries(m.columns || {})) if (v) columns[k] = Array.isArray(v) ? v : [v];
  const extra = Object.entries(m.typeMap || {}).map(([raw, t]) => [new RegExp(`^${lc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), t]);
  return { id: 'custom', label: 'Custom mapping', columns, dateOrder: m.dateOrder, decimal: m.decimal, currency: m.currency,
           row: (h) => genericRow(h, [...extra, ...GENERIC_TYPES]) };
}

/* ---- Fingerprints and dedupe ------------------------------------------------ */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const rnd = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(Number(v).toFixed(d)) : '');

export function txnFingerprint(t) {
  return [t.date, t.type, t.symbol || '', rnd(t.qty, 8), rnd(t.price, 6), rnd(t.amount, 2), t.account || ''].join('|');
}

/* Identical rows can be legitimate (two equal buys the same day), so each
   fingerprint is counted: the Nth copy is a duplicate only if the ledger
   already holds N copies. */
export function dedupe(existing, incoming) {
  const have = new Map();
  for (const t of existing || []) { const f = txnFingerprint(t); have.set(f, (have.get(f) || 0) + 1); }
  const fresh = [], duplicates = [];
  for (const t of incoming || []) {
    const f = txnFingerprint(t), n = have.get(f) || 0;
    if (n > 0) { duplicates.push(t); have.set(f, n - 1); } else fresh.push(t);
  }
  return { fresh, duplicates };
}

/* ---- mapRows ------------------------------------------------------------------ */
/* mapping: a preset object, a preset id, or a custom mapping (see customPreset).
   opts: {decimal, dateOrder, currency, account} override the detected values.
   -> {txns, errors:[{row, line, message}], skipped:[{row, line, reason}],
       warnings: string[], locale: {decimal, dateOrder}, preset} */
export function mapRows(rows, mapping, opts = {}) {
  const preset = typeof mapping === 'string' ? PRESET_BY_ID[mapping] : mapping?.row ? mapping : customPreset(mapping || {});
  if (!preset) return { txns: [], errors: [{ row: 0, message: `Unknown preset "${mapping}"` }], skipped: [], warnings: [], locale: {}, preset: null };
  rows = rows || [];
  const warnings = [...(preset.notes || [])];

  // Resolve every column key to the headers present, in preference order. A
  // row reads the first of them that is non-empty (IBKR sections each name
  // their date column differently).
  const headerSet = new Map();
  for (const r of rows) for (const k of Object.keys(r)) if (!headerSet.has(lc(k))) headerSet.set(lc(k), k);
  const col = {};
  for (const [key, alts] of Object.entries(preset.columns || {})) {
    const hits = alts.map(lc).filter((a) => headerSet.has(a)).map((a) => headerSet.get(a));
    if (hits.length) col[key] = hits;
  }
  const cell = (r, k) => {
    for (const hd of col[k] || []) { const v = r[hd]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
    return '';
  };

  // Locale, decided per file.
  const numericVals = [];
  for (const key of Object.keys(col)) if (NUMERIC_KEYS.test(key)) for (const r of rows) numericVals.push(cell(r, key));
  const decimal = opts.decimal || preset.decimal || detectDecimal(numericVals) || '.';
  const dateVals = col.date ? rows.map((r) => cell(r, 'date')) : [];
  const detectedOrder = detectDateOrder(dateVals);
  const dateOrder = opts.dateOrder || detectedOrder || preset.dateOrder || 'MDY';
  if (!opts.dateOrder && !detectedOrder && !preset.dateOrder && dateVals.some((v) => /^\s*\d{1,2}[-/.]\d{1,2}[-/.]/.test(v || '')))
    warnings.push(`Day/month order is ambiguous in this file; assumed ${dateOrder === 'MDY' ? 'month/day/year' : 'day/month/year'}.`);
  if (opts.dateOrder === undefined && detectedOrder && preset.dateOrder && detectedOrder !== preset.dateOrder)
    warnings.push(`Dates look like ${detectedOrder === 'DMY' ? 'day/month/year' : 'month/day/year'}, not this broker's usual order.`);

  const txns = [], errors = [], skipped = [];
  const defCcy = (opts.currency || preset.currency || 'USD').toUpperCase();
  const seen = new Map();

  rows.forEach((raw, i) => {
    const rowNo = i + 1, line = raw._line;
    const h = {
      raw,
      has: (k) => !!col[k],
      get: (k) => cell(raw, k),
      num: (k) => parseNumber(cell(raw, k), decimal),
      date: (k) => parseDate(cell(raw, k), dateOrder),
    };
    let out;
    try { out = preset.row(h, preset); } catch (e) { errors.push({ row: rowNo, line, message: String(e?.message || e) }); return; }
    if (out == null) return;
    for (const r of Array.isArray(out) ? out : [out]) {
      if (r.error) { errors.push({ row: rowNo, line, message: r.error }); continue; }
      if (r.skip) { skipped.push({ row: rowNo, line, reason: r.skip }); continue; }
      const t = finishTxn(r, { defCcy, account: opts.account });
      if (t.skip) { skipped.push({ row: rowNo, line, reason: t.skip }); continue; }
      if (t.error) { errors.push({ row: rowNo, line, message: t.error }); continue; }
      const f = txnFingerprint(t), n = (seen.get(f) || 0) + 1;
      seen.set(f, n);
      t.id = `imp-${hash32(`${f}#${n}`)}`;
      t._row = rowNo;
      txns.push(t);
    }
  });

  resolveSplits(txns, errors);
  for (const t of txns) delete t._row;
  return { txns, errors, skipped, warnings, locale: { decimal, dateOrder }, preset: preset.id };
}

// Sign conventions -> the ledger's (positive quantities, type says direction).
function finishTxn(r, { defCcy, account }) {
  let type = r.type;
  if (!type) return { error: 'Could not tell what kind of transaction this is' };
  if (type.startsWith('skip:')) return { skip: type.slice(5) };
  const t = { date: r.date, type, currency: sym(r.currency) || defCcy };
  if (!t.date) return { error: 'Missing or unreadable date' };
  if (r.symbol) t.symbol = sym(r.symbol);
  if (account || r.account) t.account = String(account || r.account);
  if (r.note) t.note = String(r.note).slice(0, 200);
  const qty = r.qty != null ? Math.abs(r.qty) : null;
  const amount = r.amount ?? null;
  const fee = Math.abs(r.fee || 0);

  if (type === 'cash') {
    if (amount == null || amount === 0) return { skip: 'Zero-amount transfer' };
    t.type = amount > 0 ? 'deposit' : 'withdraw';
    t.amount = Math.abs(amount);
  } else if (type === 'buy' || type === 'sell' || type === 'sellShort') {
    if (type === 'sellShort') { t.type = 'sell'; t.short = true; }
    t.qty = qty;
    let price = r.price != null ? Math.abs(r.price) : null;
    if ((price == null || price === 0) && amount != null && qty) {
      price = t.type === 'buy' ? (Math.abs(amount) - fee) / qty : (Math.abs(amount) + fee) / qty;
    }
    t.price = price;
    t.fee = fee;
    if (t.short) t.qty = -qty;   // portfolio.normalizeTxn reads a negative sell as an explicit short
  } else if (type === 'split') {
    const ratio = r.ratio != null && r.ratio !== '' ? r.ratio : null;
    if (ratio != null) t.ratio = ratio;
    else if (r.addedQty != null) t._added = r.addedQty;
    else return { error: 'Split without a ratio' };
  } else if (type === 'dividend' || type === 'interest') {
    t.amount = amount;
    if (r.price != null && type === 'dividend' && amount == null) { t.price = r.price; if (qty) t.qty = qty; }
    if (fee) t.fee = fee;
  } else if (type === 'fee' || type === 'tax') {
    // Brokers print money leaving the account as negative. `signed` rows have
    // already been flipped to "positive = paid" by their preset.
    t.amount = r.signed ? amount : (amount == null ? null : Math.abs(amount));
    if (t.amount == null && fee) t.amount = fee;
  } else if (type === 'deposit' || type === 'withdraw') {
    t.amount = amount == null ? null : Math.abs(amount);
  } else return { error: `Unknown type "${type}"` };

  if (t._added != null) return t;   // validated after resolveSplits
  const v = normalizeTxn(t, defCcy);
  if (v.error) return { error: v.error };
  // keep the import's own shape (normalizeTxn adds empty fields)
  const clean = {};
  for (const [k, val] of Object.entries(v.txn)) if (val !== undefined && val !== null && val !== '' && !(k === 'fee' && !val && t.type !== 'buy' && t.type !== 'sell')) clean[k] = val;
  if (clean.short) { clean.qty = Math.abs(clean.qty); }
  // Derived values (price = amount / units, fee × fx) carry float dust.
  for (const k of ['qty', 'price', 'amount', 'fee', 'ratio']) if (typeof clean[k] === 'number') clean[k] = +clean[k].toPrecision(12);
  return clean;
}

/* Brokers report a split as "N additional shares received", not as a ratio.
   Replay the imported trades to know the holding, then ratio = (held+N)/held. */
function resolveSplits(txns, errors) {
  if (!txns.some((t) => t._added != null)) return;
  const order = txns.map((t, i) => ({ t, i })).sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i));
  const held = new Map();
  const drop = new Set();
  for (const { t } of order) {
    const key = `${t.account || ''}|${t.symbol}`;
    if (t.type === 'buy') held.set(key, (held.get(key) || 0) + Math.abs(t.qty));
    else if (t.type === 'sell') held.set(key, (held.get(key) || 0) - Math.abs(t.qty));
    else if (t.type === 'split') {
      const h = held.get(key) || 0;
      if (t._added != null) {
        if (h <= 0) { errors.push({ row: t._row, message: `Split for ${t.symbol}: no shares held before it in this file, enter the ratio manually` }); drop.add(t); continue; }
        t.ratio = +((h + t._added) / h).toPrecision(10);
        delete t._added;
      }
      held.set(key, h * Number(t.ratio));
    }
  }
  for (let i = txns.length - 1; i >= 0; i--) if (drop.has(txns[i])) txns.splice(i, 1);
}

/* ---- Export (the generic preset reads this back) ---------------------------- */
const EXPORT_COLS = ['date', 'type', 'symbol', 'qty', 'price', 'amount', 'fee', 'currency', 'ratio', 'account', 'note'];
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(txns) {
  const lines = [EXPORT_COLS.join(',')];
  for (const t of txns || []) {
    const row = { ...t };
    if (t.type === 'sell' && t.short) row.qty = -Math.abs(t.qty);
    lines.push(EXPORT_COLS.map((k) => csvCell(row[k])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/* One call for the common path: text -> preview-ready result. */
export function importCSV(text, { preset = null, ...opts } = {}) {
  const parsed = parseCSV(text);
  const chosen = preset || parsed.preset || detectPreset(parsed.headers)?.id || null;
  if (!chosen) return { ...parsed, txns: [], errors: [{ row: 0, message: 'Unrecognized file: map the columns manually' }], skipped: [], warnings: [], preset: null };
  return { headers: parsed.headers, delimiter: parsed.delimiter, rowCount: parsed.rows.length, ...mapRows(parsed.rows, chosen, opts) };
}
