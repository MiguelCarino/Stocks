/* store.js — all persistent state for Carino Stocks.
   Everything lives in localStorage under the stk_ prefix; nothing is ever sent
   anywhere but the data provider the user configured.

   Every write funnels through one guarded lsSet(). That single choke point is
   what makes two otherwise scattered guarantees possible: a shared #symbols link
   can freeze persistence entirely (so viewing someone else's watchlist can never
   overwrite your own), and a full quota is recorded and recovered from instead of
   being swallowed — the old code lost API keys silently once the caches filled. */

import { ALERT_TYPES, ALERT_OPS, PORTFOLIO_SYMBOL } from './alerttypes.js';

const K = {
  settings: 'stk_settings',
  watchlist: 'stk_watchlist',
  rules: 'stk_rules',
  holdings: 'stk_holdings',     // DEPRECATED since schema v3 — superseded by stk_ledger; still read and written for the old UI
  ledger: 'stk_ledger',         // Txn[] — the portfolio's source of truth from v3 on
  drawings: 'stk_drawings',     // { SYM: Drawing[] } — chart annotations, per symbol not per widget
  targets: 'stk_targets',       // { key: pct } — allocation targets
  learn: 'stk_learn',           // { seen: string[], tourDone: bool } — education progress
  profiles: 'stk_profiles',
  series: 'stk_series',
  alertlog: 'stk_alertlog',
  popouts: 'stk_popouts',
  workspaces: 'stk_workspaces',
  schema: 'stk_schema',
  lastframe: 'stk_lastframe',   // written by peers.js only; listed so it is swept and measured here
  candles: 'stk_candles',       // OHLCV cache, written by providers only; listed so reclaim/clearAll/measure see it
  meta: 'stk_meta',             // provider-side cache (fundamentals/news/events); same arrangement as candles
  quota: 'stk_quota',           // per-provider call counters, written by providers/base.js; listed so Erase all clears it
};

const DEFAULT_SETTINGS = {
  finnhubKey: '',
  twelvedataKey: '',
  polygonKey: '',
  alphaVantageKey: '',
  alpacaKeyId: '',
  alpacaSecret: '',
  universal: true,         // true: use `selectedProvider` for all symbols; false: auto-route by asset class
  selectedProvider: 'finnhub',   // the provider chosen in Settings (and configured)
  provider: 'finnhub',     // DERIVED: universal ? selectedProvider : 'auto' — the router's input
  interval: 15,            // seconds between refreshes
  notify: false,           // browser Notification on alert
  sound: false,            // beep on alert
  privacy: false,          // blur monetary amounts
  showMarket: true,        // market-status strip
  ack: false,              // one-time disclaimer acknowledged
  // Experience level gates how much of the UI is offered, never what data is
  // kept. The DEFAULT here is for a brand-new browser; an existing user is given
  // 'standard' on first load after the upgrade (see initialLevel) so nothing they
  // already rely on vanishes behind a beginner view.
  level: 'beginner',       // 'beginner' | 'standard' | 'pro'
  baseCurrency: 'USD',     // portfolio totals are converted into this
  costMethod: 'fifo',      // 'fifo' | 'avg' — how sells consume lots
  chartDefaults: { type: 'candle', volume: true, indicators: [] },
};

export const LEVELS = ['beginner', 'standard', 'pro'];
export const COST_METHODS = ['fifo', 'avg'];
export const CHART_TYPES = ['candle', 'ohlc', 'heikin', 'line', 'area', 'baseline'];
export const TXN_TYPES = ['buy', 'sell', 'dividend', 'fee', 'split', 'deposit', 'withdraw', 'interest', 'tax'];
export { PORTFOLIO_SYMBOL };

const DEMO_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'AMD'];

// Session ids a rule may be scoped to — exactly the states for which a session
// isTradeable. An empty list means "every session", which is not the same thing
// as listing all three: [] also covers 'closed' and 'weekend'.
export const SESSIONS = ['pre', 'open', 'post'];

export const SCHEMA_VERSION = 3;

// A shared link seeds the watchlist and nothing else, so only the document state
// is frozen while it is active. Settings stay writable on purpose: a visitor who
// arrives by link and pastes an API key to make that link render must not have it
// silently discarded.
// The workspace layout is frozen too, for the same reason the watchlist is: a
// shared view is someone else's symbols, and dragging a widget around while
// looking at it must not quietly rewrite the arrangement you will come back to.
// exitHash() puts the pre-link layout back in memory as well as on disk.
// The ledger, drawings and allocation targets are the visitor's own records and
// are frozen for the same reason. Learning progress is not: like settings, it is
// about the person, not the document they are looking at.
const HASH_FROZEN = new Set([K.watchlist, K.rules, K.holdings, K.alertlog, K.profiles, K.series, K.workspaces,
  K.ledger, K.drawings, K.targets]);

// The market strip fetches these whatever the watchlist says, so eviction must
// not treat them as orphans.
const PINNED_SYMBOLS = ['SPY', 'QQQ', 'DIA'];

const SERIES_TTL_MS = 3 * 24 * 3600 * 1000;  // survives a weekend gap so Monday still paints a sparkline
const PROFILE_CAP = 200;
const LEDGER_CAP = 20000;                    // a decade of an active account; beyond that it is a broker export
const DRAWINGS_PER_SYMBOL = 50;
const DRAWING_SYMBOLS_CAP = 500;
const NOTE_MAX = 500;
// Validator tables. Declared up here, not beside the validators, because the
// store object below runs them while the module is still initialising.
const RULE_KNOWN = new Set(['id', 'symbol', 'type', 'op', 'value', 'armed', 'sessions', 'note', 'confirm',
  'params', 'repeat', 'expires', 'created', 'unsupported', 'disarmedBy']);
const DISARMED_BY = new Set(['expired', 'fired', 'unsupported']);
const CCY_RE = /^[A-Z0-9]{2,10}$/;
const DRAWING_TYPES = /^[a-z][a-zA-Z0-9-]{0,23}$/;
const HASH_SYMBOL_CAP = 60;                  // a link is not a licence to open 5,000 subscriptions

/* ---- workspace bounds ------------------------------------------------------
   The grid geometry is restated here rather than imported. store.js is pulled in
   by every module on the boot path, and reaching into the widget registry for a
   column count would drag the whole render layer in with it — for two integers
   that are frozen by the layout contract anyway. If workspace.js ever moves off
   a twelve-column grid, these two constants move with it.

   The caps exist because stk_workspaces is as hand-editable as the export file:
   a row index of 1e9 is a grid the browser tries to build, and a tab holding
   200,000 widgets is a boot that never finishes. They are set high enough that
   no real layout can reach them, so truncation is a defence, never a feature. */
const WS_COLS = 12;
const WS_MAX_ROW = 200;
const WS_MAX_TABS = 40;
const WS_MAX_WIDGETS = 120;                  // per tab
const WS_NAME_MAX = 40;
const WS_STATE_MAX = 16000;                  // JSON chars of one widget's own saved state (the notes widget is the big one)

