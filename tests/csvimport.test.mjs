// node --test tests/csvimport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseCSV, parseNumber, parseDate, detectDecimal, detectDateOrder, detectDelimiter, detectPreset, mapRows,
  importCSV, BROKER_PRESETS, dedupe, toCSV, classifyType, krakenPair,
} from '../js/csvimport.js';
import { buildPortfolio } from '../js/portfolio.js';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const strip = (txns) => txns.map(({ id, note, ...t }) => t);

test('parseNumber: locales, currency, negatives', () => {
  const cases = [
    ['1.234,56', 'auto', 1234.56], ['1,234.56', 'auto', 1234.56], ['(1,000.00)', 'auto', -1000], ['-$1,234.56', 'auto', -1234.56],
    ['$-12.30', 'auto', -12.3], ['12,5', 'auto', 12.5], ['1,234', 'auto', 1234], ['1,234', ',', 1.234], ['1.234', ',', 1234],
    ["1'234.50", 'auto', 1234.5], ['4.5S', 'auto', 4.5], ['€ 1.234,00', 'auto', 1234], ['1 234,56', 'auto', 1234.56],
    ['10-', 'auto', -10], ['1.234.567', 'auto', 1234567], ['0.00001', 'auto', 0.00001], ['1e-8', 'auto', 1e-8],
    ['', 'auto', null], ['-', 'auto', null], ['N/A', 'auto', null], ['abc', 'auto', null], [42, 'auto', 42],
  ];
  for (const [s, d, want] of cases) assert.equal(parseNumber(s, d), want, `${s} (${d})`);
});

test('detectDecimal votes across a column', () => {
  assert.equal(detectDecimal(['1.234,56', '12,5', '3']), ',');
  assert.equal(detectDecimal(['1,234.56', '12.5']), '.');
  assert.equal(detectDecimal(['1,234', '5,678']), null);       // genuinely ambiguous
  assert.equal(detectDecimal(['15.01.2024', '12,50']), ',');    // dates are not numbers
});

test('parseDate: formats and order', () => {
  const cases = [
    ['2024-03-05', 'auto', '2024-03-05'], ['03/05/2024', 'MDY', '2024-03-05'], ['03/05/2024', 'DMY', '2024-05-03'],
    ['15/03/2024', 'auto', '2024-03-15'], ['20240305', 'auto', '2024-03-05'], ['20240305;103000', 'auto', '2024-03-05'],
    ['08/15/2024 as of 08/14/2024', 'MDY', '2024-08-15'], ['15-Aug-2024', 'auto', '2024-08-15'], ['Aug 15, 2024', 'auto', '2024-08-15'],
    ['15 ene 2024', 'auto', '2024-01-15'], ['31/02/2024', 'DMY', null], ['2024-01-15, 10:30:00', 'auto', '2024-01-15'],
    ['2024-01-15T23:30:00Z', 'auto', '2024-01-15'], ['1/6/24', 'MDY', '2024-01-06'], ['15.03.2024', 'DMY', '2024-03-15'], ['garbage', 'auto', null],
  ];
  for (const [s, o, want] of cases) assert.equal(parseDate(s, o), want, `${s} (${o})`);
  assert.equal(detectDateOrder(['01/02/2024', '13/02/2024']), 'DMY');
  assert.equal(detectDateOrder(['01/02/2024', '02/13/2024']), 'MDY');
  assert.equal(detectDateOrder(['01/02/2024', '02/03/2024']), null);
});

test('parseCSV: RFC 4180, delimiters, BOM, embedded newlines', () => {
  const p = parseCSV('﻿a;b;c\n1;"x;y";"multi\nline"\n2;"he said ""hi""";\n');
  assert.equal(p.delimiter, ';');
  assert.deepEqual(p.headers, ['a', 'b', 'c']);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].b, 'x;y'); assert.equal(p.rows[0].c, 'multi\nline'); assert.equal(p.rows[1].b, 'he said "hi"');
  assert.equal(p.rows[1]._line, 4);
  assert.equal(detectDelimiter('a\tb\tc\n1\t2,5\t3\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1,5;2,5;3\n4,5;5;6\n'), ';');
  // blank header cells inherit the previous name (Degiro currency columns)
  assert.deepEqual(parseCSV('Price,,Total,\n1,USD,2,EUR\n').headers, ['Price', 'Price [2]', 'Total', 'Total [2]']);
});

