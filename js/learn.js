/* learn.js — Carino Stocks education layer.
   Monitoring & education only: nothing here recommends, ranks or trades.

   Five things live here, all reusable from any module or widget:
     - the glossary (data/glossary*.json), loaded lazily per CarinoLang.current
       and merged term-by-term over English, so a missing translation degrades to
       English instead of to a blank;
     - helpIcon(id): the '?' toggletip that every label in the app can carry;
     - the glossary panel (mountGlossary) and the lessons viewer (mountLessons),
       both mountable anywhere, plus one shared <dialog> that hosts them
       (openGlossary / openLessons);
     - startTour(steps): a generic spotlight tour that skips targets it cannot
       find rather than pointing at nothing;
     - LEVELS / FEATURES / levelAllows: the beginner / standard / pro gate that
       other modules consult to decide what to show.

   The module never touches storage. Progress (which lessons were seen) is owned
   by the store; the app hands it in through configure({seen, onSeen}). Content
   strings come from the translated JSON; UI chrome goes through i18nT so the
   site dictionary can translate it. */

// UI-string translation via the site dictionary (i18n.js); identity when absent.
const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let uidSeq = 0;
const uid = (p) => 'learn-' + p + '-' + (++uidSeq);

const DATA = (name) => new URL('../data/' + name, import.meta.url).href;

/* ------------------------------------------------------------------ ids ---- */

// Cross-module id map: what other modules call a thing → the glossary id that
// explains it. Indicator and alert ids follow the shared contracts; a few
// aliases are listed so a module that spells an id differently still lands on
// the right entry. learnIdFor() is the safe accessor.
export const LEARN_IDS = {
  indicators: {
    sma: 'sma', ema: 'ema', wma: 'wma', vwap: 'vwap', bb: 'bollinger-bands', keltner: 'keltner',
    donchian: 'donchian', ichimoku: 'ichimoku', psar: 'psar', supertrend: 'supertrend', rsi: 'rsi',
    macd: 'macd', stoch: 'stochastic', stochrsi: 'stoch-rsi', atr: 'atr', adx: 'adx', obv: 'obv',
    mfi: 'mfi', cci: 'cci', willr: 'williams-r', roc: 'roc', cmf: 'cmf',
    volma: 'volume-ma', vma: 'volume-ma', volumeMa: 'volume-ma', volsma: 'volume-ma',
    heikinAshi: 'heikin-ashi', pivots: 'pivot-points', relativeStrength: 'relative-strength',
    returns: 'pct-change', stdev: 'stdev', maxDrawdown: 'drawdown',
  },
  alerts: {
    price: 'price-alert', pct: 'pct-change', pctFromOpen: 'pct-from-open', gap: 'gap',
    volume: 'volume', relVolume: 'relative-volume', high52Prox: '52-week-proximity',
    low52Prox: '52-week-proximity', newHigh52: '52-week-high', newLow52: '52-week-high',
    trailStop: 'trailing-stop', smaCross: 'price-ma-cross', emaCross: 'price-ma-cross',
    maCross: 'ma-crossover', rsi: 'rsi', macdCross: 'macd-cross', bbBreak: 'bollinger-break',
    atrMove: 'atr-move', portfolioValue: 'portfolio-alert', portfolioDayPL: 'day-pl',
    portfolioDayPct: 'portfolio-alert',
    // rule options
    crossAbove: 'crossover', crossBelow: 'crossover', repeat: 'alert-repeat', confirm: 'alert-confirmation',
  },
  fundamentals: {
    marketCap: 'market-cap', pe: 'pe', forwardPe: 'forward-pe', peg: 'peg', eps: 'eps', ps: 'ps', pb: 'pb',
    dividendYield: 'dividend-yield', dividendPerShare: 'dividend', payoutRatio: 'payout-ratio',
    beta: 'beta', high52: '52-week-high', low52: '52-week-high', high52Date: '52-week-high',
    low52Date: '52-week-high', avgVolume10d: 'avg-volume', avgVolume3m: 'avg-volume',
    sharesOutstanding: 'shares-outstanding', revenueGrowth: 'revenue-growth',
    profitMargin: 'profit-margin', roe: 'roe', debtToEquity: 'debt-to-equity',
    exDate: 'ex-dividend-date', earnings: 'earnings-report', split: 'stock-split',
  },
  portfolio: {
    qty: 'lot', lots: 'lot', avgCost: 'average-cost', costBasis: 'cost-basis', marketValue: 'net-worth',
    unrealized: 'unrealized-pl', unrealizedPct: 'unrealized-pl', realized: 'realized-pl',
    dividends: 'dividend', fees: 'fees', dayPL: 'day-pl', dayPLPct: 'day-pl', weight: 'allocation',
    cash: 'cash', netWorth: 'net-worth', currencyMissing: 'base-currency', baseCurrency: 'base-currency',
    fifo: 'fifo', avg: 'average-cost', xirr: 'xirr', twr: 'twr', volatility: 'volatility',
    sharpe: 'sharpe', sortino: 'sortino', maxDrawdown: 'drawdown', alpha: 'alpha', correlation: 'correlation',
    allocation: 'allocation', drift: 'drift', targets: 'rebalancing', trailing12m: 'dividend',
    forward12m: 'dividend', yieldOnCost: 'yield-on-cost', totalReturn: 'total-return', benchmark: 'benchmark',
    positionSize: 'position-size', riskReward: 'risk-reward', breakEven: 'break-even', rMultiple: 'r-multiple',
    stop: 'stop-loss', target: 'risk-reward', taxes: 'taxes',
  },
  chart: {
    candle: 'candlestick', ohlc: 'ohlc', heikin: 'heikin-ashi', line: 'line-chart', area: 'line-chart',
    baseline: 'line-chart', log: 'log-scale', volume: 'volume', interval: 'timeframe', range: 'timeframe',
    prevClose: 'prev-close', compare: 'relative-strength', hline: 'support-resistance',
    trend: 'trendline', ray: 'trendline', rect: 'support-resistance', fib: 'fibonacci', measure: 'pct-change',
    pivot: 'pivot-points', high52: '52-week-high', low52: '52-week-high', cost: 'cost-basis',
    alert: 'price-alert', gap: 'gap',
  },
  data: {
    demo: 'demo-data', isDemo: 'demo-data', delayed: 'delayed-data', realtime: 'real-time-data',
    stale: 'stale-quote', quota: 'rate-limit', limits: 'rate-limit', provider: 'data-provider',
    apiKey: 'api-key', session: 'market-session', pre: 'pre-market', regular: 'regular-session',
    post: 'after-hours', extended: 'extended-hours', holiday: 'market-holiday', halt: 'trading-halt',
  },
  quote: {
    last: 'last-price', price: 'last-price', prevClose: 'prev-close', change: 'change', changePct: 'pct-change',
    open: 'open-price', high: 'day-range', low: 'day-range', volume: 'volume', avgVolume: 'avg-volume',
    bid: 'bid', ask: 'ask', spread: 'spread', marketCap: 'market-cap', float: 'float',
  },
};

