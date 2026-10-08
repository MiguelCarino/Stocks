// node --test tests/store.test.mjs
// Store migration, settings coercion, import/export and hash-mode isolation.
// Each case loads a FRESH store module (a distinct ?query is a distinct module
// instance) over a Map-backed localStorage seeded for that case.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() { globalThis.location.hash = ''; } };

let n = 0;
async function fresh(seed = {}, hash = '') {
  mem.clear();
  for (const [k, v] of Object.entries(seed)) mem.set(k, JSON.stringify(v));
  globalThis.location.hash = hash;
  return import('../js/store.js?case=' + (++n));
}
const disk = (k) => JSON.parse(mem.get(k) ?? 'null');

test('brand-new browser: beginner, schema 3, level persisted', async () => {
  const { store, SCHEMA_VERSION } = await fresh();
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(store.settings.level, 'beginner');
  assert.equal(disk('stk_schema'), 3);
  assert.equal(disk('stk_settings').level, 'beginner');
  assert.deepEqual(store.ledger, []);
  assert.deepEqual(store.learn, { seen: [], tourDone: false });
  assert.deepEqual(store.settings.chartDefaults, { type: 'candle', volume: true, indicators: [] });
  assert.equal(store.settings.costMethod, 'fifo');
  assert.equal(store.settings.baseCurrency, 'USD');
});

test('v2 → v3: holdings become migrated buys, holdings kept, existing user is standard', async () => {
  const { store } = await fresh({
    stk_schema: 2,
    stk_watchlist: ['AAPL'],
    stk_settings: { interval: 30 },
    stk_holdings: [
      { id: 'h1', symbol: 'AAPL', shares: 10, cost: 150, costMode: 'per', note: '' },
      { id: 'h2', symbol: 'MSFT', shares: 4, cost: 1200, costMode: 'total', note: 'ira' },
      { id: 'h3', symbol: 'ZERO', shares: 0, cost: 1 },
    ],
  });
  assert.equal(store.settings.level, 'standard');
  assert.equal(store.holdings.length, 3, 'deprecated key left intact');
  assert.equal(store.ledger.length, 2);
  const [a, m] = store.ledger;
  assert.deepEqual(a, { id: 'xm-h1', date: '1970-01-01', type: 'buy', symbol: 'AAPL', qty: 10, price: 150, fee: 0, currency: null, note: 'migrated' });
  assert.equal(m.price, 300);
  assert.equal(m.note, 'migrated · ira');
  assert.equal(disk('stk_ledger').length, 2);
  assert.equal(disk('stk_schema'), 3);
});

test('migration never duplicates into a non-empty ledger', async () => {
  const { store } = await fresh({
    stk_schema: 2,
    stk_holdings: [{ id: 'h1', symbol: 'AAPL', shares: 10, cost: 150 }],
    stk_ledger: [{ id: 'x1', date: '2024-01-02', type: 'buy', symbol: 'AAPL', qty: 1, price: 1, currency: 'USD' }],
  });
  assert.equal(store.ledger.length, 1);
});

test('v1 rules get sessions [] and keep their fields', async () => {
  const { store } = await fresh({ stk_rules: [{ id: 'r1', symbol: 'AAPL', type: 'price', op: 'above', value: 1, armed: true, confirm: 3 }] });
  assert.deepEqual(store.rules[0].sessions, []);
  assert.equal(store.rules[0].confirm, 3);
});

test('settings are coerced and provider is re-derived', async () => {
  const { store } = await fresh({ stk_settings: { interval: '2', universal: 'false', selectedProvider: 'polygon', provider: 'finnhub', level: 'pro', costMethod: 'lifo', baseCurrency: 'eur', chartDefaults: { type: 'bogus', indicators: [{ id: 'rsi', params: { period: '14', x: 'y' } }, { id: '!!' }] }, custom: 7 } });
  const s = store.settings;
  assert.equal(s.interval, 5);
  assert.equal(s.universal, false);
  assert.equal(s.provider, 'auto');
  assert.equal(s.level, 'pro');
  assert.equal(s.costMethod, 'fifo');
  assert.equal(s.baseCurrency, 'EUR');
  assert.deepEqual(s.chartDefaults, { type: 'candle', volume: true, indicators: [{ id: 'rsi', params: { period: 14 } }] });
  assert.equal(s.custom, 7, 'unknown settings survive');
});