// The kinds widgets.js ships today. Exported for callers that want to offer a
// choice; deliberately NOT used to filter stored layouts — see validWidget().
export const WIDGET_KINDS = ['table', 'cards', 'chart', 'quote', 'portfolio', 'tape', 'alerts', 'session',
  'screener', 'heatmap', 'news', 'calendar', 'fundamentals', 'allocation', 'performance', 'calculator',
  'glossary', 'learn', 'compare', 'movers', 'notes', 'income'];

let quotaHit = false;          // sticky for the session: one silent failure is the whole bug
let lastError = null;
let lastFailedKey = null;
let recovering = false;
let hashSnapshot = null;       // saved state parked in memory while a shared link is being viewed

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}

function lsSet(key, val) {
  if (store.hashActive && HASH_FROZEN.has(key)) return false;
  let json;
  try { json = JSON.stringify(val); }
  catch (e) { lastError = 'serialize'; lastFailedKey = key; return false; }
  try { localStorage.setItem(key, json); return true; }
  catch (e) {
    quotaHit = true;
    lastError = (e && e.name) || 'error';
    lastFailedKey = key;
    // The caches are the only large, refetchable thing in here. Drop them and try
    // once more, so a full quota costs a sparkline rather than an API key.
    if (!recovering) {
      recovering = true;
      try { reclaim(); localStorage.setItem(key, json); return true; }
      catch (e2) { /* out of room for real */ }
      finally { recovering = false; }
    }
    return false;
  }
}

// Last-resort reclaim. Uses removeItem directly rather than the save* helpers so
// it can never re-enter lsSet while lsSet is recovering.
function reclaim() {
  store.series = {};
  store.profiles = {};
  for (const key of [K.series, K.profiles, K.lastframe, K.candles, K.meta]) {
    try { localStorage.removeItem(key); } catch (e) { /* nothing left to try */ }
  }
}

// The one id minter. app.js used to build rule ids its own way ('r' + ms +
// rand); anything new should call this so every id has the same shape.
export function mintId(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

function clone(v, fallback) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return fallback; }
}

const bootSettings = asObject(lsGet(K.settings, {}));
const bootRules = asArray(lsGet(K.rules, []));
const bootHoldings = asArray(lsGet(K.holdings, []));
const bootWatchlist = lsGet(K.watchlist, null);

