/* store.js — all persistent state for Carino Stocks.
   Everything lives in localStorage under the stk_ prefix; nothing is ever sent
   anywhere but the data provider the user configured. */

const K = {
  settings: 'stk_settings',
  watchlist: 'stk_watchlist',
  rules: 'stk_rules',
  holdings: 'stk_holdings',
  profiles: 'stk_profiles',
  series: 'stk_series',
  alertlog: 'stk_alertlog',
};

const DEFAULT_SETTINGS = {
  finnhubKey: '',
  twelvedataKey: '',
  provider: 'auto',        // auto | finnhub | twelvedata | demo
  interval: 15,            // seconds between refreshes
  notify: false,           // browser Notification on alert
  sound: false,            // beep on alert
  privacy: false,          // blur monetary amounts
  showMarket: true,        // market-status strip
  ack: false,              // one-time disclaimer acknowledged
};

const DEMO_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'AMD'];

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode */ }
}

export const store = {
  settings: { ...DEFAULT_SETTINGS, ...lsGet(K.settings, {}) },
  watchlist: lsGet(K.watchlist, null),
  rules: lsGet(K.rules, []),
  holdings: lsGet(K.holdings, []),
  profiles: lsGet(K.profiles, {}),
  series: lsGet(K.series, {}),
  alertlog: lsGet(K.alertlog, []),

  saveSettings() { lsSet(K.settings, this.settings); },
  saveWatchlist() { lsSet(K.watchlist, this.watchlist); },
  saveRules() { lsSet(K.rules, this.rules); },
  saveHoldings() { lsSet(K.holdings, this.holdings); },
  saveProfiles() { lsSet(K.profiles, this.profiles); },
  saveSeries() { lsSet(K.series, this.series); },
  saveAlertlog() { lsSet(K.alertlog, this.alertlog.slice(-100)); },

  // A shared read-only view can be seeded from the URL hash (#AAPL,MSFT,...).
  hashSeed() {
    const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
    if (!h) return null;
    const syms = h.split(/[,\s]+/).map(normalizeSymbol).filter(Boolean);
    return syms.length ? [...new Set(syms)] : null;
  },

  hashActive: false,

  // Resolve the effective watchlist on boot: a #symbols hash gives an EPHEMERAL
  // read-only view (never persisted, so a shared link can't clobber the saved
  // list); otherwise saved > demo defaults.
  initWatchlist() {
    const seed = this.hashSeed();
    if (seed) { this.watchlist = seed; this.hashActive = true; return; } // in-memory only
    if (!Array.isArray(this.watchlist)) { this.watchlist = [...DEMO_WATCHLIST]; this.saveWatchlist(); }
  },

  addSymbol(sym) {
    sym = normalizeSymbol(sym);
    if (!sym || this.watchlist.includes(sym)) return false;
    this.watchlist.push(sym); this.saveWatchlist(); return true;
  },
  removeSymbol(sym) {
    this.watchlist = this.watchlist.filter((s) => s !== sym); this.saveWatchlist();
    this.rules = this.rules.filter((r) => r.symbol !== sym); this.saveRules();
  },
  moveSymbol(sym, dir) {
    const i = this.watchlist.indexOf(sym); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= this.watchlist.length) return;
    const w = this.watchlist; [w[i], w[j]] = [w[j], w[i]]; this.saveWatchlist();
  },

  rulesFor(sym) { return this.rules.filter((r) => r.symbol === sym); },
  addRule(rule) { this.rules.push(rule); this.saveRules(); },
  updateRule(id, patch) {
    const r = this.rules.find((x) => x.id === id); if (r) { Object.assign(r, patch); this.saveRules(); }
  },
  removeRule(id) { this.rules = this.rules.filter((r) => r.id !== id); this.saveRules(); },

  logAlert(entry) { this.alertlog.push(entry); this.saveAlertlog(); },

  cacheProfile(sym, prof) { this.profiles[sym] = prof; this.saveProfiles(); },
  cacheSeries(sym, points) { this.series[sym] = { ts: Date.now(), points }; this.saveSeries(); },

  exportState() {
    return JSON.stringify({
      _app: 'carino-stocks', _v: 1, exported: new Date().toISOString(),
      watchlist: this.watchlist, rules: this.rules, holdings: this.holdings,
      settings: redactKeys(this.settings),
    }, null, 2);
  },
  importState(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || d._app !== 'carino-stocks') throw new Error('Not a Carino Stocks export file.');
    if (Array.isArray(d.watchlist)) { this.watchlist = d.watchlist.map(normalizeSymbol).filter(Boolean); this.saveWatchlist(); }
    if (Array.isArray(d.rules)) { this.rules = d.rules; this.saveRules(); }
    if (Array.isArray(d.holdings)) { this.holdings = d.holdings; this.saveHoldings(); }
    if (d.settings && typeof d.settings === 'object') {
      // Keys are never in the export; keep whatever is already configured locally.
      const keep = { finnhubKey: this.settings.finnhubKey, twelvedataKey: this.settings.twelvedataKey };
      this.settings = { ...DEFAULT_SETTINGS, ...d.settings, ...keep };
      this.saveSettings();
    }
  },
  clearAll() {
    for (const k of Object.values(K)) { try { localStorage.removeItem(k); } catch (e) {} }
  },
};

export function normalizeSymbol(s) {
  return String(s || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
}
function redactKeys(settings) {
  const c = { ...settings }; delete c.finnhubKey; delete c.twelvedataKey; return c;
}