// learnIdFor('alerts', 'trailStop') → 'trailing-stop'. A bare glossary id is
// passed through, so callers can hand in either form.
export function learnIdFor(kind, id) {
  if (id == null) return null;
  const table = LEARN_IDS[kind];
  if (table && Object.prototype.hasOwnProperty.call(table, id)) return table[id];
  return typeof id === 'string' ? id : null;
}

/* --------------------------------------------------------------- levels ---- */

export const LEVEL_ORDER = ['beginner', 'standard', 'pro'];

export const LEVELS = {
  beginner: { id: 'beginner', label: 'Beginner', summary: 'Plain views and explanations everywhere. Line, area and candle charts, up to 2 indicators, basic alerts, simple portfolio.' },
  standard: { id: 'standard', label: 'Standard', summary: 'All indicators and chart types, drawings, most alert types, the transaction ledger and allocation targets.' },
  pro:      { id: 'pro',      label: 'Pro',      summary: 'Everything: screener formulas, multi-chart sync, command palette, risk metrics and raw provider diagnostics.' },
};

// Feature → the minimum level that shows it. Unknown features are allowed
// (fail open): a missing entry must never silently hide something.
export const FEATURES = {
  // charts
  'chart.type.line': 'beginner', 'chart.type.area': 'beginner', 'chart.type.candle': 'beginner',
  'chart.type.baseline': 'standard', 'chart.type.ohlc': 'standard', 'chart.type.heikin': 'standard',
  'chart.indicators': 'beginner', 'chart.indicators.all': 'standard', 'chart.drawings': 'standard',
  'chart.log': 'standard', 'chart.compare': 'standard', 'chart.levels': 'beginner',
  'chart.pivots': 'pro', 'chart.sync': 'pro', 'chart.keyboard': 'beginner',
  // indicators beginners get (the rest need 'chart.indicators.all')
  'indicator.sma': 'beginner', 'indicator.ema': 'beginner', 'indicator.rsi': 'beginner',
  'indicator.macd': 'beginner', 'indicator.bb': 'beginner', 'indicator.vwap': 'beginner',
  'indicator.volma': 'beginner',
  // alerts (individual alert types carry their own `level`; pass it straight in)
  'alerts.basic': 'beginner', 'alerts.standard': 'standard', 'alerts.pro': 'pro',
  'alerts.confirm': 'standard', 'alerts.expires': 'standard', 'alerts.portfolio': 'standard',
  // portfolio
  'portfolio.simple': 'beginner', 'portfolio.allocation': 'beginner', 'portfolio.ledger': 'standard',
  'portfolio.lots': 'standard', 'portfolio.realized': 'standard', 'portfolio.targets': 'standard',
  'portfolio.csvImport': 'standard', 'portfolio.dividends': 'standard', 'portfolio.fx': 'standard',
  'portfolio.xirr': 'pro', 'portfolio.twr': 'pro', 'portfolio.risk': 'pro', 'portfolio.history': 'standard',
  // tools
  'calculators': 'standard', 'fundamentals': 'beginner', 'news': 'beginner', 'events': 'beginner',
  'calendar': 'standard', 'screener': 'standard', 'screener.formulas': 'pro',
  'multiChart': 'pro', 'commandPalette': 'pro', 'providerDiagnostics': 'pro', 'shortcuts': 'standard',
  'workspace.edit': 'standard', 'learn.helpIcons': 'beginner', 'learn.tour': 'beginner',
};

// Numeric caps per level, for features that are allowed but bounded.
export const LEVEL_LIMITS = {
  beginner: { indicators: 2, compare: 1, charts: 1, alertTypes: 'basic' },
  standard: { indicators: 8, compare: 3, charts: 4, alertTypes: 'standard' },
  pro:      { indicators: Infinity, compare: 8, charts: Infinity, alertTypes: 'pro' },
};

const rankOf = (lv) => { const i = LEVEL_ORDER.indexOf(lv); return i < 0 ? -1 : i; };

export function normalizeLevel(lv) { return rankOf(lv) >= 0 ? lv : 'standard'; }

