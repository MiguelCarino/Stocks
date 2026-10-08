// folio.js — FX lookup, currency resolution and the shared valuation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fxFromQuotes, usdPair, fxPairsNeeded, resolveLedger, computePortfolio, positionsCSV, csvCell } from '../js/folio.js';

const Q = {
  EURUSD: { price: 1.1, currency: 'USD' },
  USDMXN: { price: 20, currency: 'MXN' },
  AAPL: { price: 200, prevClose: 190, currency: 'USD' },
  WALMEX: { price: 60, prevClose: 60, currency: 'MXN' },
};

test('fx: direct, inverse, cross through USD, unknown is null', () => {
  const fx = fxFromQuotes(Q);
  assert.equal(fx('USD', 'USD'), 1);
  assert.equal(fx('EUR', 'USD'), 1.1);
  assert.ok(Math.abs(fx('USD', 'EUR') - 1 / 1.1) < 1e-12);
  assert.equal(fx('USD', 'MXN'), 20);
  assert.ok(Math.abs(fx('EUR', 'MXN') - 22) < 1e-9);
  assert.equal(fx('JPY', 'USD'), null);
});

test('usdPair follows market convention', () => {
  assert.equal(usdPair('EUR'), 'EURUSD');
  assert.equal(usdPair('MXN'), 'USDMXN');
  assert.equal(usdPair('USD'), null);
});

test('fxPairsNeeded asks for the USD legs of every foreign currency', () => {
  const ledger = [{ type: 'buy', symbol: 'WALMEX', currency: 'MXN' }, { type: 'buy', symbol: 'AAPL', currency: 'USD' }];
  assert.deepEqual(fxPairsNeeded(ledger, Q, 'USD').sort(), ['USDMXN']);
  assert.deepEqual(fxPairsNeeded(ledger, Q, 'EUR').sort(), ['EURUSD', 'USDMXN']);
  assert.deepEqual(fxPairsNeeded([{ type: 'buy', symbol: 'AAPL', currency: 'USD' }], Q, 'USD'), []);
});

test('resolveLedger fills a missing currency from the quote, leaves cash rows alone', () => {
  const l = [{ type: 'buy', symbol: 'WALMEX', currency: null }, { type: 'deposit', amount: 5, currency: null }];
  const r = resolveLedger(l, Q, () => null);
  assert.equal(r[0].currency, 'MXN');
  assert.equal(r[1].currency, null);
  assert.equal(l[0].currency, null, 'stored ledger untouched');
});

test('computePortfolio converts to the base currency and memoises', () => {
  const ledger = [
    { id: 'a', date: '2024-01-02', type: 'buy', symbol: 'AAPL', qty: 10, price: 150, currency: 'USD' },
    { id: 'b', date: '2024-01-02', type: 'buy', symbol: 'WALMEX', qty: 100, price: 50, currency: 'MXN' },
  ];
  const pf = computePortfolio({ ledger, quotes: Q, baseCurrency: 'USD', method: 'fifo' });
  // 10 × 200 + 100 × 60 / 20
  assert.ok(Math.abs(pf.totals.marketValue - 2300) < 1e-9);
  assert.deepEqual(pf.totals.currencyMissing, []);
  assert.equal(computePortfolio({ ledger, quotes: Q, baseCurrency: 'USD', method: 'fifo' }), pf);
  const mxn = computePortfolio({ ledger, quotes: Q, baseCurrency: 'MXN', method: 'fifo' });
  assert.ok(Math.abs(mxn.totals.marketValue - 46000) < 1e-6);
  const noFx = computePortfolio({ ledger, quotes: { AAPL: Q.AAPL, WALMEX: Q.WALMEX }, baseCurrency: 'USD' });
  assert.deepEqual(noFx.totals.currencyMissing, ['MXN']);
  assert.ok(Math.abs(noFx.totals.marketValue - 2000) < 1e-9, 'pesos are not added at 1:1');
  const one = computePortfolio({ ledger: ledger.map((t, i) => ({ ...t, account: i ? 'GBM' : 'IBKR' })), quotes: Q, account: 'GBM' });
  assert.equal(one.positions.length, 1);
  assert.equal(one.positions[0].symbol, 'WALMEX');
});

test('positionsCSV is spreadsheet-safe', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(-12.5), '-12.5');
  const pf = computePortfolio({ ledger: [{ id: 'z', date: '2024-01-02', type: 'buy', symbol: 'AAPL', qty: 1, price: 100, currency: 'USD' }], quotes: Q });
  const csv = positionsCSV(pf);
  assert.match(csv.split('\r\n')[1], /^AAPL,/);
});