test('every preset has a fixture that it detects', () => {
  const files = { 'generic': 'generic-es.csv', 'ibkr-flex': 'ibkr-flex.csv', 'ibkr-statement': 'ibkr-statement.csv', 'schwab': 'schwab.csv',
                  'fidelity': 'fidelity.csv', 'vanguard': 'vanguard.csv', 'robinhood': 'robinhood.csv', 'etoro': 'etoro.csv',
                  'trading212': 'trading212.csv', 'degiro': 'degiro.csv', 'gbm': 'gbm.csv', 'bitso': 'bitso.csv',
                  'coinbase': 'coinbase.csv', 'kraken': 'kraken.csv' };
  for (const p of BROKER_PRESETS) {
    assert.ok(files[p.id], `fixture for ${p.id}`);
    const parsed = parseCSV(fixture(files[p.id]));
    assert.equal(parsed.preset, p.id, files[p.id]);
  }
});

test('Schwab: actions, $ amounts, "as of" dates, short sale, split ratio from added shares', () => {
  const r = importCSV(fixture('schwab.csv'));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const t = strip(r.txns);
  assert.equal(t.length, 12);
  assert.deepEqual(t[1], { date: '2024-01-16', type: 'buy', currency: 'USD', symbol: 'AAPL', qty: 10, price: 185, fee: 0 });
  assert.deepEqual(t[2], { date: '2024-01-20', type: 'dividend', currency: 'USD', symbol: 'AAPL', amount: 2.4 });
  assert.equal(t[4].type, 'buy'); assert.equal(t[4].qty, 0.0213);                        // Reinvest Shares
  assert.deepEqual(t[5], { date: '2024-01-25', type: 'sell', currency: 'USD', symbol: 'AAPL', qty: 4, price: 195.5, fee: 0.65 });
  assert.equal(t[6].type, 'tax'); assert.equal(t[6].amount, 0.36);
  assert.equal(t[7].type, 'deposit'); assert.equal(t[7].amount, 5000);
  assert.equal(t[8].type, 'fee');                                                        // margin interest is a cost
  assert.equal(t[9].type, 'interest');
  assert.equal(t[10].short, true);
  assert.deepEqual(t[11], { date: '2024-01-30', type: 'split', currency: 'USD', symbol: 'NVDA', ratio: 10 });   // (10+90)/10
  // and the ledger reads it: NVDA 100 shares @50, TSLA short
  const p = buildPortfolio(r.txns, {}, { today: '2024-12-31' });
  const nv = p.positions.find((x) => x.symbol === 'NVDA');
  assert.equal(nv.qty, 100); assert.equal(nv.avgCost, 50);
  assert.equal(p.positions.find((x) => x.symbol === 'TSLA').qty, -2);
  assert.equal(p.errors.length, 0);
});

test('Fidelity: preamble, footer, negative sell qty, two fee columns', () => {
  const r = importCSV(fixture('fidelity.csv'));
  const t = strip(r.txns);
  assert.equal(t.length, 6); assert.equal(r.errors.length, 0);
  assert.deepEqual(t.map((x) => x.type), ['buy', 'dividend', 'buy', 'sell', 'deposit', 'tax']);
  assert.equal(t[3].qty, 5); assert.equal(t[3].fee, 0.02);
});

test('Vanguard: second header block, sweep skipped, account kept', () => {
  const r = importCSV(fixture('vanguard.csv'));
  assert.deepEqual(r.txns.map((x) => x.type), ['buy', 'dividend', 'sell', 'deposit']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.txns[2].qty, 4); assert.equal(r.txns[0].account, '12345678');
});

test('Robinhood: codes, parentheses amounts, options skipped, split "4.5S"', () => {
  const r = importCSV(fixture('robinhood.csv'));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual(r.txns.map((x) => x.type), ['buy', 'dividend', 'deposit', 'withdraw', 'sell', 'fee', 'split']);
  assert.equal(r.txns[3].amount, 200);
  assert.equal(r.txns[6].ratio, 4);       // held 1.5, +4.5 -> 6
  assert.match(r.skipped[0].reason, /Options/);
});