// levelAllows('beginner', 'chart.drawings') → false.
// levelAllows('beginner', 'standard') → false — so an ALERT_TYPES[id].level or
// an INDICATORS entry's level can be checked directly. Unknown → true.
export function levelAllows(level, feature) {
  const have = rankOf(normalizeLevel(level));
  let need;
  if (rankOf(feature) >= 0) need = rankOf(feature);
  else if (Object.prototype.hasOwnProperty.call(FEATURES, feature)) need = rankOf(FEATURES[feature]);
  else if (typeof feature === 'string' && feature.startsWith('indicator.')) need = rankOf('standard'); // non-listed indicators
  else return true;
  return have >= need;
}

export function levelLimit(level, key) {
  const row = LEVEL_LIMITS[normalizeLevel(level)];
  return row && key in row ? row[key] : Infinity;
}

// The store decides the default; this is the documented rule it should apply:
// brand-new users start as beginners, anyone with existing data as standard.
export function defaultLevel({ hasWatchlist = false, hasRules = false, hasHoldings = false } = {}) {
  return hasWatchlist || hasRules || hasHoldings ? 'standard' : 'beginner';
}

// Small segmented control for Settings / onboarding. onChange(level).
export function levelPicker(value, onChange) {
  const wrap = el('div', 'seg learn-levels');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', i18nT('Experience level'));
  const btns = LEVEL_ORDER.map((id) => {
    const b = el('button', 'cs-btn seg-btn', i18nT(LEVELS[id].label));
    b.type = 'button';
    b.dataset.level = id;
    b.setAttribute('role', 'radio');
    b.title = i18nT(LEVELS[id].summary);
    b.addEventListener('click', () => { set(id); if (onChange) onChange(id); });
    wrap.appendChild(b);
    return b;
  });
  function set(v) {
    const cur = normalizeLevel(v);
    for (const b of btns) {
      const on = b.dataset.level === cur;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  set(value);
  wrap.setLevel = set;
  return wrap;
}

/* ------------------------------------------------------------- language ---- */

const FILES = { es: '.es', 'pt-BR': '.pt-BR' };
// Fleet codes are en / es / pt-BR / ja / ru; ja and ru fall back to English.
function contentLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('es')) return 'es';
  if (l.startsWith('pt')) return 'pt-BR';
  return 'en';
}
export function currentLang() {
  return contentLang(window.CarinoLang && window.CarinoLang.current);
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return r.json();
}

/* ------------------------------------------------------------- glossary ---- */

const glossCache = new Map();         // lang → Promise<map>
let glossEn = null;                    // resolved English map (search fallback)
let glossNow = null;                   // resolved map for currentLang()
let glossNowLang = null;

// loadGlossary(lang) → Promise<{[id]: {id, term, short, long, example, pitfalls,
// related, level, termEn}}>. Never rejects: a failed translation file falls
// back to English, a failed English file to an empty map.
export function loadGlossary(lang = currentLang()) {
  const code = contentLang(lang);
  if (glossCache.has(code)) return glossCache.get(code);
  const p = (async () => {
    let en = {};
    try { en = await fetchJSON(DATA('glossary.json')); } catch (e) { console.warn('[learn] glossary unavailable', e); }
    let loc = {};
    if (FILES[code]) {
      try { loc = await fetchJSON(DATA('glossary' + FILES[code] + '.json')); }
      catch (e) { console.warn('[learn] ' + code + ' glossary unavailable, using English', e); }
    }
    const out = {};
    for (const id of Object.keys(en)) {
      const base = en[id] || {};
      const tr = loc[id] || {};
      out[id] = {
        id,
        term: tr.term || base.term || id,
        short: tr.short || base.short || '',
        long: tr.long || base.long || '',
        example: tr.example || base.example || '',
        pitfalls: tr.pitfalls || base.pitfalls || '',
        related: Array.isArray(base.related) ? base.related.slice() : [],
        level: normalizeLevel(base.level),
        termEn: base.term || id,
      };
    }
    if (code === 'en') glossEn = out;
    return out;
  })();
  glossCache.set(code, p);
  p.then((m) => { if (code === currentLang()) { glossNow = m; glossNowLang = code; } });
  return p;
}

// Synchronous lookup in the glossary for the current language. Returns null
// until it has loaded (and starts the load), so callers can render a fallback.
export function term(id) {
  const lang = currentLang();
  if (glossNowLang !== lang) { loadGlossary(lang); return null; }
  return (glossNow && glossNow[id]) || null;
}

export function glossaryIds() { return glossNow ? Object.keys(glossNow) : []; }

/* -------------------------------------------------------------- lessons ---- */

const lessonCache = new Map();
// loadLessons(lang) → Promise<{paths, lessons}>; English fallback per file.
export function loadLessons(lang = currentLang()) {
  const code = contentLang(lang);
  if (lessonCache.has(code)) return lessonCache.get(code);
  const p = (async () => {
    if (FILES[code]) {
      try { return await fetchJSON(DATA('lessons' + FILES[code] + '.json')); }
      catch (e) { console.warn('[learn] ' + code + ' lessons unavailable, using English', e); }
    }
    try { return await fetchJSON(DATA('lessons.json')); }
    catch (e) { console.warn('[learn] lessons unavailable', e); return { paths: [], lessons: [] }; }
  })();
  lessonCache.set(code, p);
  return p;
}

// Lesson metadata used by the viewer; the store owns the actual values.
const cfg = {
  seen: () => [],
  onSeen: null,
  level: () => 'standard',
};
// configure({seen: () => string[], onSeen(id), level: () => level})
export function configure(opts = {}) {
  if (typeof opts.seen === 'function') cfg.seen = opts.seen;
  else if (Array.isArray(opts.seen)) { const s = opts.seen; cfg.seen = () => s; }
  if (typeof opts.onSeen === 'function') cfg.onSeen = opts.onSeen;
  if (typeof opts.level === 'function') cfg.level = opts.level;
  else if (typeof opts.level === 'string') { const l = opts.level; cfg.level = () => l; }
}

