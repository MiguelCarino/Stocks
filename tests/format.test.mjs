// Price precision: magnitude by default, cents for a known equity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtPrice, fmtMove, priceDecimals, priceKind } from '../js/format.js';

test('a known equity between $1 and $100 prints cents', () => {
  assert.equal(fmtPrice(96.44, 'USD', { kind: 'equity' }), '$96.44');
  assert.equal(fmtMove(1.2, 96.44, { kind: 'equity' }), '1.20');
  assert.equal(priceDecimals(0.5, 'equity'), 4);
  assert.equal(priceDecimals(225.51, 'equity'), 2);
});

test('FX and crypto keep the magnitude rule', () => {
  assert.equal(fmtPrice(1.0848, 'USD', { fx: true }), '1.0848 USD');
  assert.equal(priceDecimals(18.2345, 'fx'), 4);
  assert.equal(fmtMove(0.0012, 1.0848, { kind: 'fx' }), '0.0012');
  assert.equal(priceDecimals(2.3456, 'crypto'), 4);
  assert.equal(priceDecimals(0.000012, 'crypto'), 8);
});

test('no kind keeps the old magnitude rule', () => {
  assert.equal(priceDecimals(96.44), 4);
  assert.equal(priceDecimals(225.51), 2);
});

test('priceKind maps session market ids', () => {
  assert.equal(priceKind('US_EQUITY'), 'equity');
  assert.equal(priceKind('FX'), 'fx');
  assert.equal(priceKind('CRYPTO'), 'crypto');
  assert.equal(priceKind(null), undefined);
});
