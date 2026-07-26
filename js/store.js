/* store.js — all persistent state for Carino Stocks.
   Everything lives in localStorage under the stk_ prefix; nothing is ever sent
   anywhere but the data provider the user configured.

   Every write funnels through one guarded lsSet(). That single choke point is
   what makes two otherwise scattered guarantees possible: a shared #symbols link
   can freeze persistence entirely (so viewing someone else's watchlist can never
   overwrite your own), and a full quota is recorded and recovered from instead of
   being swallowed — the old code lost API keys silently once the caches filled. */

const K = {
  settings: 'stk_settings',
  watchlist: 'stk_watchlist',
  rules: 'stk_rules',
  holdings: 'stk_holdings',
  profiles: 'stk_profiles',
  series: 'stk_series',
  alertlog: 'stk_alertlog',
  popouts: 'stk_popouts',
  schema: 'stk_schema',
  lastframe: 'stk_lastframe',   // written by peers.js only; listed so it is swept and measured here
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
};

const DEMO_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'AMD'];

// Session ids a rule may be scoped to — exactly the states for which a session
// isTradeable. An empty list means "every session", which is not the same thing
// as listing all three: [] also covers 'closed' and 'weekend'.
export const SESSIONS = ['pre', 'open', 'post'];

export const SCHEMA_VERSION = 2;

// A shared link seeds the watchlist and nothing else, so only the document state
// is frozen while it is active. Settings stay writable on purpose: a visitor who
// arrives by link and pastes an API key to make that link render must not have it
// silently discarded.
const HASH_FROZEN = new Set([K.watchlist, K.rules, K.holdings, K.alertlog, K.profiles, K.series]);

// The market strip fetches these whatever the watchlist says, so eviction must
// not treat them as orphans.
const PINNED_SYMBOLS = ['SPY', 'QQQ', 'DIA'];

const SERIES_TTL_MS = 3 * 24 * 3600 * 1000;  // survives a weekend gap so Monday still paints a sparkline
const PROFILE_CAP = 200;
const HASH_SYMBOL_CAP = 60;                  // a link is not a licence to open 5,000 subscriptions

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
  for (const key of [K.series, K.profiles, K.lastframe]) {
    try { localStorage.removeItem(key); } catch (e) { /* nothing left to try */ }
  }
}

function mintId(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

function clone(v, fallback) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return fallback; }
}