/* ------------------------------------------------------------ help icon ---- */

let pop = null;          // the single shared popover
let popAnchor = null;
let popCleanup = null;

function closePopover(returnFocus) {
  if (!pop) return;
  const a = popAnchor;
  if (popCleanup) popCleanup();
  pop.remove();
  pop = null; popAnchor = null; popCleanup = null;
  if (a) {
    a.setAttribute('aria-expanded', 'false');
    if (returnFocus && a.isConnected) a.focus();
  }
}

function placeFloating(box, anchor) {
  const m = 8;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  box.style.maxWidth = Math.min(320, vw - 2 * m) + 'px';
  const r = anchor.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const left = clamp(r.left + r.width / 2 - bw / 2, m, Math.max(m, vw - bw - m));
  let top = r.bottom + 6;
  let side = 'below';
  if (top + bh > vh - m && r.top - 6 - bh >= m) { top = r.top - 6 - bh; side = 'above'; }
  top = clamp(top, m, Math.max(m, vh - bh - m));
  box.style.left = Math.round(left) + 'px';
  box.style.top = Math.round(top) + 'px';
  box.dataset.side = side;
}

function openPopover(anchor, id) {
  if (popAnchor === anchor) { closePopover(true); return; }
  closePopover(false);
  const box = el('div', 'learn-pop');
  box.id = uid('pop');
  box.setAttribute('role', 'dialog');
  box.tabIndex = -1;
  const head = el('div', 'learn-pop-term', '…');
  head.id = uid('popt');
  box.setAttribute('aria-labelledby', head.id);
  const body = el('p', 'learn-pop-short', i18nT('Loading…'));
  const foot = el('div', 'learn-pop-foot');
  const more = el('button', 'learn-link', i18nT('Learn more'));
  more.type = 'button';
  more.addEventListener('click', () => { closePopover(false); openGlossary(id); });
  const x = el('button', 'learn-pop-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', i18nT('Close'));
  x.addEventListener('click', () => closePopover(true));
  foot.append(more);
  box.append(x, head, body, foot);

  // Inside an open modal <dialog> the top layer would hide a body-level popover.
  const host = anchor.closest('dialog[open]') || document.body;
  host.appendChild(box);
  pop = box; popAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', box.id);

  const fill = (g) => {
    if (pop !== box) return;
    const t = g && g[id];
    head.textContent = t ? t.term : id;
    body.textContent = t ? t.short : i18nT('No explanation is available for this term yet.');
    more.hidden = !t;
    placeFloating(box, anchor);
  };
  loadGlossary().then(fill);
  placeFloating(box, anchor);
  box.focus({ preventScroll: true });

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePopover(true); } };
  const onDown = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closePopover(false); };
  const onFocus = (e) => { if (e.target instanceof Node && !box.contains(e.target) && !anchor.contains(e.target)) closePopover(false); };
  const onMove = () => { if (!anchor.isConnected) closePopover(false); else placeFloating(box, anchor); };
  box.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('focusin', onFocus, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  popCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
  };
}

// helpIcon('rsi') → <button class="learn-help">?</button>. Accepts a glossary id
// or any LEARN_IDS key via {kind}: helpIcon('trailStop', {kind: 'alerts'}).
export function helpIcon(id, opts = {}) {
  const gid = opts.kind ? learnIdFor(opts.kind, id) : id;
  const b = el('button', 'learn-help' + (opts.className ? ' ' + opts.className : ''), '?');
  b.type = 'button';
  b.dataset.learn = gid;
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  const label = () => {
    const t = term(gid);
    b.setAttribute('aria-label', i18nT('What is this?') + (t ? ' ' + t.term : ''));
    b.title = t ? t.short : i18nT('What is this?');
  };
  label();
  loadGlossary().then(label);
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPopover(b, gid); });
  // Keep a click on the icon from also selecting a row / sorting a column.
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

// decorate(root): append a help icon to every [data-learn] element that lacks
// one, so static HTML can opt in with an attribute.
export function decorate(root = document) {
  root.querySelectorAll('[data-learn]:not(.learn-help)').forEach((n) => {
    if (n.querySelector(':scope > .learn-help')) return;
    n.appendChild(helpIcon(n.getAttribute('data-learn'), { kind: n.getAttribute('data-learn-kind') || undefined }));
  });
}