export const store = {
  settings: shapeSettings(bootSettings, initialLevel(bootSettings, bootWatchlist, bootRules, bootHoldings)),
  watchlist: bootWatchlist,
  rules: bootRules,
  // DEPRECATED (schema v3): the ledger below is the portfolio's source of truth.
  // Kept readable and writable so the current holdings editor keeps working until
  // the portfolio UI moves over; the v3 migration copied it into the ledger once.
  holdings: bootHoldings,
  ledger: shapeLedger(lsGet(K.ledger, [])),
  drawings: shapeDrawings(lsGet(K.drawings, {})),
  targets: shapeTargets(lsGet(K.targets, {})),
  learn: shapeLearn(lsGet(K.learn, null)),
  profiles: asObject(lsGet(K.profiles, {})),
  series: asObject(lsGet(K.series, {})),
  alertlog: asArray(lsGet(K.alertlog, [])),
  // displays.js owns the sub-keys inside this object and normalizes them itself;
  // it must be a plain object, never null and never an array.
  popouts: asObject(lsGet(K.popouts, {})),
  // The tab + widget layout, validated on the way in. null means "nothing usable
  // stored", which is the signal ensureWorkspaces() acts on: the default layout is
  // built from widget metadata that only workspace.js and widgets.js can see, so
  // store.js holds the bytes and lets the caller supply the shape.
  workspaces: shapeWorkspaces(lsGet(K.workspaces, null)),

  saveSettings() { return lsSet(K.settings, this.settings); },
  saveWatchlist() { return lsSet(K.watchlist, this.watchlist); },
  saveRules() { return lsSet(K.rules, this.rules); },
  saveHoldings() { return lsSet(K.holdings, this.holdings); },
  saveProfiles() { return lsSet(K.profiles, this.profiles); },
  saveSeries() { return lsSet(K.series, this.series); },
  saveAlertlog() { return lsSet(K.alertlog, this.alertlog.slice(-100)); },
  savePopouts() { return lsSet(K.popouts, this.popouts); },
  saveLedger() { return lsSet(K.ledger, this.ledger); },
  saveDrawings() { return lsSet(K.drawings, this.drawings); },
  saveTargets() { return lsSet(K.targets, this.targets); },
  saveLearn() { return lsSet(K.learn, this.learn); },

  // Shaped on the way out as well as in. workspace.js edits the live object in
  // place during a drag, so this is the only place the bytes are checked before
  // they land; a model that has become unrecognisable is refused rather than
  // written, which leaves the last good layout on disk instead of replacing it
  // with the thing that broke.
  saveWorkspaces() {
    const shaped = shapeWorkspaces(this.workspaces);
    if (!shaped) return false;
    return lsSet(K.workspaces, shaped);
  },

  /* ---- shared-link (hash) mode --------------------------------------------
     A #AAPL,MSFT link is an EPHEMERAL read-only view. hashActive freezes every
     document-state write, and the state the link displaced is parked in memory so
     leaving the view restores it without a reload. */

  hashSeed() {
    const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
    if (!h) return null;
    const syms = h.split(/[,\s]+/).map(normalizeSymbol).filter(Boolean);
    return syms.length ? [...new Set(syms)].slice(0, HASH_SYMBOL_CAP) : null;
  },

  hashActive: false,

  // Resolve the effective watchlist on boot: a #symbols hash gives the ephemeral
  // view; otherwise saved > demo defaults.
  initWatchlist() {
    const seed = this.hashSeed();
    if (seed) {
      const persisted = Array.isArray(this.watchlist);
      if (!persisted) this.watchlist = [...DEMO_WATCHLIST];
      hashSnapshot = {
        persisted,
        watchlist: this.watchlist.slice(),
        rules: clone(this.rules, []),
        holdings: clone(this.holdings, []),
        alertlog: clone(this.alertlog, []),
        ledger: clone(this.ledger, []),
        drawings: clone(this.drawings, {}),
        targets: clone(this.targets, {}),
        // The caches are frozen too, so whatever the link view fetches lives in
        // memory only; leaving it must put the user's own caches back.
        profiles: clone(this.profiles, {}),
        series: clone(this.series, {}),
        // Snapshotted before workspace.js has run, so this is what is on disk.
        // wsPersisted distinguishes "the user has a saved layout" from "the
        // default was seeded during this link view and has never been written".
        wsPersisted: !!this.workspaces,
        workspaces: clone(this.workspaces, null),
      };
      this.watchlist = seed;
      this.hashActive = true;
      return;
    }
    if (!Array.isArray(this.watchlist)) { this.watchlist = [...DEMO_WATCHLIST]; this.saveWatchlist(); }
  },

  // Keep the link's watchlist as your own. Deliberate, and the only way anything
  // seen in hash mode reaches disk.
  adoptHash() {
    if (!this.hashActive) return false;
    this.hashActive = false;
    hashSnapshot = null;
    this.saveWatchlist(); this.saveRules(); this.saveHoldings();
    this.saveAlertlog(); this.saveProfiles(); this.saveSeries();
    this.saveLedger(); this.saveDrawings(); this.saveTargets();
    // Not the sharer's layout — the link carries symbols only — but the one this
    // browser was refused permission to write while the link was open.
    this.saveWorkspaces();
    stripHash();
    return true;
  },

  // Discard the link and put back what was saved. Nothing is written unless the
  // visitor had no watchlist at all, in which case the defaults become real.
  exitHash() {
    if (!this.hashActive) return false;
    const snap = hashSnapshot;
    this.hashActive = false;
    hashSnapshot = null;
    if (snap) {
      this.watchlist = snap.watchlist;
      this.rules = snap.rules;
      this.holdings = snap.holdings;
      this.alertlog = snap.alertlog;
      this.ledger = snap.ledger;
      this.drawings = snap.drawings;
      this.targets = snap.targets;
      this.profiles = snap.profiles;
      this.series = snap.series;
      if (!snap.persisted) this.saveWatchlist();
      // Any dragging done under the link was never written; put the saved layout
      // back in memory too, so the two agree without a reload. If there was no
      // saved layout, whatever was seeded during the view becomes the real one.
      if (snap.workspaces) adoptWorkspaces(snap.workspaces);
      if (!snap.wsPersisted) this.saveWorkspaces();
    }
    stripHash();
    return true;
  },

  /* ---- watchlist ----------------------------------------------------------- */

  addSymbol(sym) {
    sym = normalizeSymbol(sym);
    if (!Array.isArray(this.watchlist)) this.watchlist = [];
    if (!sym || this.watchlist.includes(sym)) return false;
    this.watchlist.push(sym); this.saveWatchlist(); return true;
  },
  // Removing a symbol from the WATCHLIST drops its alert rules (they watch the
  // list) but deliberately keeps holdings, ledger entries and drawings: those are
  // records of what you own and what you marked, and un-watching a ticker is not
  // a request to forget that you bought it.
  removeSymbol(sym) {
    if (!Array.isArray(this.watchlist)) return;
    this.watchlist = this.watchlist.filter((s) => s !== sym); this.saveWatchlist();
    this.rules = this.rules.filter((r) => r.symbol !== sym); this.saveRules();
  },
  moveSymbol(sym, dir) {
    if (!Array.isArray(this.watchlist)) return;
    const i = this.watchlist.indexOf(sym); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= this.watchlist.length) return;
    const w = this.watchlist; [w[i], w[j]] = [w[j], w[i]]; this.saveWatchlist();
  },

  /* ---- rules --------------------------------------------------------------- */

  rulesFor(sym) { return this.rules.filter((r) => r.symbol === sym); },
  addRule(rule) {
    const r = { ...rule };
    if (!r.id || this.rules.some((x) => x.id === r.id)) r.id = mintId('r');
    if (!r.type) r.type = 'price';
    if (r.repeat !== 'once') r.repeat = 'rearm';
    if (!isDay(r.expires)) r.expires = null;
    if (!Number.isFinite(Number(r.created))) r.created = Date.now();
    // New rules watch regular hours only. Rules that predate the field watch every
    // session (see the v2 migration) and are never narrowed retroactively.
    r.sessions = Array.isArray(r.sessions) ? normalizeSessions(r.sessions) : ['open'];
    this.rules.push(r); this.saveRules(); return r;
  },
  updateRule(id, patch) {
    const r = this.rules.find((x) => x.id === id); if (!r) return null;
    const p = patch && typeof patch === 'object' ? patch : {};
    // Re-arming, or changing what the rule measures, starts it over: a trailing
    // peak, a half-built cross or a latch from the old condition is not evidence
    // about the new one.
    const rearm = p.armed === true && !r.armed;
    const redefined = ['type', 'op', 'value', 'params', 'symbol'].some((k) => k in p && p[k] !== r[k]);
    Object.assign(r, p);
    if (rearm || redefined) {
      for (const k of Object.keys(r)) if (k.charAt(0) === '_') delete r[k];
      delete r.cooldownUntil;
      if (rearm) delete r.disarmedBy;
    }
    if (Array.isArray(r.sessions)) r.sessions = normalizeSessions(r.sessions);
    this.saveRules();
    return r;
  },
  removeRule(id) { this.rules = this.rules.filter((r) => r.id !== id); this.saveRules(); },

  logAlert(entry) { this.alertlog.push(entry); this.saveAlertlog(); },

  /* ---- ledger --------------------------------------------------------------
     Every entry passes validTxn, so the ledger on disk is always in the shape
     portfolio.js expects. Returns the stored txn, or null when it was refused. */

  addTxn(raw) {
    const seen = new Set(this.ledger.map((t) => t.id));
    const t = validTxn(raw, seen);
    if (!t || this.ledger.length >= LEDGER_CAP) return null;
    this.ledger.push(t); this.saveLedger(); return t;
  },
  // Bulk add (a CSV import): one write, and a count of what was refused.
  addTxns(list) {
    const seen = new Set(this.ledger.map((t) => t.id));
    let added = 0, dropped = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const t = this.ledger.length < LEDGER_CAP ? validTxn(raw, seen) : null;
      if (t) { this.ledger.push(t); added++; } else dropped++;
    }
    if (added) this.saveLedger();
    return { added, dropped };
  },
  updateTxn(id, patch) {
    const i = this.ledger.findIndex((t) => t.id === id); if (i < 0) return null;
    const seen = new Set(this.ledger.filter((t) => t.id !== id).map((t) => t.id));
    const t = validTxn({ ...this.ledger[i], ...patch, id }, seen);
    if (!t) return null;
    this.ledger[i] = t; this.saveLedger(); return t;
  },
  removeTxn(id) { this.ledger = this.ledger.filter((t) => t.id !== id); this.saveLedger(); },

  /* ---- drawings / targets / learn ------------------------------------------ */

  drawingsFor(sym) { const d = this.drawings[normalizeSymbol(sym)]; return Array.isArray(d) ? d : []; },
  setDrawings(sym, list) {
    const key = normalizeSymbol(sym); if (!key) return false;
    const shaped = shapeDrawingList(list);
    if (shaped.length) this.drawings[key] = shaped; else delete this.drawings[key];
    return this.saveDrawings();
  },
  setTarget(key, pct) {
    const k = String(key || '').trim().slice(0, 64); if (!k) return false;
    const n = Number(pct);
    if (pct == null || !Number.isFinite(n)) delete this.targets[k];
    else this.targets[k] = Math.max(0, Math.min(100, n));
    return this.saveTargets();
  },
  markSeen(id) {
    const s = String(id || '').slice(0, 64);
    if (!s || this.learn.seen.includes(s)) return false;
    this.learn.seen.push(s); return this.saveLearn();
  },

  /* ---- workspaces ----------------------------------------------------------
     Seed once, then get out of the way. The whole call is wrapped because the
     factory is foreign code running on the boot path: a layout that cannot be
     built is a missing feature, whereas a throw here is a blank application.
     Idempotent by construction — a non-null workspaces is left exactly alone, so
     calling this on a second init() cannot displace what the user is editing. */
  ensureWorkspaces(defaultFactory) {
    try {
      if (this.workspaces) return this.workspaces;
      const seed = typeof defaultFactory === 'function' ? shapeWorkspaces(defaultFactory()) : null;
      if (!seed) return null;
      this.workspaces = seed;
      // Under a shared link this write is refused (see HASH_FROZEN) and the
      // default lives in memory only, which is the correct outcome: the layout
      // becomes real when the visitor adopts or dismisses the link.
      this.saveWorkspaces();
      return this.workspaces;
    } catch (e) { return this.workspaces || null; }
  },

  /* ---- caches -------------------------------------------------------------- */

  cacheProfile(sym, prof) { this.profiles[sym] = prof; this.saveProfiles(); },
  cacheSeries(sym, points) { this.series[sym] = { ts: Date.now(), points }; this.saveSeries(); },

  // TTL + orphan sweep. stk_series and stk_profiles are the only keys that grow
  // without bound, and a browser quota is around 5 MB for the whole origin.
  evictCaches() {
    // Refuse to sweep under a shared link: the reference set would be the sharer's
    // symbols, so the thing evicted would be the user's own cache.
    if (this.hashActive) return { series: 0, profiles: 0, skipped: true };

    const keep = referencedSymbols();
    const now = Date.now();
    let series = 0, profiles = 0;

    for (const sym of Object.keys(this.series)) {
      const ts = Number(this.series[sym] && this.series[sym].ts);
      if (!keep.has(sym) || !Number.isFinite(ts) || now - ts > SERIES_TTL_MS) { delete this.series[sym]; series++; }
    }
    for (const sym of Object.keys(this.profiles)) {
      if (!keep.has(sym)) { delete this.profiles[sym]; profiles++; }
    }
    // Insertion order is the only recency signal a profile carries; drop the oldest.
    const names = Object.keys(this.profiles);
    if (names.length > PROFILE_CAP) {
      for (const sym of names.slice(0, names.length - PROFILE_CAP)) { delete this.profiles[sym]; profiles++; }
    }

    if (series) this.saveSeries();
    if (profiles) this.saveProfiles();
    return { series, profiles, skipped: false };
  },

  // Approximate: localStorage stores UTF-16, so a character costs two bytes.
  storageInfo() {
    const byKey = {};
    let bytes = 0;
    for (const name of Object.keys(K)) {
      const key = K[name];
      let n = 0;
      try { const v = localStorage.getItem(key); if (v != null) n = (key.length + v.length) * 2; }
      catch (e) { n = 0; }
      byKey[name] = n; bytes += n;
    }
    return { bytes, quotaHit, byKey, lastError, lastFailedKey };
  },

  /* ---- import / export ----------------------------------------------------- */

  exportState() {
    const out = {
      _app: 'carino-stocks', _v: SCHEMA_VERSION, exported: new Date().toISOString(),
      watchlist: Array.isArray(this.watchlist) ? this.watchlist : [],
      // Runtime latch bookkeeping (_latched, cooldownUntil) must not travel: a
      // re-imported rule carrying a stale latch would look armed and never fire.
      rules: this.rules.map(stripRuntime),
      // Still exported so a file made here opens in a pre-ledger build.
      holdings: this.holdings.map(stripRuntime),
      ledger: this.ledger.map(stripRuntime),
      drawings: this.drawings,
      targets: this.targets,
      learn: this.learn,
      alertlog: this.alertlog.slice(-100),
      settings: redactKeys(this.settings),
    };
    // The layout travels with the settings — it is the thing a user most wants to
    // carry to a second machine. shapeWorkspaces has already reduced each widget
    // to its persisted fields, so there is no runtime bookkeeping left to strip.
    // Omitted entirely when there is none, rather than exporting a null.
    const ws = shapeWorkspaces(this.workspaces);
    if (ws) out.workspaces = ws;
    return JSON.stringify(out, null, 2);
  },

  // Malformed entries are dropped, never thrown on — a half-usable backup beats a
  // rejected one — and anything missing an id gets one, because deletion in the UI
  // is by id and a hand-written file will not have any.
  importState(json) {
    let d = json;
    if (typeof json === 'string') {
      // A truncated download or the wrong file is a user mistake, not a crash;
      // the caller shows err.message in a toast, so it has to be a sentence.
      try { d = JSON.parse(json); }
      catch (e) { throw new Error('This file is not valid JSON.'); }
    }
    if (!d || typeof d !== 'object' || d._app !== 'carino-stocks') throw new Error('Not a Carino Stocks export file.');
    if (this.hashActive) this.exitHash();   // importing is a deliberate write; leave the link view first

    const dropped = { rules: 0, holdings: 0, ledger: 0, drawings: 0, alertlog: 0, workspaces: 0 };
    const result = { watchlist: 0, rules: 0, holdings: 0, ledger: 0, drawings: 0, targets: 0, alertlog: 0, workspaces: 0, dropped };

    if (Array.isArray(d.watchlist)) {
      this.watchlist = [...new Set(d.watchlist.map(normalizeSymbol).filter(Boolean))];
      this.saveWatchlist();
      result.watchlist = this.watchlist.length;
    }
    if (Array.isArray(d.rules)) {
      const seen = new Set();
      this.rules = [];
      for (const raw of d.rules) {
        const r = validRule(raw, seen);
        if (r) this.rules.push(r); else dropped.rules++;
      }
      this.saveRules();
      result.rules = this.rules.length;
    }
    if (Array.isArray(d.holdings)) {
      const seen = new Set();
      this.holdings = [];
      for (const raw of d.holdings) {
        const h = validHolding(raw, seen);
        if (h) this.holdings.push(h); else dropped.holdings++;
      }
      this.saveHoldings();
      result.holdings = this.holdings.length;
    }
    if (Array.isArray(d.ledger)) {
      const drops = { n: 0 };
      this.ledger = shapeLedger(d.ledger, drops);
      dropped.ledger = drops.n;
      this.saveLedger();
      result.ledger = this.ledger.length;
    } else if (Array.isArray(d.holdings)) {
      // A pre-ledger file: its holdings ARE its portfolio, so they replace the
      // ledger the same way they replaced the holdings above. Leaving the old
      // ledger in place would show a portfolio the imported file never had.
      this.ledger = holdingsToLedger(this.holdings);
      this.saveLedger();
      result.ledger = this.ledger.length;
    }
    if (d.drawings && typeof d.drawings === 'object' && !Array.isArray(d.drawings)) {
      const drops = { n: 0 };
      this.drawings = shapeDrawings(d.drawings, drops);
      dropped.drawings = drops.n;
      this.saveDrawings();
      result.drawings = Object.keys(this.drawings).length;
    }
    if (d.targets && typeof d.targets === 'object' && !Array.isArray(d.targets)) {
      this.targets = shapeTargets(d.targets);
      this.saveTargets();
      result.targets = Object.keys(this.targets).length;
    }
    if (d.learn && typeof d.learn === 'object') {
      this.learn = shapeLearn(d.learn);
      this.saveLearn();
    }
    if (Array.isArray(d.alertlog)) {
      this.alertlog = [];
      for (const raw of d.alertlog) {
        const a = validLogEntry(raw);
        if (a) this.alertlog.push(a); else dropped.alertlog++;
      }
      this.alertlog = this.alertlog.slice(-100);
      this.saveAlertlog();
      result.alertlog = this.alertlog.length;
    }
    // A file with no workspaces key leaves the local layout alone: an export made
    // before this feature existed must not blank the tabs of the machine it is
    // imported into.
    if (d.workspaces && typeof d.workspaces === 'object') {
      const drops = { n: 0 };
      const ws = shapeWorkspaces(d.workspaces, drops);
      dropped.workspaces = drops.n;
      if (ws) {
        adoptWorkspaces(ws);
        this.saveWorkspaces();
        result.workspaces = ws.tabs.length;
      }
    }
    if (d.settings && typeof d.settings === 'object') {
      // Keys are never in the export; keep whatever is already configured locally.
      const s = this.settings;
      const keep = {
        finnhubKey: s.finnhubKey, twelvedataKey: s.twelvedataKey, polygonKey: s.polygonKey,
        alphaVantageKey: s.alphaVantageKey, alpacaKeyId: s.alpacaKeyId, alpacaSecret: s.alpacaSecret,
      };
      // Coerced field by field: a hand-edited interval of "15" or a provider that
      // disagrees with universal/selectedProvider used to be taken on trust.
      this.settings = shapeSettings({ ...d.settings, ...keep }, s.level);
      this.saveSettings();
    }
    // The file is already in the current shape; do not let migrate() run over it again.
    lsSet(K.schema, SCHEMA_VERSION);
    return result;
  },

  // Wipes the disk AND the memory. Leaving the in-memory state populated meant
  // the next save*() from anything still running wrote the "erased" data back.
  // The caller still reloads; this only makes the gap between the two safe.
  clearAll() {
    this.hashActive = false;
    hashSnapshot = null;
    for (const k of Object.values(K)) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
    this.settings = shapeSettings({}, 'beginner');
    this.watchlist = null;
    this.rules = [];
    this.holdings = [];
    this.ledger = [];
    this.drawings = {};
    this.targets = {};
    this.learn = shapeLearn(null);
    this.profiles = {};
    this.series = {};
    this.alertlog = [];
    for (const k of Object.keys(this.popouts)) delete this.popouts[k];
    this.workspaces = null;
  },
};