export const store = {
  settings: { ...DEFAULT_SETTINGS, ...lsGet(K.settings, {}) },
  watchlist: lsGet(K.watchlist, null),
  rules: asArray(lsGet(K.rules, [])),
  holdings: asArray(lsGet(K.holdings, [])),
  profiles: asObject(lsGet(K.profiles, {})),
  series: asObject(lsGet(K.series, {})),
  alertlog: asArray(lsGet(K.alertlog, [])),
  // displays.js owns the sub-keys inside this object and normalizes them itself;
  // it must be a plain object, never null and never an array.
  popouts: asObject(lsGet(K.popouts, {})),

  saveSettings() { return lsSet(K.settings, this.settings); },
  saveWatchlist() { return lsSet(K.watchlist, this.watchlist); },
  saveRules() { return lsSet(K.rules, this.rules); },
  saveHoldings() { return lsSet(K.holdings, this.holdings); },
  saveProfiles() { return lsSet(K.profiles, this.profiles); },
  saveSeries() { return lsSet(K.series, this.series); },
  saveAlertlog() { return lsSet(K.alertlog, this.alertlog.slice(-100)); },
  savePopouts() { return lsSet(K.popouts, this.popouts); },

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
      if (!snap.persisted) this.saveWatchlist();
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
    if (!r.id) r.id = mintId('r');
    // New rules watch regular hours only. Rules that predate the field watch every
    // session (see the v2 migration) and are never narrowed retroactively.
    r.sessions = Array.isArray(r.sessions) ? normalizeSessions(r.sessions) : ['open'];
    this.rules.push(r); this.saveRules(); return r;
  },
  updateRule(id, patch) {
    const r = this.rules.find((x) => x.id === id); if (!r) return null;
    Object.assign(r, patch);
    if (Array.isArray(r.sessions)) r.sessions = normalizeSessions(r.sessions);
    this.saveRules();
    return r;
  },
  removeRule(id) { this.rules = this.rules.filter((r) => r.id !== id); this.saveRules(); },

  logAlert(entry) { this.alertlog.push(entry); this.saveAlertlog(); },

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
    return JSON.stringify({
      _app: 'carino-stocks', _v: SCHEMA_VERSION, exported: new Date().toISOString(),
      watchlist: Array.isArray(this.watchlist) ? this.watchlist : [],
      // Runtime latch bookkeeping (_latched, cooldownUntil) must not travel: a
      // re-imported rule carrying a stale latch would look armed and never fire.
      rules: this.rules.map(stripRuntime),
      holdings: this.holdings.map(stripRuntime),
      alertlog: this.alertlog.slice(-100),
      settings: redactKeys(this.settings),
    }, null, 2);
  },

  // Malformed entries are dropped, never thrown on — a half-usable backup beats a
  // rejected one — and anything missing an id gets one, because deletion in the UI
  // is by id and a hand-written file will not have any.
  importState(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || d._app !== 'carino-stocks') throw new Error('Not a Carino Stocks export file.');
    if (this.hashActive) this.exitHash();   // importing is a deliberate write; leave the link view first

    const dropped = { rules: 0, holdings: 0, alertlog: 0 };
    const result = { watchlist: 0, rules: 0, holdings: 0, alertlog: 0, dropped };

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
    if (d.settings && typeof d.settings === 'object') {
      // Keys are never in the export; keep whatever is already configured locally.
      const s = this.settings;
      const keep = {
        finnhubKey: s.finnhubKey, twelvedataKey: s.twelvedataKey, polygonKey: s.polygonKey,
        alphaVantageKey: s.alphaVantageKey, alpacaKeyId: s.alpacaKeyId, alpacaSecret: s.alpacaSecret,
      };
      this.settings = { ...DEFAULT_SETTINGS, ...d.settings, ...keep };
      this.saveSettings();
    }
    // The file is already in the current shape; do not let migrate() run over it again.
    lsSet(K.schema, SCHEMA_VERSION);
    return result;
  },

  clearAll() {
    this.hashActive = false;
    hashSnapshot = null;
    for (const k of Object.values(K)) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
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

function validRule(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = normalizeSymbol(raw.symbol);
  const value = Number(raw.value);
  if (!symbol || !Number.isFinite(value)) return null;
  const r = stripRuntime(raw);
  const out = {
    id: takeId(r.id, 'r', seen),
    symbol,
    type: r.type === 'pct' ? 'pct' : 'price',
    op: r.op === 'below' ? 'below' : 'above',
    value,
    armed: r.armed !== false,
    // An imported rule is an existing rule: absent sessions means all of them.
    sessions: normalizeSessions(r.sessions),
  };
  if (typeof r.note === 'string' && r.note) out.note = r.note;
  return out;
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

  const out = { ts, symbol: normalizeSymbol(raw.symbol), text };
  if (typeof raw.session === 'string' && raw.session) out.session = raw.session;
  if (typeof raw.sessionLabel === 'string' && raw.sessionLabel) out.sessionLabel = raw.sessionLabel;
  if (typeof raw.scope === 'string' && raw.scope) out.scope = raw.scope;
  if (raw.approx != null) out.approx = !!raw.approx;

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
  }
  return out;
}

function referencedSymbols() {
  const keep = new Set(PINNED_SYMBOLS);
  const add = (s) => { const n = normalizeSymbol(s); if (n) keep.add(n); };
  if (Array.isArray(store.watchlist)) for (const s of store.watchlist) add(s);
  for (const h of store.holdings) if (h) add(h.symbol);
  for (const r of store.rules) if (r) add(r.symbol);
  return keep;
}

function redactKeys(settings) {
  const c = { ...settings };
  for (const k of ['finnhubKey', 'twelvedataKey', 'polygonKey', 'alphaVantageKey', 'alpacaKeyId', 'alpacaSecret']) delete c[k];
  return c;
}