test('export strips runtime fields and carries the new sections', async () => {
  const { store } = await fresh({ stk_watchlist: ['AAPL'] });
  store.addRule({ symbol: 'AAPL', type: 'rsi', op: 'above', value: 70, armed: true, params: { period: 9 }, repeat: 'once', expires: '2027-01-01' });
  Object.assign(store.rules[0], { _latched: true, _prev: 71, _peak: 3, cooldownUntil: 9 });
  assert.ok(store.addTxn({ date: '2025-03-04', type: 'buy', symbol: 'aapl', qty: 2, price: 10, currency: 'usd' }));
  store.setDrawings('AAPL', [{ type: 'hline', points: [{ t: 1, p: 100 }], locked: true }]);
  store.setTarget('AAPL', 60);
  store.markSeen('rsi');
  store.settings.finnhubKey = 'secret';
  const out = JSON.parse(store.exportState());
  assert.equal(out._v, 3);
  const r = out.rules[0];
  assert.equal(r._latched, undefined); assert.equal(r._prev, undefined); assert.equal(r.cooldownUntil, undefined);
  assert.equal(r.repeat, 'once'); assert.equal(r.expires, '2027-01-01'); assert.ok(r.created > 0);
  assert.equal(out.ledger[0].symbol, 'AAPL'); assert.equal(out.ledger[0].currency, 'USD');
  assert.equal(out.drawings.AAPL[0].locked, true);
  assert.deepEqual(out.targets, { AAPL: 60 });
  assert.deepEqual(out.learn.seen, ['rsi']);
  assert.equal(out.settings.finnhubKey, undefined);

  // Round trip into a different browser.
  const b = await fresh({ stk_settings: { finnhubKey: 'mine' } });
  const res = b.store.importState(JSON.stringify(out));
  assert.equal(res.rules, 1); assert.equal(res.ledger, 1); assert.equal(res.drawings, 1); assert.equal(res.targets, 1);
  assert.deepEqual(b.store.rules[0].params, { period: 9 });
  assert.equal(b.store.rules[0].repeat, 'once');
  assert.equal(b.store.settings.finnhubKey, 'mine');
  assert.deepEqual(b.store.learn.seen, ['rsi']);
});

test('import: bad JSON is a readable error, not a SyntaxError', async () => {
  const { store } = await fresh();
  assert.throws(() => store.importState('{"_app": "carino-st'), { message: 'This file is not valid JSON.' });
  assert.throws(() => store.importState('{"x":1}'), /Not a Carino Stocks export/);
});

test('import: rule validation keeps fields, flags unknown types, drops broken ones', async () => {
  const { store } = await fresh();
  const res = store.importState({
    _app: 'carino-stocks', _v: 3,
    rules: [
      { id: 'a', symbol: 'aapl', type: 'price', op: 'crossAbove', value: '190', confirm: 4, note: 'n', future: 'kept', _junk: 1 },
      { id: 'b', symbol: 'AAPL', type: 'quantumFlux', op: 'above', value: 1, armed: true },
      { id: 'c', symbol: 'AAPL', type: 'rsi', op: 'sideways', value: 30, params: { period: 9999, bogus: 1 } },
      { id: 'd', symbol: '@portfolio', type: 'portfolioDayPct', op: 'below', value: -2 },
      { id: 'e', symbol: 'AAPL', type: 'portfolioValue', value: 1 },
      { id: 'f', symbol: 'AAPL', type: 'newHigh52' },
      { id: 'g', symbol: '', type: 'price', value: 1 },
      { id: 'h', symbol: 'AAPL', type: 'price', value: 'abc' },
    ],
  });
  assert.equal(res.rules, 5); assert.equal(res.dropped.rules, 3);
  const [a, b, c, d, f] = store.rules;
  assert.equal(a.op, 'crossAbove'); assert.equal(a.value, 190); assert.equal(a.confirm, 4); assert.equal(a.future, 'kept'); assert.equal(a._junk, undefined);
  assert.equal(a.repeat, 'rearm'); assert.equal(a.expires, null);
  assert.equal(b.type, 'quantumFlux'); assert.equal(b.armed, false); assert.equal(b.unsupported, true);
  assert.equal(c.op, 'above'); assert.deepEqual(c.params, { period: 100 });
  assert.equal(d.symbol, '@PORTFOLIO');
  assert.equal(f.value, 0);
});

test('import: ledger validation and pre-ledger files', async () => {
  const { store } = await fresh();
  const res = store.importState({
    _app: 'carino-stocks', _v: 3,
    ledger: [
      { date: '2024-02-30', type: 'buy', symbol: 'X', qty: 1, price: 1 },          // impossible date
      { date: '2024-02-01T10:00:00Z', type: 'sell', symbol: 'X', qty: -3, price: 2, fee: -1 },
      { date: '2024-02-01', type: 'dividend', symbol: 'X', amount: 1.5, currency: 'cad' },
      { date: '2024-02-01', type: 'dividend', amount: 1.5 },                    // no symbol
      { date: '2024-02-01', type: 'split', symbol: 'X', ratio: 4 },
      { date: '2024-02-01', type: 'deposit', amount: 1000 },
      { date: '2024-02-01', type: 'teleport', amount: 1 },
    ],
  });
  assert.equal(res.ledger, 4); assert.equal(res.dropped.ledger, 3);
  assert.deepEqual(store.ledger[0], { id: store.ledger[0].id, date: '2024-02-01', type: 'sell', symbol: 'X', qty: 3, price: 2, fee: 1, currency: null });
  assert.equal(store.ledger[1].currency, 'CAD');

  const old = store.importState({ _app: 'carino-stocks', _v: 2, holdings: [{ id: 'h9', symbol: 'IBM', shares: 2, cost: 100 }] });
  assert.equal(old.ledger, 1);
  assert.equal(store.ledger[0].id, 'xm-h9');
});