test('Interactive Brokers: Flex trades and Activity Statement sections', () => {
  const f = importCSV(fixture('ibkr-flex.csv'));
  assert.deepEqual(strip(f.txns).map((x) => [x.type, x.qty, x.price, x.fee, x.currency]),
    [['buy', 10, 185.5, 1, 'USD'], ['sell', 4, 180, 1.0004, 'USD'], ['buy', 2, 850, 3, 'EUR']]);
  const s = importCSV(fixture('ibkr-statement.csv'));
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors));
  assert.deepEqual(s.txns.map((x) => x.type), ['buy', 'sell', 'dividend', 'tax', 'deposit', 'fee', 'interest', 'split']);
  assert.equal(s.txns[3].amount, 0.36); assert.equal(s.txns[5].amount, 10); assert.equal(s.txns[7].ratio, 4);
  assert.equal(s.txns[4].date, '2024-01-02');
  assert.equal(s.skipped.length, 1);      // forex conversion
});

test('eToro: DD/MM dates, price from amount/units', () => {
  const r = importCSV(fixture('etoro.csv'));
  assert.equal(r.locale.dateOrder, 'DMY');
  assert.deepEqual(r.txns.map((x) => x.type), ['deposit', 'buy', 'dividend', 'sell', 'fee']);
  assert.ok(Math.abs(r.txns[1].price - 185) < 1e-3);
  assert.equal(r.txns[0].date, '2024-01-02');
});

test('Trading 212: fees converted to instrument currency, dividend + withholding', () => {
  const r = importCSV(fixture('trading212.csv'));
  const t = strip(r.txns);
  assert.deepEqual(t.map((x) => x.type), ['deposit', 'buy', 'dividend', 'tax', 'sell', 'interest']);
  assert.equal(t[1].fee, 1.25); assert.equal(t[1].currency, 'USD');
  assert.equal(t[2].amount, 0.6); assert.equal(t[3].amount, 0.09);
  assert.equal(t[0].currency, 'GBP');
});

test('Degiro: decimal comma, unnamed currency columns, DD-MM-YYYY', () => {
  const r = importCSV(fixture('degiro.csv'));
  assert.equal(r.locale.decimal, ',');
  const t = strip(r.txns);
  assert.deepEqual(t[0], { date: '2024-01-15', type: 'buy', currency: 'USD', symbol: 'US0378331005', qty: 10, price: 185.5, fee: 2.1812 });
  assert.equal(t[1].type, 'sell'); assert.equal(t[1].qty, 4);
  assert.ok(r.warnings.some((w) => /ISIN/.test(w)));
});

test('GBM+: Spanish headers, serie appended, ISR as tax, commission + IVA', () => {
  const r = importCSV(fixture('gbm.csv'));
  const t = strip(r.txns);
  assert.deepEqual(t.map((x) => x.type), ['buy', 'buy', 'dividend', 'tax', 'sell', 'deposit']);
  assert.equal(t[0].symbol, 'WALMEX'); assert.equal(t[1].symbol, 'AMXB');
  assert.equal(t[0].fee, 10.25); assert.equal(t[0].currency, 'MXN');
});

test('Bitso, Coinbase, Kraken: crypto pairs, fees, income and converts', () => {
  const b = strip(importCSV(fixture('bitso.csv')).txns);
  assert.deepEqual(b[0], { date: '2024-01-16', type: 'buy', currency: 'MXN', symbol: 'BTC', qty: 0.01, price: 720000, fee: 7.2 });
  const c = importCSV(fixture('coinbase.csv'));
  assert.deepEqual(c.txns.map((x) => `${x.type}:${x.symbol || x.currency}`),
    ['deposit:USD', 'buy:BTC', 'interest:USD', 'buy:ETH', 'sell:ETH', 'buy:BTC', 'sell:BTC']);
  assert.equal(c.txns[5].qty, 0.00005); assert.equal(c.txns[5].price, 48000);
  assert.equal(c.skipped.length, 1);
  const k = strip(importCSV(fixture('kraken.csv')).txns);
  assert.deepEqual(k.map((x) => `${x.symbol}/${x.currency}`), ['BTC/USD', 'ETH/USD', 'SOL/EUR']);
  assert.deepEqual(krakenPair('XXBTZEUR'), ['BTC', 'EUR']);
  assert.deepEqual(krakenPair('XETHXXBT'), ['ETH', 'BTC']);
  // coinbase ledger: BTC 0.01 − 0.005 + 0.00005
  const p = buildPortfolio(c.txns, {}, { today: '2024-12-31' });
  assert.ok(Math.abs(p.positions.find((x) => x.symbol === 'BTC').qty - 0.00505) < 1e-12);
});