/* ---- schema migration ------------------------------------------------------
   Explicit and versioned rather than a defaulting accident, because the v2 answer
   for an existing rule is the opposite of the answer for a new one. */
function migrate() {
  let from = 0;
  const raw = lsGet(K.schema, null);
  if (typeof raw === 'number') from = raw;
  else if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.v))) from = Number(raw.v);
  if (from >= SCHEMA_VERSION) return;

  if (from < 2) {
    // Rules gained `sessions`. Anything written before the field existed was firing
    // in every session, so it migrates to [] (all). Giving it the new-rule default
    // of ['open'] would silently stop alerts the user already depends on outside
    // regular hours.
    let touched = false;
    for (const r of store.rules) {
      if (r && typeof r === 'object' && !Array.isArray(r.sessions)) { r.sessions = []; touched = true; }
    }
    if (touched) lsSet(K.rules, store.rules);
  }

  if (from < 3) {
    // The portfolio moved from one-row-per-position holdings to a transaction
    // ledger. Each holding becomes one opening buy dated 1970-01-01 and noted
    // 'migrated', so it is visibly a carried-over balance rather than a trade the
    // user remembers making. Only into an EMPTY ledger: a ledger that already has
    // rows came from somewhere deliberate and must not gain duplicates.
    // stk_holdings itself is left exactly as it was.
    if (!store.ledger.length && store.holdings.length) {
      store.ledger = holdingsToLedger(store.holdings);
      if (store.ledger.length) lsSet(K.ledger, store.ledger);
    }
    // Persist the level chosen at boot, so the decision is made once: by the
    // next visit a brand-new user has a seeded watchlist and would otherwise be
    // re-classified as existing.
    lsSet(K.settings, store.settings);
  }

  lsSet(K.schema, SCHEMA_VERSION);
}
migrate();

