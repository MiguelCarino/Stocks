/* i18n-coverage.mjs — which UI strings the dictionary in i18n.js is missing.

   English text is the i18n key (i18n.js), so "coverage" means: every English
   string the UI can pass to the dictionary has an entry in es, pt-BR, ja and
   ru. The keys are found statically, by the same conventions the code follows:

   - string literals inside i18nT(...) / i18nF(...) calls, with adjacent
     'a' + 'b' concatenations joined and comparison operands ('loading' in
     `state === 'loading' ? ...`) left out;
   - string arguments of small helpers that pass their parameter straight to
     i18nT (eduNote('...'), sec('...'), ...), found automatically;
   - registry fields that the UI renders through i18nT: label, desc, summary,
     hint, tip, empty, group, quality, title, note(s) and the values of
     constant maps named *_LABEL(S), *_TIP, *_TXT, HINT, NOTE;
   - static markup: data-i18n texts in index.html and popout.html, and the
     attribute / boot-text tables inside i18n.js itself.

   Brand names, tickers and format tokens are not words to translate and are
   listed in SKIP. Run directly for a report:
     node tests/i18n-coverage.mjs           # summary + missing keys per locale
     node tests/i18n-coverage.mjs --keys    # every extracted key
   tests/i18n.test.mjs asserts that nothing is missing. */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCALES = ['es', 'pt-BR', 'ja', 'ru'];

// Not UI words: product and provider names, tickers, units, format tokens.
const SKIP = new Set([
  'Finnhub', 'Twelve Data', 'Polygon', 'Alpaca', 'Alpha Vantage', 'CoinGecko', 'Carino', 'Stocks',
  'Interactive Brokers', 'Schwab', 'Fidelity', 'Vanguard', 'Robinhood', 'eToro', 'Trading 212', 'Degiro',
  'GBM+ (Mexico)', 'Bitso', 'Coinbase', 'Kraken', 'BTC', 'ETH', 'SPY', 'QQQ', 'DIA', 'EURUSD', 'AAPL',
  'OK', 'P/E', 'EPS', 'ETF', 'ETFs', 'FX', 'IEX', 'YTD', 'MAX', 'CSV', 'JSON', 'VWAP', 'RSI', 'MACD', 'ATR', 'ADX', 'OBV',
  'MFI', 'CCI', 'ROC', 'CMF', 'SMA', 'EMA', 'WMA', 'PSAR', 'XIRR', 'TWR', 'FIFO', 'LIFO', 'ISIN', 'PEG', 'P/S', 'P/B', 'ROE',
  'USD', 'EUR', 'MXN', 'BRL', 'GBP', 'JPY', 'CAD', 'CHF', 'AUD',
]);

const JS_DIRS = ['js', 'js/providers'];
const FIELD_RE = /\b(label|desc|summary|hint|tip|empty|group|quality|title|text|body|notes?)\s*:\s*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const MAP_RE = /\bconst\s+((?:[A-Z][A-Z0-9_]*)?(?:LABELS?|_TIP|_TXT|HINT|NOTE|_NAMES?)|ENTER)\s*=\s*\{([\s\S]*?)\n?\};/g;

function unescape(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, c) => {
    if (c[0] === 'u' && c.length > 1) return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16));
    if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r' }[c] ?? c;
  });
}

// Scan a call's argument list from `start` (just past the open paren); returns
// {end, lits:[{text, a, b}]} where a/b are source offsets of each literal.
function scanArgs(src, start) {
  let j = start, depth = 1;
  const lits = [];
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let k = j + 1, buf = '', dyn = false;
      while (k < src.length && src[k] !== c) {
        if (src[k] === '\\') { buf += src.slice(k, k + 2); k += 2; continue; }
        if (c === '`' && src[k] === '$' && src[k + 1] === '{') dyn = true;
        buf += src[k]; k++;
      }
      if (!dyn) lits.push({ text: unescape(buf), a: j, b: k + 1, depth });
      j = k + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    j++;
  }
  return { end: j, lits };
}