/* ------------------------------------------------------- glossary panel ---- */

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const letterOf = (s) => { const c = fold(s).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
const LEVEL_TXT = { beginner: 'Beginner', standard: 'Standard', pro: 'Pro' };

const mounted = new Set();     // live panels, re-rendered on a language change

// mountGlossary(host, {initial, compact}) → {select(id), search(q), refresh(), destroy()}
export function mountGlossary(host, opts = {}) {
  const root = el('div', 'learn-gloss' + (opts.compact ? ' compact' : ''));
  const bar = el('div', 'learn-gloss-bar');
  const q = el('input', 'input learn-gloss-q');
  q.type = 'search';
  q.setAttribute('aria-label', i18nT('Search the glossary'));
  const lv = el('div', 'learn-chips');
  lv.setAttribute('role', 'group');
  lv.setAttribute('aria-label', i18nT('Filter by level'));
  const az = el('nav', 'learn-az');
  az.setAttribute('aria-label', i18nT('Jump to letter'));
  const cols = el('div', 'learn-gloss-cols');
  const list = el('ul', 'learn-gloss-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', i18nT('Terms'));
  const detail = el('article', 'learn-gloss-detail');
  detail.setAttribute('aria-live', 'polite');
  const count = el('div', 'learn-gloss-count');
  bar.append(q, lv);
  cols.append(el('div', 'learn-gloss-left'), detail);
  cols.firstChild.append(az, list, count);
  root.append(bar, cols);
  host.appendChild(root);

  let map = {};
  let filterLevel = 'all';
  let current = opts.initial || null;
  let items = [];

  const chip = (id, label) => {
    const b = el('button', 'learn-chip', i18nT(label));
    b.type = 'button';
    b.dataset.level = id;
    b.addEventListener('click', () => { filterLevel = id; paintList(); });
    lv.appendChild(b);
  };
  chip('all', 'All'); chip('beginner', 'Beginner'); chip('standard', 'Standard'); chip('pro', 'Pro');

  q.addEventListener('input', () => paintList());
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const f = list.querySelector('[role=option]'); if (f) f.focus(); }
    if (e.key === 'Enter') { const f = list.querySelector('[role=option]'); if (f) select(f.dataset.id); }
  });
  list.addEventListener('keydown', (e) => {
    const opt = e.target.closest('[role=option]');
    if (!opt) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? opt.nextElementSibling : opt.previousElementSibling;
      if (sib) sib.focus(); else if (e.key === 'ArrowUp') q.focus();
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(opt.dataset.id); }
  });

  function matches(t, needle) {
    if (!needle) return true;
    return [t.id, t.term, t.termEn, t.short, t.long].some((s) => fold(s).includes(needle));
  }

  function paintList() {
    const needle = fold(q.value.trim());
    for (const b of lv.children) {
      const on = b.dataset.level === filterLevel;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const lang = currentLang();
    const coll = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    items = Object.values(map)
      .filter((t) => (filterLevel === 'all' || t.level === filterLevel) && matches(t, needle))
      .sort((a, b) => coll.compare(a.term, b.term));
    list.textContent = '';
    const letters = new Set();
    for (const t of items) {
      const li = el('li', 'learn-gloss-item');
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.dataset.id = t.id;
      li.dataset.letter = letterOf(t.term);
      letters.add(li.dataset.letter);
      li.setAttribute('aria-selected', t.id === current ? 'true' : 'false');
      li.append(el('span', 'lgi-term', t.term), el('span', 'lgi-lv lv-' + t.level, i18nT(LEVEL_TXT[t.level])));
      li.addEventListener('click', () => select(t.id));
      list.appendChild(li);
    }
    if (list.firstChild) {
      const cur = list.querySelector('[aria-selected=true]') || list.firstChild;
      cur.tabIndex = 0;
    }
    count.textContent = items.length + ' / ' + Object.keys(map).length + ' ' + i18nT('terms');
    if (!items.length) list.appendChild(el('li', 'learn-empty', i18nT('No terms match.')));
    az.textContent = '';
    for (const L of '#ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const b = el('button', 'learn-az-l', L);
      b.type = 'button';
      b.disabled = !letters.has(L);
      b.addEventListener('click', () => {
        const first = list.querySelector('[data-letter="' + L + '"]');
        if (first) { first.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); first.focus({ preventScroll: true }); }
      });
      az.appendChild(b);
    }
  }

  function section(label, text) {
    if (!text) return null;
    const s = el('section', 'lgd-sec');
    s.append(el('h4', 'lgd-h', i18nT(label)), el('p', null, text));
    return s;
  }

  function paintDetail() {
    detail.textContent = '';
    const t = current && map[current];
    if (!t) {
      detail.append(el('p', 'learn-muted', i18nT('Pick a term to read its explanation.')));
      return;
    }
    const h = el('h3', 'lgd-term', t.term);
    h.tabIndex = -1;
    const meta = el('div', 'lgd-meta');
    meta.append(el('span', 'lgi-lv lv-' + t.level, i18nT(LEVEL_TXT[t.level])));
    if (t.termEn && t.termEn !== t.term) meta.append(el('span', 'learn-muted', t.termEn));
    detail.append(h, meta, el('p', 'lgd-short', t.short), el('p', 'lgd-long', t.long));
    const ex = section('Example', t.example); if (ex) detail.append(ex);
    const pf = section('Watch out', t.pitfalls); if (pf) { pf.classList.add('warn'); detail.append(pf); }
    const rel = t.related.filter((r) => map[r]);
    if (rel.length) {
      const s = el('section', 'lgd-sec');
      s.append(el('h4', 'lgd-h', i18nT('Related')));
      const row = el('div', 'learn-chips');
      for (const r of rel) {
        const b = el('button', 'learn-chip', map[r].term);
        b.type = 'button';
        b.addEventListener('click', () => select(r, true));
        row.appendChild(b);
      }
      s.append(row);
      detail.append(s);
    }
    detail.append(el('p', 'learn-note', i18nT('Educational explanation, not investment advice.')));
  }

  function select(id, focusDetail) {
    current = id;
    for (const li of list.querySelectorAll('[role=option]')) {
      const on = li.dataset.id === id;
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      li.tabIndex = on ? 0 : -1;
      if (on) li.scrollIntoView({ block: 'nearest' });
    }
    // A related term filtered out by level/search would be invisible; widen.
    if (map[id] && !items.some((t) => t.id === id)) { filterLevel = 'all'; q.value = ''; paintList(); }
    paintDetail();
    root.classList.add('has-detail');
    if (focusDetail) detail.querySelector('.lgd-term')?.focus?.();
  }

  async function refresh() {
    map = await loadGlossary();
    q.placeholder = i18nT('Search terms…');
    paintList();
    if (current && !map[current]) current = null;
    if (!current && opts.initial && map[opts.initial]) current = opts.initial;
    paintDetail();
    if (current) root.classList.add('has-detail');
  }

  // Narrow layouts show list OR detail; this returns to the list.
  const back = el('button', 'learn-link learn-gloss-back', '← ' + i18nT('All terms'));
  back.type = 'button';
  back.addEventListener('click', () => { root.classList.remove('has-detail'); q.focus(); });
  detail.before(back);

  const api = {
    select: (id) => { if (map[id]) select(id); else { opts.initial = id; } },
    search: (s) => { q.value = s || ''; paintList(); },
    refresh,
    destroy: () => { mounted.delete(api); root.remove(); },
    el: root,
  };
  mounted.add(api);
  refresh();
  return api;
}