/* ---- helpers ---------------------------------------------------------------- */

export function normalizeSymbol(s) {
  return String(s || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
}

export function normalizeSessions(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) { if (SESSIONS.includes(s) && !out.includes(s)) out.push(s); }
  return out;
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

function stripHash() {
  const clean = location.pathname + location.search;
  try { history.replaceState(null, '', clean); return; }
  catch (e) { /* file:// and a few embedded webviews refuse replaceState */ }
  // An empty hash still reloads clean: hashSeed() reads '' and returns null.
  try { location.hash = ''; } catch (e) { /* nothing further to try */ }
}

// Drop underscore-prefixed and known runtime fields. A blacklist rather than a
// whitelist so a field a later feature legitimately persists is not thrown away.
const RUNTIME_FIELDS = new Set(['cooldownUntil']);
function stripRuntime(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.charAt(0) === '_' || RUNTIME_FIELDS.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

function takeId(raw, prefix, seen) {
  // Duplicate ids are as broken as missing ones: the UI deletes by id and would
  // remove both rows.
  let id = (typeof raw === 'string' && raw.trim()) ? raw.trim() : '';
  if (!id || seen.has(id)) id = mintId(prefix);
  seen.add(id);
  return id;
}

/* Rules are rebuilt field by field, but nothing the rule legitimately carries is
   lost: the old whitelist dropped `confirm` (which the engine reads) and would
   have dropped every field added since. Known fields are coerced; unknown
   non-underscore fields with plain JSON values ride along untouched, so a rule
   written by a newer build survives a round trip through this one.

   A type this build does not know is KEPT, as-is, but disarmed and flagged
   `unsupported`. Coercing it to 'price' (the old behaviour) silently turned
   "RSI above 70" into "price above $70". */

function validRule(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const symbol = normalizeRuleSymbol(raw.symbol);
  if (!symbol) return null;
  const r = stripRuntime(raw);
  const typeRaw = r.type == null || r.type === '' ? 'price' : r.type;
  if (typeof typeRaw !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(typeRaw)) return null;
  const def = ALERT_TYPES[typeRaw] || null;

  // A portfolio rule on a ticker, or a ticker rule on the portfolio, measures
  // nothing; it is a broken rule, not an unknown one.
  if (def && (def.needs === 'portfolio') !== (symbol === PORTFOLIO_SYMBOL)) return null;

  let value = Number(r.value);
  if (r.value == null || r.value === '' || !Number.isFinite(value)) {
    if (def && def.fixedValue != null) value = def.fixedValue;
    else if (def && def.defValue != null && r.value == null) value = def.defValue;
    else return null;
  }

  const out = {
    id: takeId(r.id, 'r', seen),
    symbol,
    type: typeRaw,
    op: def ? (def.ops.includes(r.op) ? r.op : def.ops[0]) : (ALERT_OPS.includes(r.op) ? r.op : 'above'),
    value,
    armed: def ? r.armed !== false : false,
    // An imported rule is an existing rule: absent sessions means all of them.
    sessions: normalizeSessions(r.sessions),
    repeat: r.repeat === 'once' ? 'once' : 'rearm',
    expires: isDay(r.expires) ? r.expires : null,
  };
  if (!def) { out.unsupported = true; out.disarmedBy = 'unsupported'; }
  else if (!out.armed && DISARMED_BY.has(r.disarmedBy) && r.disarmedBy !== 'unsupported') out.disarmedBy = r.disarmedBy;
  if (typeof r.note === 'string' && r.note) out.note = r.note.slice(0, NOTE_MAX);
  const confirm = Math.floor(Number(r.confirm));
  if (r.confirm != null && Number.isFinite(confirm) && confirm >= 1) out.confirm = Math.min(confirm, 10);
  const params = shapeParams(r.params, def);
  if (params) out.params = params;
  const created = typeof r.created === 'string' ? Date.parse(r.created) : Number(r.created);
  if (Number.isFinite(created) && created > 0) out.created = created;

  for (const k of Object.keys(r)) {
    if (RULE_KNOWN.has(k) || k in out) continue;
    const v = r[k];
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, NOTE_MAX);
  }
  return out;
}

// Numbers only, keyed by identifier. A known type's params are clamped to the
// ranges its registry entry declares; an unknown type's are kept as given.
function shapeParams(raw, def) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const spec = def ? Object.fromEntries(def.params.map((p) => [p.key, p])) : null;
  for (const k of Object.keys(raw)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(k)) continue;
    const n = Number(raw[k]);
    if (!Number.isFinite(n)) continue;
    const p = spec && spec[k];
    if (spec && !p) continue;
    out[k] = p ? Math.min(p.max != null ? p.max : n, Math.max(p.min != null ? p.min : n, n)) : n;
  }
  return Object.keys(out).length ? out : null;
}