// Join 'a' + 'b' runs, drop comparison operands.
function cleanLits(src, lits) {
  const out = [];
  for (let i = 0; i < lits.length; i++) {
    let cur = { ...lits[i] };
    while (i + 1 < lits.length && /^\s*\+\s*$/.test(src.slice(cur.b, lits[i + 1].a))) { cur.text += lits[i + 1].text; cur.b = lits[i + 1].b; i++; }
    const before = src.slice(Math.max(0, cur.a - 5), cur.a);
    const after = src.slice(cur.b, cur.b + 5);
    if (/[=!]==?\s*$/.test(before) || /^\s*[=!]==?/.test(after)) continue;
    // An object key or an index ('x' in obj[...]) is not text either.
    if (/^\s*:/.test(after) && !/[?]\s*$/.test(before)) continue;
    if (/\[\s*$/.test(before)) continue;
    out.push(cur.text);
  }
  return out;
}

function add(keys, text, where, explicit = false) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !/[A-Za-z]/.test(t) || SKIP.has(t)) return;
  // A lowercase word handed straight to i18nT('holding') is text; in a registry
  // field it is far more often an id.
  if (!(explicit && /^[a-z]+$/.test(t)) && /^[a-z][a-zA-Z0-9]*$/.test(t) && !/^(all|value|min|more|terms|symbols|bars|now|on|off|queued)$/.test(t)) return; // ids, not words
  if (/^(https?:|\.\/|#)/.test(t) || (!explicit && /^[a-z-]+\/[a-z-]+$/.test(t))) return;
  if (/^[A-Z⇧,.\/]{1,2}$|^⇧/.test(t) || /^[A-Z]{3}\/[A-Z]{3}$/.test(t)) return;   // key hints, currency pairs
  if (!keys.has(t)) keys.set(t, new Set());
  keys.get(t).add(where);
}


/* Loose pass: UI text that reaches i18nT through a variable — tuple tables
   ([['gainers', 'Gainers'], ...]), header lists and ternary branches
   (type === 'dividend' ? 'Tax withheld' : 'Fee / commission'). A small
   tokenizer finds every string literal with the tokens around it; a literal
   counts when it is an array element or a ternary branch AND reads like words
   (a capital or a space, and lowercase letters). Ids, CSS, keys and URLs fail
   the shape test. Not used on provider adapters or the CSV import presets,
   whose literals are wire formats, not UI. */
const KEY_NAMES = new Set(['Enter', 'Escape', 'Esc', 'Tab', 'Home', 'End', 'Delete', 'Backspace', 'ArrowLeft', 'ArrowRight',
  'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Shift', 'Control', 'Meta', 'Alt', 'Ctrl', 'Space', 'NaN', 'Infinity', 'UTC',
  'Content-Type', 'Authorization', 'Accept', 'Left', 'Right',
  // CSS class pairs that sit where text could ([cls, text] tuples, el(tag, cls)).
  'num amount', 'wg-calc-big amount', 'basis approx', 'basis unstated']);
function tokens(src) {
  const out = [];
  let i = 0, prev = '';
  const stack = [];
  const push = (t) => { out.push(t); };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let k = i + 1, buf = '', dyn = false;
      while (k < src.length && src[k] !== c) {
        if (src[k] === '\\') { buf += src.slice(k, k + 2); k += 2; continue; }
        if (c === '`' && src[k] === '$' && src[k + 1] === '{') {
          dyn = true; let d = 1; k += 2;
          while (k < src.length && d) { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; }
          continue;
        }
        buf += src[k]; k++;
      }
      push({ t: 'str', v: unescape(buf), dyn, br: stack[stack.length - 1] || '' });
      prev = 'str'; i = k + 1; continue;
    }
    // Regex literal: a slash where a value is expected.
    if (c === '/' && (prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$|^(return|typeof|case|of|in)$/.test(prev))) {
      let k = i + 1, cls = false;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '[') cls = true; else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) break;
        else if (ch === '\n') break;
        k++;
      }
      i = k + 1; while (/[a-z]/.test(src[i] || '')) i++;
      prev = 're'; push({ t: 're' }); continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let k = i; while (k < src.length && /[\w$]/.test(src[k])) k++;
      prev = src.slice(i, k); push({ t: 'id', v: prev }); i = k; continue;
    }
    if ('([{'.includes(c)) stack.push(c);
    else if (')]}'.includes(c)) stack.pop();
    // Multi-char operators collapse to their first char for the context test.
    let k = i + 1;
    if (c === '=' || c === '!') { while (src[k] === '=') k++; if (c === '=' && src[k] === '>') k++; }
    else if (c === '?' && (src[k] === '.' || src[k] === '?')) k++;
    const op = src.slice(i, k);
    prev = op.length > 1 && op !== '=>' ? op : c;
    push({ t: 'op', v: op });
    i = k;
  }
  return out;
}
const looksLikeText = (s) => {
  const t = s.trim();
  if (t.length < 2 || !/[a-z]/.test(t) || KEY_NAMES.has(t)) return false;
  if (!/^[A-Z%＋+▶✎~↑↓]/.test(t) && !/\s/.test(t)) return false;
  if (/^[.#\[@-]|[{};<>]|=>|^\w+\(|https?:|^[\w-]+\/[\w-]+$|^[A-Z][a-z]+[A-Z]\w*$/.test(t)) return false;
  if (/^[a-z]+(-[a-z]+)+$/.test(t)) return false;
  return true;
};
function looseLiterals(src) {
  const toks = tokens(src);
  const found = [];
  for (let j = 0; j < toks.length; j++) {
    const x = toks[j];
    if (x.t !== 'str' || x.dyn) continue;
    const p = toks[j - 1] || {}, n = toks[j + 1] || {};
    const pv = p.t === 'op' ? p.v : null, nv = n.t === 'op' ? n.v : null;
    const inArray = x.br === '[' && (pv === '[' || pv === ',') && (nv === ',' || nv === ']');
    const ternary = (pv === '?' || (pv === ':' && x.br !== '{')) && [':', ')', ',', ';', ']', '}'].includes(nv);
    if ((inArray || ternary) && looksLikeText(x.v)) found.push(x.v);
  }
  return found;
}

export function extractKeys() {
  const keys = new Map();
  const files = [];
  for (const d of JS_DIRS) {
    const dir = path.join(ROOT, d);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const isProvider = rel.startsWith('js/providers/') && !/candles\.js$|base\.js$/.test(rel);

    // 1. i18nT( / i18nF( calls.
    const callRe = /\bi18n[TF]\(/g;
    let m;
    while ((m = callRe.exec(src))) {
      const { end, lits } = scanArgs(src, m.index + m[0].length);
      for (const t of cleanLits(src, lits)) add(keys, t, rel, true);
      callRe.lastIndex = end;
    }

    // 2. Helpers that hand a parameter straight to i18nT.
    const helpers = new Map();
    const fnRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|const\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>)/g;
    while ((m = fnRe.exec(src))) {
      const name = m[1] || m[3];
      if (!name || /^i18n[TF]$/.test(name)) continue;
      const params = (m[2] || m[4] || '').split(',').map((p) => p.trim().replace(/\s*=.*$/, '')).filter(Boolean);
      const body = src.slice(m.index, m.index + 700);
      params.forEach((p, idx) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(p)) return;
        if (new RegExp('i18n[TF]\\(\\s*' + p.replace('$', '\\$') + '\\b').test(body)) {
          if (!helpers.has(name)) helpers.set(name, new Set());
          helpers.get(name).add(idx);
        }
      });
    }
    for (const [name, idxs] of helpers) {
      const re = new RegExp('(?<![\\w$.])' + name.replace('$', '\\$') + '\\(', 'g');
      while ((m = re.exec(src))) {
        // Skip the definition itself.
        if (/function\s+$|const\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue;
        const { end, lits } = scanArgs(src, m.index + m[0].length);
        // Split top-level args by comma to know each literal's position.
        const body = src.slice(m.index + m[0].length, end - 1);
        let d = 0, arg = 0, q = null;
        const argOf = [];
        for (let i = 0; i < body.length; i++) {
          const c = body[i];
          if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
          if (c === "'" || c === '"' || c === '`') { q = c; argOf.push([m.index + m[0].length + i, arg]); continue; }
          if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ',' && d === 0) arg++;
        }
        const pos = new Map(argOf);
        const kept = lits.filter((l) => idxs.has(pos.get(l.a)) && l.depth === 1);
        for (const t of cleanLits(src, kept)) add(keys, t, rel + ' (' + name + ')');
        re.lastIndex = end;
      }
    }

    // 3a. Conventions the passes above cannot see: the workspace templates name
    // their tabs through T('Start here', ...); the palette's add('Tabs', ...)
    // names its group; provider quotes carry a baselineNote the cards show.
    if (/workspace\.js$/.test(rel)) for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) add(keys, m[1], rel + ' (tab)');
    if (/app\.js$/.test(rel)) for (const m of src.matchAll(/\badd\(\s*'([A-Z][^']*)'\s*,/g)) add(keys, m[1], rel + ' (palette group)');
    for (const line of src.split('\n')) if (/baselineNote\s*:/.test(line)) for (const m of line.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)) add(keys, unescape(m[1]), rel + ' (baselineNote)');

    // 3b. Loose literals (see looseLiterals).
    if (!isProvider && !/csvimport\.js$/.test(rel)) for (const t of looseLiterals(src)) add(keys, t, rel + ' (loose)');

    // 3. Registry fields and label maps (provider adapters keep only names).
    if (!isProvider) {
      FIELD_RE.lastIndex = 0;
      while ((m = FIELD_RE.exec(src))) {
        if (m[2] === '`' && m[3].includes('${')) continue;
        add(keys, unescape(m[3]), rel + ' (' + m[1] + ')');
      }
      MAP_RE.lastIndex = 0;
      while ((m = MAP_RE.exec(src))) {
        const vRe = /:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
        let v;
        while ((v = vRe.exec(m[2]))) add(keys, unescape(v[2]), rel + ' (' + m[1] + ')');
      }
    }
  }

  // 4. Static markup.
  for (const f of ['index.html', 'popout.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /<([a-z0-9]+)\b[^>]*\bdata-i18n\b[^>]*>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(html))) add(keys, m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), f);
  }
  // Bundled universes: their names and notes are shown in the screener, heatmap
  // and movers pickers.
  for (const u of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/universes.json'), 'utf8')).lists || []) {
    if (u.label) add(keys, u.label, 'data/universes.json');
    if (u.note) add(keys, u.note, 'data/universes.json');
  }
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');
  const attrBlock = i18nSrc.slice(i18nSrc.indexOf('const ATTR_I18N'), i18nSrc.indexOf('function applyAttrI18n'));
  for (const m of attrBlock.matchAll(/\[\s*'[^']*'\s*,\s*'[^']*'\s*,\s*(['"])((?:\\.|(?!\1).)*)\1\s*\]/g)) add(keys, unescape(m[2]), 'i18n.js (ATTR_I18N)');
  return keys;
}

// Evaluate i18n.js in a sandbox and hand back its dictionary.
export function loadDictionary() {
  const src = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8') + '\n;globalThis.__I18N = I18N; globalThis.__DISC = DISCLAIMER_KEY;';
  const noop = () => {};
  const sandbox = {
    window: { addEventListener: noop, CarinoLang: { current: 'en' } },
    document: { addEventListener: noop, querySelectorAll: () => [], getElementById: () => null, documentElement: {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'i18n.js' });
  return { dict: sandbox.__I18N, disclaimer: sandbox.__DISC };
}

export function coverage() {
  const keys = extractKeys();
  const { dict, disclaimer } = loadDictionary();
  if (disclaimer) add(keys, disclaimer, 'i18n.js (DISCLAIMER_KEY)');
  const missing = {};
  for (const lc of LOCALES) {
    const d = dict[lc] || {};
    missing[lc] = [...keys.keys()].filter((k) => !(k in d)).sort();
  }
  // Entries that nothing extracts any more: harmless, but worth a look.
  const unused = {};
  for (const lc of LOCALES) unused[lc] = Object.keys(dict[lc] || {}).filter((k) => !keys.has(k)).sort();
  return { keys, missing, unused };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { keys, missing, unused } = coverage();
  if (process.argv.includes('--keys')) {
    for (const [k, w] of [...keys].sort((a, b) => a[0].localeCompare(b[0]))) console.log(JSON.stringify(k), '  ←', [...w].slice(0, 3).join(', '));
  }
  if (process.argv.includes('--missing-json')) {
    const all = new Set(); for (const lc of LOCALES) for (const k of missing[lc]) all.add(k);
    console.log(JSON.stringify([...all].sort(), null, 1));
    process.exit(0);
  }
  console.log('UI keys extracted:', keys.size);
  let total = 0;
  for (const lc of LOCALES) {
    total += missing[lc].length;
    console.log(`${lc.padEnd(6)} missing ${String(missing[lc].length).padStart(4)}   unused ${unused[lc].length}`);
    if (process.argv.includes('--verbose')) for (const k of missing[lc]) console.log('   ', JSON.stringify(k));
  }
  process.exitCode = total ? 1 : 0;
}