test('Generic Spanish file: BOM, semicolon, decimal comma, DD/MM, Spanish actions', () => {
  const r = importCSV(fixture('generic-es.csv'));
  assert.equal(r.preset, 'generic'); assert.equal(r.locale.decimal, ','); assert.equal(r.locale.dateOrder, 'DMY');
  assert.deepEqual(strip(r.txns), [
    { date: '2024-03-05', type: 'buy', currency: 'EUR', symbol: 'SAN.MC', qty: 100, price: 3.85, fee: 2.5 },
    { date: '2024-03-15', type: 'sell', currency: 'EUR', symbol: 'SAN.MC', qty: 40, price: 4.1, fee: 2.5 },
    { date: '2024-03-20', type: 'dividend', currency: 'EUR', symbol: 'SAN.MC', amount: 8.4 },
  ]);
  assert.equal(r.txns[0].note, 'Primera; compra');
});

test('custom mapping with a typeMap, ambiguous dates warn', () => {
  const p = parseCSV('When,What,Ticker,N,Px\n01/02/2024,Acquire,ABC,5,10\n02/03/2024,Dispose,ABC,2,12\n');
  assert.equal(detectPreset(p.headers), null);
  const r = mapRows(p.rows, { columns: { date: 'When', type: 'What', symbol: 'Ticker', qty: 'N', price: 'Px' },
                              typeMap: { Acquire: 'buy', Dispose: 'sell' }, currency: 'CAD' });
  assert.deepEqual(r.txns.map((x) => [x.type, x.date, x.currency]), [['buy', '2024-01-02', 'CAD'], ['sell', '2024-02-03', 'CAD']]);
  assert.ok(r.warnings.some((w) => /ambiguous/.test(w)));
  const d = mapRows(p.rows, { columns: { date: 'When', type: 'What', symbol: 'Ticker', qty: 'N', price: 'Px' }, typeMap: { Acquire: 'buy', Dispose: 'sell' } }, { dateOrder: 'DMY' });
  assert.equal(d.txns[0].date, '2024-02-01');
});

test('row errors carry row and line; unknown actions are skipped, not guessed', () => {
  const r = importCSV('date,type,symbol,qty,price\n2024-01-01,buy,AAA,1,10\nnot a date,buy,BBB,1,1\n2024-01-03,teleport,CCC,1,1\n2024-01-04,buy,,1,1\n');
  assert.equal(r.txns.length, 1);
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].line, 3);
  assert.equal(r.skipped.length, 1);
});

test('classifyType vocabulary', () => {
  assert.equal(classifyType('Withholding tax on dividend'), 'tax');
  assert.equal(classifyType('Dividend reinvestment'), 'dividend');
  assert.equal(classifyType('Compra'), 'buy');
  assert.equal(classifyType('Venda'), 'sell');
  assert.equal(classifyType('Taxa de corretagem'), 'fee');
  assert.equal(classifyType('Juros sobre capital'), 'interest');
  assert.equal(classifyType('ACH'), 'cash');
});

test('dedupe by fingerprint counts legitimate identical rows', () => {
  const t = { date: '2024-01-01', type: 'buy', symbol: 'A', qty: 1, price: 10 };
  const { fresh, duplicates } = dedupe([t], [{ ...t }, { ...t }, { ...t, qty: 2 }]);
  assert.equal(duplicates.length, 1); assert.equal(fresh.length, 2);
  // same file twice gives the same ids
  const a = importCSV(fixture('schwab.csv')).txns.map((x) => x.id), b = importCSV(fixture('schwab.csv')).txns.map((x) => x.id);
  assert.deepEqual(a, b); assert.equal(new Set(a).size, a.length);
});

test('toCSV round-trips through the generic preset (shorts included)', () => {
  const src = importCSV(fixture('schwab.csv')).txns;
  const back = importCSV(toCSV(src));
  assert.equal(back.preset, 'generic');
  assert.equal(back.errors.length, 0, JSON.stringify(back.errors));
  assert.deepEqual(strip(back.txns), strip(src));
});