export function normalizeRuleSymbol(s) {
  const t = String(s || '').trim().toUpperCase();
  return t === PORTFOLIO_SYMBOL ? PORTFOLIO_SYMBOL : normalizeSymbol(t);
}

function isDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/* ---- ledger validation -------------------------------------------------------
   Txn = {id, date, type, symbol?, qty?, price?, amount?, fee?, currency, ratio?,
   account?, note?}. What each type requires:
     buy / sell        symbol, qty > 0, price >= 0
     dividend          symbol, amount
     split             symbol, ratio > 0 (4 for a 4:1 split)
     fee / tax / interest / deposit / withdraw   amount (symbol optional)
   A sell's quantity is positive; direction is the type, never the sign. A
   negative quantity from a hand-written file is read as its magnitude. */


function validTxn(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!TXN_TYPES.includes(type)) return null;
  const date = typeof raw.date === 'string' ? raw.date.trim().slice(0, 10) : '';
  if (!isDay(date)) return null;
  const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : NaN));

  const out = { id: takeId(raw.id, 'x', seen), date, type };
  const symbol = normalizeSymbol(raw.symbol);
  const needsSymbol = type === 'buy' || type === 'sell' || type === 'dividend' || type === 'split';
  if (needsSymbol && !symbol) return null;
  if (symbol) out.symbol = symbol;

  if (type === 'buy' || type === 'sell') {
    const qty = n(raw.qty), price = n(raw.price);
    if (qty == null || Number.isNaN(qty) || qty === 0 || price == null || Number.isNaN(price) || price < 0) return null;
    out.qty = Math.abs(qty);
    out.price = price;
  } else if (type === 'split') {
    const ratio = n(raw.ratio);
    if (ratio == null || Number.isNaN(ratio) || ratio <= 0) return null;
    out.ratio = ratio;
  } else {
    const amount = n(raw.amount);
    if (amount == null || Number.isNaN(amount)) return null;
    out.amount = amount;
    // A dividend may also say how many shares it was paid on.
    const qty = n(raw.qty);
    if (qty != null && !Number.isNaN(qty)) out.qty = qty;
  }
  const fee = n(raw.fee);
  if (fee != null && !Number.isNaN(fee)) out.fee = Math.abs(fee);
  const ccy = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  // null = not stated, read as the instrument's own quote currency. Migrated
  // holdings have no currency on record, and inventing 'USD' would misprice
  // every foreign listing they contain.
  out.currency = CCY_RE.test(ccy) ? ccy : null;
  if (typeof raw.account === 'string' && raw.account.trim()) out.account = raw.account.trim().slice(0, 40);
  if (typeof raw.note === 'string' && raw.note) out.note = raw.note.slice(0, NOTE_MAX);
  // A deliberate short sale and a carried-over legacy holding are both facts
  // portfolio.js reads; dropping them turned a short into an oversold error.
  if (type === 'sell' && raw.short === true) out.short = true;
  if (raw.migrated === true) out.migrated = true;
  return out;
}

function shapeLedger(raw, drops) {
  const out = [];
  const seen = new Set();
  for (const t of asArray(raw)) {
    const v = out.length < LEDGER_CAP ? validTxn(t, seen) : null;
    if (v) out.push(v); else if (drops) drops.n++;
  }
  return out;
}