/* -------------------------------------------------------- lessons panel ---- */

function resolveTarget(target) {
  if (!target) return null;
  if (target instanceof Element) return target;
  try { return document.querySelector(target); } catch (e) { return null; }
}
function isVisible(n) {
  if (!n || !n.isConnected) return false;
  const r = n.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(n);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

// mountLessons(host, {initial}) → {open(id), refresh(), destroy()}
export function mountLessons(host, opts = {}) {
  const root = el('div', 'learn-lessons');
  host.appendChild(root);
  let data = { paths: [], lessons: [] };
  let byId = {};
  let view = { lesson: opts.initial || null, step: 0 };

  function seen() { try { return new Set(cfg.seen() || []); } catch (e) { return new Set(); } }

  function paintIndex() {
    root.textContent = '';
    const s = seen();
    const intro = el('p', 'learn-muted', i18nT('Short guided lessons. Each takes a few minutes and points at the real controls.'));
    root.append(intro);
    for (const p of data.paths) {
      const sec = el('section', 'learn-path');
      const done = p.lessons.filter((id) => s.has(id)).length;
      const h = el('h3', 'learn-path-h', p.title);
      h.append(el('span', 'learn-path-n', done + '/' + p.lessons.length));
      sec.append(h, el('p', 'learn-muted', p.summary));
      const grid = el('div', 'learn-cards');
      for (const id of p.lessons) {
        const l = byId[id];
        if (!l) continue;
        const card = el('button', 'learn-card' + (s.has(id) ? ' done' : ''));
        card.type = 'button';
        card.dataset.lesson = id;
        const top = el('div', 'learn-card-top');
        top.append(el('span', 'lgi-lv lv-' + normalizeLevel(l.level), i18nT(LEVEL_TXT[normalizeLevel(l.level)])),
          el('span', 'learn-muted', l.minutes + ' ' + i18nT('min')));
        if (s.has(id)) top.append(el('span', 'learn-done', '✓ ' + i18nT('Done')));
        card.append(top, el('div', 'learn-card-t', l.title), el('div', 'learn-card-s', l.summary));
        card.addEventListener('click', () => open(id));
        grid.append(card);
      }
      sec.append(grid);
      root.append(sec);
    }
    if (!data.paths.length) root.append(el('p', 'learn-muted', i18nT('Lessons could not be loaded.')));
  }

  function paintLesson() {
    const l = byId[view.lesson];
    if (!l) { view.lesson = null; paintIndex(); return; }
    const steps = l.steps || [];
    const i = clamp(view.step, 0, Math.max(0, steps.length - 1));
    view.step = i;
    const st = steps[i] || { title: '', body: '' };
    root.textContent = '';
    const back = el('button', 'learn-link', '← ' + i18nT('All lessons'));
    back.type = 'button';
    back.addEventListener('click', () => { view.lesson = null; paintIndex(); });
    const h = el('h3', 'learn-lesson-h', l.title);
    h.tabIndex = -1;
    const dots = el('ol', 'learn-dots');
    dots.setAttribute('aria-label', i18nT('Steps'));
    steps.forEach((_, k) => {
      const d = el('li', k === i ? 'on' : k < i ? 'past' : '');
      const b = el('button', null, String(k + 1));
      b.type = 'button';
      b.setAttribute('aria-label', i18nT('Step') + ' ' + (k + 1));
      if (k === i) b.setAttribute('aria-current', 'step');
      b.addEventListener('click', () => { view.step = k; paintLesson(); });
      d.append(b);
      dots.append(d);
    });
    const card = el('div', 'learn-step');
    card.append(el('div', 'learn-step-n', i18nT('Step') + ' ' + (i + 1) + ' / ' + steps.length),
      el('h4', 'learn-step-t', st.title), el('p', 'learn-step-b', st.body));
    if (st.try) {
      const t = el('p', 'learn-try');
      t.append(el('strong', null, i18nT('Try it') + ': '), document.createTextNode(st.try));
      card.append(t);
    }
    const acts = el('div', 'learn-step-acts');
    const prev = el('button', 'cs-btn', '← ' + i18nT('Back'));
    prev.type = 'button';
    prev.disabled = i === 0;
    prev.addEventListener('click', () => { view.step = i - 1; paintLesson(); });
    const tgt = resolveTarget(st.target);
    const show = el('button', 'cs-btn', i18nT('Show me'));
    show.type = 'button';
    show.hidden = !(tgt && isVisible(tgt));
    show.addEventListener('click', () => {
      const dlg = root.closest('dialog[open]');
      if (dlg) dlg.close();
      startTour([{ target: st.target, title: st.title, body: st.body, try: st.try }], {
        onEnd: () => { if (dlg && dlg.isConnected) { dlg.showModal(); } },
      });
    });
    const last = i === steps.length - 1;
    const next = el('button', 'btn-primary sm', last ? i18nT('Finish lesson') : i18nT('Next') + ' →');
    next.type = 'button';
    next.addEventListener('click', () => {
      if (!last) { view.step = i + 1; paintLesson(); return; }
      if (cfg.onSeen) { try { cfg.onSeen(l.id); } catch (e) { /* store refused; progress is cosmetic */ } }
      view.lesson = null;
      paintIndex();
      root.querySelector('[data-lesson="' + l.id + '"]')?.focus();
    });
    acts.append(prev, show, el('span', 'spacer'), next);
    card.append(acts);

    // Whole-lesson tour if more than one step points at the UI.
    const tourable = steps.filter((s) => s.target && isVisible(resolveTarget(s.target)));
    const tourBtn = el('button', 'learn-link', i18nT('Take the guided tour'));
    tourBtn.type = 'button';
    tourBtn.hidden = tourable.length < 2;
    tourBtn.addEventListener('click', () => {
      const dlg = root.closest('dialog[open]');
      if (dlg) dlg.close();
      startTour(steps.map((s) => ({ target: s.target, title: s.title, body: s.body, try: s.try })), {
        onEnd: () => { if (dlg && dlg.isConnected) dlg.showModal(); },
      });
    });

    const terms = el('div', 'learn-terms');
    const ids = (l.learn || []).filter(Boolean);
    if (ids.length) {
      terms.append(el('span', 'learn-muted', i18nT('Terms in this lesson') + ':'));
      for (const id of ids) {
        const t = term(id);
        const b = el('button', 'learn-chip', t ? t.term : id);
        b.type = 'button';
        b.addEventListener('click', () => openGlossary(id));
        terms.append(b);
      }
    }
    root.append(back, h, dots, card, tourBtn, terms);
    h.focus({ preventScroll: true });
  }

  function open(id) { view = { lesson: id, step: 0 }; if (byId[id]) paintLesson(); }

  async function refresh() {
    await loadGlossary();
    data = await loadLessons();
    byId = {};
    for (const l of data.lessons || []) byId[l.id] = l;
    if (view.lesson && byId[view.lesson]) paintLesson(); else paintIndex();
  }

  const api = { open, refresh, destroy: () => { mounted.delete(api); root.remove(); }, el: root };
  mounted.add(api);
  refresh();
  return api;
}

/* -------------------------------------------------------- shared dialog ---- */

let dlg = null;
let dlgGloss = null;
let dlgLessons = null;

function ensureDialog() {
  if (dlg && dlg.isConnected) return dlg;
  dlg = el('dialog', 'learn-dlg');
  dlg.setAttribute('aria-labelledby', 'learnDlgTitle');
  const head = el('div', 'modal-head');
  const title = el('div', 'modal-title', i18nT('Learn'));
  title.id = 'learnDlgTitle';
  const tabs = el('div', 'seg learn-tabs');
  tabs.setAttribute('role', 'tablist');
  const mk = (id, label) => {
    const b = el('button', 'cs-btn seg-btn', i18nT(label));
    b.type = 'button';
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => showTab(id));
    tabs.append(b);
  };
  mk('glossary', 'Glossary'); mk('lessons', 'Lessons');
  const x = el('button', 'modal-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', i18nT('Close'));
  x.addEventListener('click', () => dlg.close());
  head.append(title, tabs, el('span', 'spacer'), x);
  const body = el('div', 'learn-dlg-body');
  const pg = el('div', 'learn-tab'); pg.dataset.tab = 'glossary'; pg.setAttribute('role', 'tabpanel');
  const pl = el('div', 'learn-tab'); pl.dataset.tab = 'lessons'; pl.setAttribute('role', 'tabpanel');
  body.append(pg, pl);
  dlg.append(head, body);
  // Click on the backdrop (outside the box) closes, like the app's modals.
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  dlg.addEventListener('close', () => closePopover(false));
  document.body.append(dlg);
  dlgGloss = mountGlossary(pg, {});
  dlgLessons = mountLessons(pl, {});
  return dlg;
}