test('clearAll empties memory as well as disk', async () => {
  const { store } = await fresh({ stk_watchlist: ['AAPL'], stk_rules: [{ id: 'r', symbol: 'AAPL', type: 'price', op: 'above', value: 1, armed: true }] });
  store.addTxn({ date: '2025-01-01', type: 'deposit', amount: 5 });
  store.clearAll();
  assert.equal(mem.size, 0);
  assert.deepEqual(store.rules, []); assert.deepEqual(store.ledger, []); assert.equal(store.watchlist, null);
  store.saveRules();
  assert.deepEqual(disk('stk_rules'), [], 'a late save cannot resurrect erased rules');
});

test('hash mode freezes the new keys and exitHash restores everything', async () => {
  const { store } = await fresh({
    stk_watchlist: ['AAPL'], stk_profiles: { AAPL: { name: 'Apple' } }, stk_series: { AAPL: { ts: 1, points: [1] } },
    stk_ledger: [{ id: 'x1', date: '2024-01-02', type: 'deposit', amount: 1 }],
  }, '#TSLA,NVDA');
  store.initWatchlist();
  assert.equal(store.hashActive, true);
  assert.deepEqual(store.watchlist, ['TSLA', 'NVDA']);
  store.addTxn({ date: '2024-01-03', type: 'deposit', amount: 2 });
  store.setDrawings('TSLA', [{ type: 'hline', points: [{ t: 1, p: 1 }] }]);
  store.profiles.TSLA = { name: 'Tesla' }; store.series.TSLA = { ts: 2, points: [2] };
  assert.equal(disk('stk_ledger').length, 1, 'ledger write refused');
  assert.equal(disk('stk_drawings'), null);
  store.exitHash();
  assert.deepEqual(store.watchlist, ['AAPL']);
  assert.equal(store.ledger.length, 1);
  assert.deepEqual(store.drawings, {});
  assert.equal(store.profiles.TSLA, undefined);
  assert.equal(store.series.TSLA, undefined);
});

test('rules: shared id minter, rearm resets runtime state, removeSymbol keeps the ledger', async () => {
  const { store, mintId } = await fresh({ stk_watchlist: ['AAPL'] });
  assert.match(mintId('r'), /^r[0-9a-z]+$/);
  const r = store.addRule({ symbol: 'AAPL', type: 'price', op: 'above', value: 1, armed: true });
  assert.deepEqual(r.sessions, ['open']);
  Object.assign(r, { armed: false, disarmedBy: 'fired', _latched: true, _peak: 5, cooldownUntil: 99 });
  store.updateRule(r.id, { armed: true });
  assert.equal(r._latched, undefined); assert.equal(r._peak, undefined); assert.equal(r.disarmedBy, undefined); assert.equal(r.cooldownUntil, undefined);
  store.addTxn({ date: '2025-01-01', type: 'buy', symbol: 'AAPL', qty: 1, price: 1 });
  store.removeSymbol('AAPL');
  assert.equal(store.rules.length, 0);
  assert.equal(store.ledger.length, 1);
});

test('workspaces accept every new widget kind', async () => {
  const { store, WIDGET_KINDS } = await fresh();
  for (const k of ['screener', 'heatmap', 'news', 'calendar', 'fundamentals', 'allocation', 'performance', 'calculator', 'glossary', 'learn', 'compare', 'movers', 'notes']) assert.ok(WIDGET_KINDS.includes(k), k);
  store.workspaces = { tabs: [{ id: 't', name: 'All', widgets: WIDGET_KINDS.map((kind) => ({ kind })) }] };
  assert.equal(store.saveWorkspaces(), true);
  assert.equal(disk('stk_workspaces').tabs[0].widgets.length, WIDGET_KINDS.length);
});

test('reclaim drops stk_candles and stk_meta on a full quota', async () => {
  const { store } = await fresh({ stk_candles: { big: 1 }, stk_meta: { m: 1 } });
  const real = globalThis.localStorage.setItem;
  let fails = 1;
  globalThis.localStorage.setItem = (k, v) => { if (fails-- > 0) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } real(k, v); };
  try { assert.equal(store.saveTargets(), true); } finally { globalThis.localStorage.setItem = real; }
  assert.equal(mem.has('stk_candles'), false);
  assert.equal(mem.has('stk_meta'), false);
  assert.ok('candles' in store.storageInfo().byKey);
});