// Mirrors portfolio.js holdingsToTxns (inlined so store.js stays free of the
// portfolio module): one opening trade per holding, dated the epoch and noted
// 'migrated'. Ids derive from the holding's id so running it twice over the
// same holdings yields the same ledger. A short (negative shares) becomes a
// sell; a zero-share row carries no position and is skipped.
export function holdingsToLedger(holdings) {
  const out = [];
  const seen = new Set();
  for (const h of asArray(holdings)) {
    if (!h || typeof h !== 'object') continue;
    const shares = Number(h.shares);
    const symbol = normalizeSymbol(h.symbol);
    if (!symbol || !Number.isFinite(shares) || shares === 0) continue;
    const cost = Number(h.cost) || 0;
    const per = h.costMode === 'total' ? cost / Math.abs(shares) : cost;
    const t = validTxn({
      id: h.id ? 'xm-' + h.id : undefined, date: '1970-01-01', type: shares > 0 ? 'buy' : 'sell',
      symbol, qty: Math.abs(shares), price: Math.max(0, per), fee: 0, currency: null,
      note: h.note ? 'migrated · ' + h.note : 'migrated',
    }, seen);
    if (t) out.push(t);
  }
  return out;
}

/* ---- drawings / targets / learn ---------------------------------------------
   Drawing = {id, type, points:[{t, p}], text?, color?} plus any boolean flags
   (locked, hidden, extend) the chart adds. Anchors are data-space, so a point
   is only valid with a finite time and price. */


function shapeDrawingList(list, drops) {
  const out = [];
  const seen = new Set();
  for (const d of asArray(list)) {
    if (out.length >= DRAWINGS_PER_SYMBOL || !d || typeof d !== 'object' || typeof d.type !== 'string' || !DRAWING_TYPES.test(d.type)) {
      if (drops) drops.n++; continue;
    }
    const points = asArray(d.points)
      .filter((pt) => pt && Number.isFinite(Number(pt.t)) && Number.isFinite(Number(pt.p)))
      .slice(0, 8)
      .map((pt) => ({ t: Number(pt.t), p: Number(pt.p) }));
    if (!points.length) { if (drops) drops.n++; continue; }
    const o = { id: takeId(d.id, 'd', seen), type: d.type, points };
    if (typeof d.text === 'string' && d.text) o.text = d.text.slice(0, 200);
    if (typeof d.color === 'string' && /^[#a-zA-Z0-9(),.\s%-]{1,40}$/.test(d.color)) o.color = d.color;
    for (const k of Object.keys(d)) if (typeof d[k] === 'boolean' && /^[a-z][a-zA-Z]{0,15}$/.test(k)) o[k] = d[k];
    out.push(o);
  }
  return out;
}

function shapeDrawings(raw, drops) {
  const out = {};
  const src = asObject(raw);
  for (const k of Object.keys(src)) {
    const sym = normalizeSymbol(k);
    if (!sym || Object.keys(out).length >= DRAWING_SYMBOLS_CAP) { if (drops) drops.n++; continue; }
    const list = shapeDrawingList(src[k], drops);
    if (list.length) out[sym] = list;
  }
  return out;
}

// Allocation targets: key (a symbol, sector, asset class...) → percent 0..100.
function shapeTargets(raw) {
  const out = {};
  const src = asObject(raw);
  for (const k of Object.keys(src)) {
    const key = String(k).trim().slice(0, 64);
    const n = Number(src[k]);
    if (key && Number.isFinite(n)) out[key] = Math.max(0, Math.min(100, n));
  }
  return out;
}

function shapeLearn(raw) {
  const src = asObject(raw);
  const seen = [...new Set(asArray(src.seen).filter((s) => typeof s === 'string' && s).map((s) => s.slice(0, 64)))].slice(0, 2000);
  return { seen, tourDone: src.tourDone === true };
}

/* ---- settings ----------------------------------------------------------------
   Every known setting is coerced to the type its default has; unknown keys are
   kept as they are, because other modules may persist their own preferences in
   here. `provider` is DERIVED and is always recomputed, never trusted. */

function shapeSettings(raw, level) {
  const src = asObject(raw);
  const s = { ...DEFAULT_SETTINGS, ...src };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const d = DEFAULT_SETTINGS[k], v = s[k];
    if (typeof d === 'boolean') s[k] = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d;
    else if (typeof d === 'string' && typeof v !== 'string') s[k] = d;
  }
  const iv = Number(s.interval);
  s.interval = Number.isFinite(iv) ? Math.max(5, Math.min(3600, Math.round(iv))) : DEFAULT_SETTINGS.interval;
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(s.selectedProvider)) s.selectedProvider = DEFAULT_SETTINGS.selectedProvider;
  s.provider = s.universal ? s.selectedProvider : 'auto';
  s.level = LEVELS.includes(src.level) ? src.level : (LEVELS.includes(level) ? level : DEFAULT_SETTINGS.level);
  s.costMethod = COST_METHODS.includes(s.costMethod) ? s.costMethod : 'fifo';
  const ccy = String(s.baseCurrency || '').trim().toUpperCase();
  s.baseCurrency = /^[A-Z]{3}$/.test(ccy) ? ccy : 'USD';
  s.chartDefaults = shapeChartDefaults(src.chartDefaults);
  return s;
}

function shapeChartDefaults(raw) {
  const src = asObject(raw);
  const indicators = [];
  for (const it of asArray(src.indicators)) {
    if (indicators.length >= 20 || !it || typeof it.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/.test(it.id)) continue;
    const params = {};
    for (const [k, v] of Object.entries(asObject(it.params))) {
      if (/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(k) && Number.isFinite(Number(v))) params[k] = Number(v);
    }
    indicators.push({ id: it.id, params });
  }
  return {
    type: CHART_TYPES.includes(src.type) ? src.type : 'candle',
    volume: typeof src.volume === 'boolean' ? src.volume : true,
    indicators,
  };
}

// New browser → beginner. Anyone who already built something here (a saved
// watchlist, a rule, a holding) → standard, so the upgrade does not hide tools
// they were using. An explicit stored level always wins (shapeSettings).
function initialLevel(settings, watchlist, rules, holdings) {
  const existing = Array.isArray(watchlist) || (Array.isArray(rules) && rules.length > 0)
    || (Array.isArray(holdings) && holdings.length > 0) || settings.ack === true;
  return existing ? 'standard' : 'beginner';
}

function validHolding(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = normalizeSymbol(raw.symbol);
  const shares = Number(raw.shares);
  if (!symbol || !Number.isFinite(shares)) return null;
  const h = stripRuntime(raw);
  const cost = Number(h.cost);
  return {
    id: takeId(h.id, 'h', seen),
    symbol,
    shares,
    cost: Number.isFinite(cost) ? cost : 0,
    costMode: h.costMode === 'total' ? 'total' : 'per',
    note: typeof h.note === 'string' ? h.note : '',
  };
}

/* The log row is written in two passes — the alert engine records the bare
   event, the UI attaches the session and the firing quote — and the export
   carries both. Rebuilding only the bare half here would make an export of the
   user's own file the one thing that strips the session chip and the price
   snapshot out of every row, so the context fields are carried through, coerced
   rather than trusted. */
function validLogEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = Number(raw.ts);
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!Number.isFinite(ts) || !text) return null;

  const out = { ts, symbol: normalizeRuleSymbol(raw.symbol), text };
  if (typeof raw.session === 'string' && raw.session) out.session = raw.session;
  if (typeof raw.sessionLabel === 'string' && raw.sessionLabel) out.sessionLabel = raw.sessionLabel;
  if (typeof raw.scope === 'string' && raw.scope) out.scope = raw.scope;
  if (raw.approx != null) out.approx = !!raw.approx;
  if (typeof raw.ruleId === 'string' && raw.ruleId) out.ruleId = raw.ruleId.slice(0, 64);
  if (typeof raw.type === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(raw.type)) out.type = raw.type;

  const q = raw.quote;
  if (q && typeof q === 'object') {
    // Number(null) is 0, and a null price that returns as 0 would render as a
    // real quote of zero in the log; only an actual number survives.
    const num = (v) => {
      const n = typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    out.quote = {
      price: num(q.price), change: num(q.change), changePct: num(q.changePct),
      ts: num(q.ts), source: typeof q.source === 'string' ? q.source : null,
    };
    if (typeof q.currency === 'string' && CCY_RE.test(q.currency)) out.quote.currency = q.currency;
  }
  return out;
}

/* ---- workspace validation ---------------------------------------------------
   stk_workspaces is written by a drag gesture, edited by hand in devtools, and
   carried in an import file, so it gets the same treatment as an imported rule:
   coerced field by field, malformed entries dropped, nothing thrown. The stakes
   are higher than for a rule, though, because this is the shape the first paint
   is built from — a throw in here is a blank application, not a missing row.

   One thing is deliberately NOT validated: the widget kind is checked for the
   shape of an identifier but not for membership of WIDGET_KINDS. A layout written
   by a later build has to survive a round trip through this one, and widgets.js
   already promises an honest "Unknown widget" placeholder for a kind it does not
   recognise. Dropping the widget instead would silently delete part of a layout
   that the newer build could still open. */

function gridInt(v, lo, hi) {
  const usable = typeof v === 'number' || (typeof v === 'string' && v.trim());
  const n = usable ? Math.floor(Number(v)) : NaN;
  // Absent or unusable geometry is left absent rather than invented here: store.js
  // does not know a widget's natural size, and workspace.js substitutes the
  // registry default for a missing number.
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

// A widget's own saved state — the table's column set and sort order — is opaque:
// the widget canonicalizes it on the way in, and store.js has no business knowing
// what a column id is. Its size is store.js's business, since this is the one
// field a widget can grow without bound. Round-tripping through JSON also drops
// anything unserializable.
function widgetState(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  try {
    const json = JSON.stringify(v);
    if (!json || json.length > WS_STATE_MAX) return null;
    return JSON.parse(json);
  } catch (e) { return null; }
}

function validWidget(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind == null ? '' : raw.kind).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind)) return null;

  const out = {
    id: takeId(raw.id, 'w', seen),
    kind,
    symbol: raw.symbol ? (normalizeSymbol(raw.symbol) || null) : null,
    // Absent flag: a widget pinned to a symbol meant to keep it, anything else
    // meant to follow the workspace. Matches workspace.js's own reading.
    linked: typeof raw.linked === 'boolean' ? raw.linked : !raw.symbol,
  };
  const w = gridInt(raw.w, 1, WS_COLS);
  if (w != null) out.w = w;
  const h = gridInt(raw.h, 1, WS_MAX_ROW);
  if (h != null) out.h = h;
  const col = gridInt(raw.col, 1, WS_COLS - ((w || 1) - 1));
  if (col != null) out.col = col;
  const row = gridInt(raw.row, 1, WS_MAX_ROW);
  if (row != null) out.row = row;
  const state = widgetState(raw.state);
  if (state) out.state = state;
  return out;
}

// Returns the persisted shape, or null when there is nothing usable in it at all
// — which is the caller's cue to seed the default rather than show empty tabs.
// `drops` is an optional { n } counter so the import can report what it skipped.
function shapeWorkspaces(raw, drops) {
  const bump = () => { if (drops) drops.n = (drops.n || 0) + 1; };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return null;
  const seenT = new Set(), seenW = new Set();
  const tabs = [];
  for (const t of raw.tabs) {
    if (!t || typeof t !== 'object' || tabs.length >= WS_MAX_TABS) { bump(); continue; }
    const widgets = [];
    for (const w of Array.isArray(t.widgets) ? t.widgets : []) {
      if (widgets.length >= WS_MAX_WIDGETS) { bump(); continue; }
      const item = validWidget(w, seenW);
      if (item) widgets.push(item); else bump();
    }
    // An empty tab is legal — the user may be about to fill it.
    const name = (typeof t.name === 'string' && t.name.trim()) ? t.name.trim().slice(0, WS_NAME_MAX) : 'Tab';
    tabs.push({ id: takeId(t.id, 't', seenT), name, widgets });
  }
  if (!tabs.length) return null;
  const activeTab = tabs.some((t) => t.id === raw.activeTab) ? raw.activeTab : tabs[0].id;
  return { v: 1, activeTab, tabs };
}

// workspace.js holds a reference to store.workspaces and edits it in place, so
// replacing the object on import or on leaving a shared link would leave the
// running workspace editing an orphan while the store held the new layout.
function adoptWorkspaces(shape) {
  const live = store.workspaces;
  if (live && typeof live === 'object' && !Array.isArray(live)) {
    live.v = 1;
    live.activeTab = shape.activeTab;
    live.tabs = shape.tabs;
  } else {
    store.workspaces = shape;
  }
}

function referencedSymbols() {
  const keep = new Set(PINNED_SYMBOLS);
  const add = (s) => { const n = normalizeSymbol(s); if (n) keep.add(n); };
  if (Array.isArray(store.watchlist)) for (const s of store.watchlist) add(s);
  for (const h of store.holdings) if (h) add(h.symbol);
  for (const t of store.ledger) if (t && t.symbol) add(t.symbol);
  for (const sym of Object.keys(store.drawings)) add(sym);
  for (const r of store.rules) if (r && r.symbol !== PORTFOLIO_SYMBOL) add(r.symbol);
  // A widget can be pinned to a symbol that is not on the watchlist — that is the
  // entire point of pinning one — so its cached profile and series are in use even
  // though nothing else in the store mentions it. Read defensively: this runs on
  // boot, before workspace.js has had a chance to normalize anything.
  const ws = store.workspaces;
  if (ws && Array.isArray(ws.tabs)) {
    for (const t of ws.tabs) {
      if (!t || !Array.isArray(t.widgets)) continue;
      for (const w of t.widgets) if (w) add(w.symbol);
    }
  }
  return keep;
}

function redactKeys(settings) {
  const c = { ...settings };
  for (const k of ['finnhubKey', 'twelvedataKey', 'polygonKey', 'alphaVantageKey', 'alpacaKeyId', 'alpacaSecret']) delete c[k];
  return c;
}