function showTab(id) {
  for (const b of dlg.querySelectorAll('.learn-tabs [role=tab]')) {
    const on = b.dataset.tab === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const p of dlg.querySelectorAll('.learn-tab')) p.hidden = p.dataset.tab !== id;
}

function showDialog() {
  if (!dlg.open) {
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
  }
}

// openGlossary(id?) → the <dialog>; opens on the glossary tab at that term.
export function openGlossary(id) {
  ensureDialog();
  showTab('glossary');
  if (id) dlgGloss.select(id);
  showDialog();
  setTimeout(() => { const q = dlg.querySelector('.learn-gloss-q'); if (q && !id) q.focus(); }, 0);
  return dlg;
}

// openLessons(lessonId?) → the <dialog>; opens on the lessons tab.
export function openLessons(lessonId) {
  ensureDialog();
  showTab('lessons');
  if (lessonId) dlgLessons.open(lessonId); else dlgLessons.refresh();
  showDialog();
  return dlg;
}

/* ---------------------------------------------------------------- tour ---- */

let activeTour = null;

// startTour([{target?, title, body, try?}], {onEnd({completed, index}), labels})
// → {next(), back(), close(), finished: Promise<{completed, index}>}.
// Steps whose target is missing or hidden are skipped; a step with no target
// shows a centred card. Esc skips, ←/→ move, focus is trapped in the card and
// returned on exit.
export function startTour(steps, opts = {}) {
  if (activeTour) activeTour.close();
  const list = (steps || []).filter((s) => s && (!s.target || isVisible(resolveTarget(s.target))));
  let resolveDone;
  const finished = new Promise((r) => { resolveDone = r; });
  if (!list.length) {
    const res = { completed: false, index: -1, empty: true };
    resolveDone(res);
    if (opts.onEnd) opts.onEnd(res);
    return { next() {}, back() {}, close() {}, finished };
  }

  const prevFocus = document.activeElement;
  const root = el('div', 'learn-tour');
  const hole = el('div', 'learn-tour-hole');
  const card = el('div', 'learn-tour-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const tId = uid('tt');
  card.setAttribute('aria-labelledby', tId);
  const count = el('div', 'learn-tour-n');
  const title = el('h3', 'learn-tour-t'); title.id = tId;
  const body = el('p', 'learn-tour-b');
  const tryP = el('p', 'learn-try');
  const acts = el('div', 'learn-step-acts');
  const skip = el('button', 'learn-link', i18nT('Skip tour'));
  const back = el('button', 'cs-btn', '← ' + i18nT('Back'));
  const next = el('button', 'btn-primary sm', i18nT('Next') + ' →');
  for (const b of [skip, back, next]) b.type = 'button';
  acts.append(skip, el('span', 'spacer'), back, next);
  card.append(count, title, body, tryP, acts);
  root.append(hole, card);
  document.body.append(root);

  let i = 0;
  let target = null;
  let ended = false;

  function position() {
    if (ended) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const m = 10;
    if (!target || !target.isConnected) {
      root.classList.add('centred');
      hole.hidden = true;
      card.style.left = Math.round((vw - card.offsetWidth) / 2) + 'px';
      card.style.top = Math.round(clamp((vh - card.offsetHeight) / 2, m, vh)) + 'px';
      return;
    }
    root.classList.remove('centred');
    hole.hidden = false;
    const r = target.getBoundingClientRect();
    const pad = 6;
    const hx = clamp(r.left - pad, 0, vw), hy = clamp(r.top - pad, 0, vh);
    const hw = clamp(r.right + pad, 0, vw) - hx, hh = clamp(r.bottom + pad, 0, vh) - hy;
    Object.assign(hole.style, { left: hx + 'px', top: hy + 'px', width: Math.max(0, hw) + 'px', height: Math.max(0, hh) + 'px' });
    // Narrow screens dock the card to the bottom via CSS; leave it there.
    if (vw < 560) { card.style.left = ''; card.style.top = ''; return; }
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let top, left = hx + hw / 2 - cw / 2;
    if (hy + hh + 12 + ch <= vh - m) top = hy + hh + 12;                 // below
    else if (hy - 12 - ch >= m) top = hy - 12 - ch;                      // above
    else {                                                               // beside (tall targets)
      top = hy + hh / 2 - ch / 2;
      left = hx + hw + 12 + cw <= vw - m ? hx + hw + 12 : hx - 12 - cw;
    }
    card.style.left = Math.round(clamp(left, m, Math.max(m, vw - cw - m))) + 'px';
    card.style.top = Math.round(clamp(top, m, Math.max(m, vh - ch - m))) + 'px';
  }

  function show(k) {
    i = k;
    const st = list[i];
    target = resolveTarget(st.target);
    if (st.target && !isVisible(target)) {                // vanished since start
      list.splice(i, 1);
      if (!list.length) return end(false);
      return show(Math.min(i, list.length - 1));
    }
    count.textContent = i18nT('Step') + ' ' + (i + 1) + ' / ' + list.length;
    title.textContent = st.title || '';
    body.textContent = st.body || '';
    tryP.textContent = '';
    tryP.hidden = !st.try;
    if (st.try) tryP.append(el('strong', null, i18nT('Try it') + ': '), document.createTextNode(st.try));
    back.disabled = i === 0;
    next.textContent = i === list.length - 1 ? i18nT('Done') : i18nT('Next') + ' →';
    if (target) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    position();
    // Smooth scrolling moves the target after this frame; settle once more.
    setTimeout(position, reducedMotion() ? 0 : 350);
    next.focus({ preventScroll: true });
  }

  function end(completed) {
    if (ended) return;
    ended = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    root.remove();
    if (activeTour === api) activeTour = null;
    const res = { completed, index: i };
    resolveDone(res);
    if (opts.onEnd) { try { opts.onEnd(res); } catch (e) { console.warn(e); } }
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
    else if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); api.next(); }
    else if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); api.back(); }
    else if (e.key === 'Tab') {
      const f = [...card.querySelectorAll('button:not([disabled])')];
      if (!f.length) return;
      const idx = f.indexOf(document.activeElement);
      e.preventDefault();
      const n = e.shiftKey ? (idx <= 0 ? f.length - 1 : idx - 1) : (idx === f.length - 1 ? 0 : idx + 1);
      f[n].focus();
    }
  }

  const api = {
    next() { if (i >= list.length - 1) end(true); else show(i + 1); },
    back() { if (i > 0) show(i - 1); },
    close() { end(false); },
    finished,
  };
  skip.addEventListener('click', () => end(false));
  back.addEventListener('click', () => api.back());
  next.addEventListener('click', () => api.next());
  // A click on the dimmed backdrop does nothing (no accidental exits);
  // the backdrop itself blocks interaction with the page under it.
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  activeTour = api;
  show(0);
  return api;
}

/* ------------------------------------------------------- language change ---- */

window.addEventListener('carino:langchange', () => {
  closePopover(false);
  loadGlossary().then(() => {
    for (const m of mounted) { try { m.refresh(); } catch (e) { console.warn(e); } }
  });
  if (dlg) {
    const title = dlg.querySelector('#learnDlgTitle');
    if (title) title.textContent = i18nT('Learn');
    dlg.querySelectorAll('.learn-tabs [role=tab]').forEach((b) => { b.textContent = i18nT(b.dataset.tab === 'glossary' ? 'Glossary' : 'Lessons'); });
  }
});
