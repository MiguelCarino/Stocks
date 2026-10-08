// node --test tests/portfolio.test.mjs
// Expected numbers are hand-computed (worked in the comments), not snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPortfolio, holdingsToTxns, xirr, twr, twrSeries, annualize, riskMetrics, maxDrawdown, stdev,
  allocation, drift, positionSize, riskReward, breakEven, recoveryGain, dividendIncome, portfolioHistory,
  investorFlows, normalizeTxn, simpleReturns, OTHER,
} from '../js/portfolio.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
const buy = (date, symbol, qty, price, extra = {}) => ({ id: `${date}${symbol}b${qty}`, date, type: 'buy', symbol, qty, price, currency: 'USD', ...extra });
const sell = (date, symbol, qty, price, extra = {}) => ({ id: `${date}${symbol}s${qty}`, date, type: 'sell', symbol, qty, price, currency: 'USD', ...extra });
const TODAY = '2024-12-31';

test('FIFO vs average cost: realized differs, total return does not', () => {
  // 10 @100, 10 @120, sell 15 @130.
  // FIFO: 10×30 + 5×10 = 350 realized; 5 left @120 (600).
  // Avg : avg 110, 15×20 = 300 realized; 5 left @110 (550).
  const txns = [buy('2024-01-02', 'X', 10, 100), buy('2024-02-01', 'X', 10, 120), sell('2024-03-01', 'X', 15, 130)];
  const q = { X: { price: 125, prevClose: 125 } };
  const f = buildPortfolio(txns, q, { method: 'fifo', today: TODAY });
  const a = buildPortfolio(txns, q, { method: 'avg', today: TODAY });
  near(f.totals.realized, 350); near(a.totals.realized, 300);
  near(f.positions[0].costBasis, 600); near(a.positions[0].costBasis, 550);
  near(f.positions[0].avgCost, 120); near(a.positions[0].avgCost, 110);
  near(f.totals.unrealized, 25); near(a.totals.unrealized, 75);
  near(f.totals.realized + f.totals.unrealized, a.totals.realized + a.totals.unrealized);
  assert.equal(f.positions[0].lots.length, 1);
  assert.equal(f.realizedEvents.length, 2);           // one per consumed lot
  near(f.positions[0].weight, 100);
});

test('LIFO consumes the newest lot first', () => {
  const txns = [buy('2024-01-02', 'X', 10, 100), buy('2024-02-01', 'X', 10, 120), sell('2024-03-01', 'X', 15, 130)];
  const p = buildPortfolio(txns, {}, { method: 'lifo', today: TODAY });
  near(p.totals.realized, 10 * 10 + 5 * 30);          // 10×(130−120) + 5×(130−100)
  near(p.positions[0].costBasis, 500);
});

test('fees go into cost basis and out of proceeds; cash tracks deposits', () => {
  // buy 10 @100 fee 10 -> basis 1010 (avg 101). sell 10 @110 fee 10 -> net 1090. realized 80.
  // cash: 2000 − 1010 + 1090 = 2080.
  const txns = [{ date: '2024-01-01', type: 'deposit', amount: 2000, currency: 'USD' },
                buy('2024-01-02', 'X', 10, 100, { fee: 10 }), sell('2024-02-01', 'X', 10, 110, { fee: 10 })];
  const p = buildPortfolio(txns, {}, { today: TODAY });
  near(p.totals.realized, 80);
  near(p.cash.USD, 2080);
  near(p.totals.fees, 20);
  near(p.totals.netWorth, 2080);
  assert.equal(p.totals.cashTracked, true);
  assert.equal(p.positions.length, 0);
  assert.equal(p.closedPositions.length, 1);
  const ev = p.realizedEvents[0];
  near(ev.basis, 1010); near(ev.proceeds, 1090); near(ev.pl, 80);
  assert.equal(ev.term, 'short'); assert.equal(ev.holdingDays, 30);
});

test('without deposits cash is not tracked (no fake negative balance)', () => {
  const p = buildPortfolio([buy('2024-01-02', 'X', 10, 100)], { X: { price: 110 } }, { today: TODAY });
  assert.equal(p.totals.cashTracked, false);
  assert.deepEqual(p.cash, {});
  near(p.totals.netWorth, 1100);
});

test('split mid-holding adjusts lots, keeps cost', () => {
  // 10 @400, 4:1 split -> 40 @100; buy 10 @105; sell 45 @110 FIFO:
  // 40×10 + 5×5 = 425; left 5 @105.
  const txns = [buy('2024-01-02', 'X', 10, 400), { date: '2024-06-01', type: 'split', symbol: 'X', ratio: 4, currency: 'USD' },
                buy('2024-07-01', 'X', 10, 105), sell('2024-08-01', 'X', 45, 110)];
  const p = buildPortfolio(txns, { X: { price: 110 } }, { today: TODAY });
  near(p.totals.realized, 425);
  near(p.positions[0].qty, 5);
  near(p.positions[0].avgCost, 105);
  // ratio as a string and a reverse split
  const r = buildPortfolio([buy('2024-01-02', 'Y', 100, 1), { date: '2024-02-01', type: 'split', symbol: 'Y', ratio: '1:10' }], {}, { today: TODAY });
  near(r.positions[0].qty, 10); near(r.positions[0].avgCost, 10); near(r.positions[0].costBasis, 100);
});

test('a split before the buy does not touch later lots; same-day split applies before trades', () => {
  const txns = [buy('2024-06-01', 'X', 10, 100), { date: '2024-06-01', type: 'split', symbol: 'X', ratio: 2 }];
  const p = buildPortfolio(txns, {}, { today: TODAY });
  near(p.positions[0].qty, 10);   // split sorted first that day: the buy is already post-split
});

test('sell larger than holding is an error, not a short', () => {
  const p = buildPortfolio([buy('2024-01-02', 'X', 5, 10), sell('2024-02-01', 'X', 8, 12)], {}, { today: TODAY });
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /exceeds/);
  near(p.totals.realized, 10);   // only the 5 held: 5×2
  assert.equal(p.positions.length, 0);
});

test('explicit short (negative sell qty) and cover', () => {
  // short 10 @50, cover @40 -> +100
  const p = buildPortfolio([sell('2024-01-02', 'X', -10, 50), buy('2024-02-01', 'X', 10, 40)], {}, { today: TODAY });
  assert.equal(p.errors.length, 0);
  near(p.totals.realized, 100);
  assert.equal(p.realizedEvents[0].side, 'short');
  // open short marked to market: −10 @50, price 45 -> +50 unrealized
  const o = buildPortfolio([sell('2024-01-02', 'X', -10, 50)], { X: { price: 45, prevClose: 46 } }, { today: TODAY });
  near(o.positions[0].qty, -10); near(o.positions[0].unrealized, 50); near(o.positions[0].dayPL, 10);
});

test('day P/L uses the fill price for lots bought today and counts today\'s sells', () => {
  // old lot 10 (bought earlier), new lot 5 @105 today, sell 2 @109 today (FIFO from old lot).
  // price 110, prevClose 108:
  //   remaining old 8 × (110−108) = 16; today lot 5 × (110−105) = 25; sold 2 × (109−108) = 2 -> 43
  const today = '2024-05-10';
  const txns = [buy('2024-05-01', 'X', 10, 100), buy(today, 'X', 5, 105), sell(today, 'X', 2, 109)];
  const p = buildPortfolio(txns, { X: { price: 110, prevClose: 108 } }, { today });
  near(p.positions[0].dayPL, 43);
  near(p.totals.dayPL, 43);
  // prev-value base: 8×108 + 5×105 + 2×108 = 1605
  near(p.positions[0].dayPLPct, 43 / 1605 * 100);
});

test('multi-currency: converted via fx, unknown currency listed and excluded', () => {
  const fx = (from, to) => (from === 'MXN' && to === 'USD' ? 0.05 : null);
  const txns = [buy('2024-01-02', 'AAPL', 10, 100), { ...buy('2024-01-02', 'AMXB', 100, 20), currency: 'MXN' },
                { ...buy('2024-01-02', '7203.T', 100, 2000), currency: 'JPY' }];
  const q = { AAPL: { price: 110, currency: 'USD' }, AMXB: { price: 22, currency: 'MXN' }, '7203.T': { price: 2100, currency: 'JPY' } };
  const p = buildPortfolio(txns, q, { fx, baseCurrency: 'USD', today: TODAY });
  // 1100 + 2200 MXN × 0.05 = 1100 + 110
  near(p.totals.marketValue, 1210);
  near(p.totals.costBasis, 1000 + 100);
  assert.deepEqual(p.totals.currencyMissing, ['JPY']);
  const jp = p.positions.find((x) => x.symbol === '7203.T');
  assert.equal(jp.valueBase, null); assert.equal(jp.weight, null);
  near(jp.marketValue, 210000);   // still valued in its own currency
});

test('quote currency different from trade currency is converted into the position currency', () => {
  const fx = (f, t) => (f === 'USD' && t === 'MXN' ? 20 : f === 'MXN' && t === 'USD' ? 0.05 : null);
  const p = buildPortfolio([{ ...buy('2024-01-02', 'AAPL', 1, 2000), currency: 'MXN' }], { AAPL: { price: 110, currency: 'USD' } }, { fx, baseCurrency: 'MXN', today: TODAY });
  near(p.positions[0].price, 2200); near(p.totals.unrealized, 200);
});

test('dividends, interest, taxes and standalone fees reach totals and cash', () => {
  const txns = [{ date: '2024-01-01', type: 'deposit', amount: 1000, currency: 'USD' },
                buy('2024-01-02', 'X', 10, 50),
                { date: '2024-03-01', type: 'dividend', symbol: 'X', amount: 20, currency: 'USD' },
                { date: '2024-03-01', type: 'tax', symbol: 'X', amount: 3, currency: 'USD' },
                { date: '2024-03-02', type: 'dividend', symbol: 'X', price: 0.5, currency: 'USD' },   // per share × 10 held
                { date: '2024-04-01', type: 'interest', amount: 2, currency: 'USD' },
                { date: '2024-04-02', type: 'fee', amount: 1, currency: 'USD' },
                { date: '2024-05-01', type: 'withdraw', amount: 100, currency: 'USD' }];
  const p = buildPortfolio(txns, { X: { price: 50 } }, { today: TODAY });
  near(p.totals.dividends, 25);
  near(p.totals.taxes, 3);
  near(p.totals.interest, 2);
  near(p.totals.feesStandalone, 1);
  near(p.cash.USD, 1000 - 500 + 20 - 3 + 5 + 2 - 1 - 100);
  near(p.totals.totalReturn, 0 + 0 + 25 + 2 - 1 - 3);
});

test('multi-account: same symbol in two accounts stays two positions', () => {
  const p = buildPortfolio([buy('2024-01-02', 'X', 1, 10, { account: 'IRA' }), buy('2024-01-02', 'X', 2, 20, { account: 'Taxable' })], { X: { price: 30 } }, { today: TODAY });
  assert.equal(p.positions.length, 2);
  near(p.totals.marketValue, 90);
});

test('crypto fractional quantities survive (satoshis are not float dust)', () => {
  const p = buildPortfolio([buy('2024-01-02', 'BTC', 0.00012345, 40000), sell('2024-02-01', 'BTC', 0.0001, 50000)], { BTC: { price: 60000 } }, { today: TODAY });
  near(p.positions[0].qty, 0.00002345, 1e-14);
  near(p.totals.realized, 0.0001 * 10000);
});

test('invalid transactions are reported, not thrown', () => {
  const p = buildPortfolio([{ date: 'nope', type: 'buy' }, { date: '2024-01-01', type: 'teleport' }, buy('2024-01-02', 'X', 1, 1)], {}, { today: TODAY });
  assert.equal(p.errors.length, 2);
  assert.equal(p.positions.length, 1);
  assert.equal(normalizeTxn({ date: '2024-01-01', type: 'split', symbol: 'X' }).error, 'Split without a valid ratio');
});

test('holdingsToTxns migrates legacy rows', () => {
  const t = holdingsToTxns([{ id: 'h1', symbol: 'aapl', shares: 10, cost: 1500, costMode: 'total', note: 'old' },
                            { id: 'h2', symbol: 'MSFT', shares: 2, cost: 300, costMode: 'per' }, { symbol: 'ZERO', shares: 0, cost: 1 }]);
  assert.equal(t.length, 2);
  assert.equal(t[0].date, '1970-01-01'); assert.equal(t[0].symbol, 'AAPL'); near(t[0].price, 150);
  assert.equal(t[0].note, 'migrated · old'); assert.equal(t[1].note, 'migrated'); assert.equal(t[1].migrated, true);
  const p = buildPortfolio(t, { AAPL: { price: 160 }, MSFT: { price: 300 } }, { today: TODAY });
  near(p.totals.costBasis, 2100); near(p.totals.unrealized, 100);
  // migrated lots have no holding period
  const s = buildPortfolio([...t, sell('2024-01-02', 'AAPL', 1, 160)], {}, { today: TODAY });
  assert.equal(s.realizedEvents[0].holdingDays, null);
});

test('XIRR: Excel documentation example ≈ 37.34%', () => {
  const r = xirr([{ date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 }, { date: '2008-10-30', amount: 4250 },
                  { date: '2009-02-15', amount: 3250 }, { date: '2009-04-01', amount: 2750 }]);
  near(r, 0.373362535, 1e-6);
  near(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }]), 0.1, 1e-9);   // 365 days
  near(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 500 }]), -0.5, 1e-9);
  assert.equal(xirr([{ date: '2023-01-01', amount: -1000 }]), null);
  assert.equal(xirr([{ date: '2023-01-01', amount: 1000 }, { date: '2023-06-01', amount: 5 }]), null);
});

test('XIRR falls back to bisection for a bad guess', () => {
  const r = xirr([{ date: '2020-01-01', amount: -100 }, { date: '2020-01-31', amount: 300 }], 50);
  // (1+r)^(30/365) = 3 -> r = 3^(365/30) − 1
  near(r, Math.pow(3, 365 / 30) - 1, 1e-3 * Math.pow(3, 365 / 30));
});

test('TWR chain-links around flows', () => {
  const pts = [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 110 }, { date: '2024-01-03', value: 165 }];
  const flows = [{ date: '2024-01-03', amount: 50 }];
  // start: 110/100 × 165/(110+50) − 1 = 1.1 × 1.03125 − 1
  near(twr(pts, flows), 0.134375);
  // end: 1.1 × (165−50)/110 − 1 = 0.15
  near(twr(pts, flows, { timing: 'end' }), 0.15);
  assert.equal(twrSeries(pts, flows).length, 3);
  assert.equal(twr([{ date: '2024-01-01', value: 1 }], []), null);
  // a deposit into an empty portfolio is not a return
  near(twr([{ date: '2024-01-01', value: 0 }, { date: '2024-01-02', value: 105 }], [{ date: '2024-01-02', amount: 100 }]), 0.05);
});

test('annualize refuses to extrapolate under a year unless forced', () => {
  assert.equal(annualize(0.1, 100), null);
  near(annualize(0.21, 730), 0.1);
  near(annualize(0.1, 182.5, { force: true }), 0.21);
});

test('risk metrics on a small series', () => {
  // r = [.01, −.02, .03, 0]: mean .005, sample var .0013/3, ppy 4
  const r = [0.01, -0.02, 0.03, 0];
  const m = riskMetrics(r, null, { periodsPerYear: 4 });
  const sd = Math.sqrt(0.0013 / 3);
  near(m.volatility, sd * 2);
  near(m.meanAnnual, 0.02);
  near(m.sharpe, 0.02 / (sd * 2));
  // downside: only −.02 -> sqrt(.0004/4)×2 = .02
  near(m.sortino, 0.02 / 0.02);
  near(m.maxDrawdown, -0.02);
  near(stdev(r), sd);
  // beta: portfolio = 2 × bench
  const b = [0.01, 0.02, -0.01, 0.03];
  const mb = riskMetrics(b.map((x) => 2 * x), b, { periodsPerYear: 252 });
  near(mb.beta, 2); near(mb.correlation, 1); near(mb.alpha, 0, 1e-12);
  // rf lowers Sharpe
  assert.ok(riskMetrics(r, null, { periodsPerYear: 4, rf: 0.01 }).sharpe < m.sharpe);
  assert.equal(riskMetrics([0.1]).volatility, null);
});

test('max drawdown with peak, trough, recovery and current', () => {
  const d = maxDrawdown([100, 120, 90, 95, 130, 104]);
  near(d.maxDrawdown, -0.25); assert.equal(d.peakIndex, 1); assert.equal(d.troughIndex, 2);
  assert.equal(d.recoveryIndex, 4); near(d.current, -0.2);
  assert.equal(maxDrawdown([1, 2, 3]).maxDrawdown, 0);
  assert.deepEqual(simpleReturns([100, 110, null, 99]).map((x) => x == null ? x : +x.toFixed(4)), [0.1, null, null]);
});

test('allocation buckets with Other/Unknown and cash; drift to targets', () => {
  const positions = [{ symbol: 'AAPL', valueBase: 600, currency: 'USD' }, { symbol: 'BTC', valueBase: 300, currency: 'USD' },
                     { symbol: 'ZZZ', valueBase: 100, currency: 'USD' }, { symbol: 'NOPE', valueBase: null }];
  const prof = { AAPL: { sector: 'Technology' } };
  const rows = allocation(positions, (s) => prof[s], 'sector');
  assert.deepEqual(rows.map((r) => r.key), ['Technology', 'Cryptocurrency', OTHER]);
  near(rows[0].weight, 60); assert.equal(rows.excluded, 1);
  const ac = allocation(positions, (s) => prof[s], 'assetClass', { cash: 1000 });
  assert.deepEqual(ac.map((r) => r.key), ['Cash', 'Equity', 'Crypto']);
  near(ac[0].weight, 50);
  // drift: Equity 35%, Crypto 15%, Cash 50% vs targets 60/10/30
  const d = drift(ac, { Equity: 60, Crypto: 10, Cash: 30, Bonds: 0 });
  const eq = d.find((x) => x.key === 'Equity');
  near(eq.drift, 35 - 60); near(eq.toRebalance, 0.6 * 2000 - 700);
  near(d.find((x) => x.key === 'Cash').toRebalance, -400);
  assert.ok(d.find((x) => x.key === 'Bonds'));
  assert.equal(d.targetSum, 100);
  assert.equal(drift(ac, {})[0].target, null);
});

test('position size: risk-based, capped, short, fees, fractional', () => {
  const a = positionSize({ equity: 10000, riskPct: 1, entry: 50, stop: 48 });
  assert.equal(a.qty, 50); assert.equal(a.direction, 'long'); near(a.actualRisk, 100); near(a.pctOfEquity, 25);
  const c = positionSize({ equity: 10000, riskPct: 1, entry: 50, stop: 48, maxPositionPct: 20 });
  assert.equal(c.qty, 40); assert.equal(c.capped, true);
  const s = positionSize({ equity: 10000, riskPct: 1, entry: 50, stop: 52 });
  assert.equal(s.direction, 'short'); assert.equal(s.qty, 50);
  assert.equal(positionSize({ equity: 10000, riskPct: 1, entry: 50, stop: 48, fee: 5 }).qty, 45);   // (100−10)/2
  near(positionSize({ equity: 1000, riskPct: 2, entry: 30000, stop: 29000, step: 0.001 }).qty, 0.02, 1e-12);
  assert.equal(positionSize({ equity: 1000, riskPct: 1, entry: 50, stop: 50 }), null);
  assert.equal(positionSize({ equity: 100, riskPct: 1, entry: 500, stop: 400 }).qty, 0);
});

test('risk/reward, break-even, recovery gain', () => {
  const r = riskReward({ entry: 100, stop: 95, target: 115, qty: 10 });
  near(r.ratio, 3); near(r.breakevenWinRate, 25); near(r.riskAmount, 50); near(r.rewardAmount, 150); assert.equal(r.valid, true);
  const sh = riskReward({ entry: 100, stop: 110, target: 80 });
  assert.equal(sh.direction, 'short'); near(sh.ratio, 2);
  assert.equal(riskReward({ entry: 100, stop: 95, target: 90 }).valid, false);
  near(breakEven({ qty: 10, avgCost: 100, sellFee: 10 }), 101);
  near(breakEven({ qty: 10, avgCost: 100, sellFeePct: 1 }), 1000 / 9.9);
  near(recoveryGain(50), 100); near(recoveryGain(20), 25); assert.equal(recoveryGain(100), null);
});

test('dividend income: trailing, forward estimate, yield on cost', () => {
  const txns = [buy('2023-01-02', 'AAPL', 100, 50),
                { date: '2024-03-01', type: 'dividend', symbol: 'AAPL', amount: 10, currency: 'USD' },
                { date: '2024-06-01', type: 'dividend', symbol: 'AAPL', amount: 10, currency: 'USD' },
                { date: '2023-06-01', type: 'dividend', symbol: 'AAPL', amount: 99, currency: 'USD' }];   // outside 12m
  const p = buildPortfolio(txns, { AAPL: { price: 40 } }, { today: TODAY });
  const d = dividendIncome(txns, p.positions, null, { today: TODAY });
  near(d.trailing12m, 20);
  near(d.forward12m, 20);            // 0.20/share × 100
  near(d.yieldOnCost, 20 / 5000 * 100);
  near(d.rows[0].currentYield, 0.2 / 40 * 100);
  assert.equal(d.rows[0].source, 'ledger');
  const ev = { AAPL: { dividends: [0, 1, 2, 3].map((i) => ({ exDate: `2024-0${2 + i * 2}-10`, amount: 0.25 })) } };
  const d2 = dividendIncome(txns, p.positions, ev, { today: TODAY });
  near(d2.forward12m, 100); assert.equal(d2.rows[0].source, 'provider');
});

test('portfolio history forward-fills and feeds TWR', () => {
  const day = (d) => Date.parse(d + 'T00:00:00Z');
  const bars = {
    X: [{ t: day('2024-01-02'), c: 10 }, { t: day('2024-01-03'), c: 11 }, { t: day('2024-01-05'), c: 12 }],
    Y: [{ t: day('2024-01-04'), c: 1 }],
  };
  const txns = [{ date: '2024-01-02', type: 'deposit', amount: 1000, currency: 'USD' }, buy('2024-01-02', 'X', 50, 10)];
  const h = portfolioHistory(txns, bars, null, {});
  assert.deepEqual(h.map((r) => r.value), [1000, 1050, 1050, 1100]);
  assert.deepEqual(h.map((r) => r.flow), [1000, 0, 0, 0]);
  near(h[0].cash, 500); near(h[0].cost, 500);
  near(twr(h, h.map((r) => ({ date: r.date, amount: r.flow }))), 0.1);
  // without deposits, the buy itself is the flow
  const h2 = portfolioHistory([buy('2024-01-02', 'X', 50, 10)], bars, null, {});
  assert.deepEqual(h2.map((r) => r.flow), [500, 0, 0, 0]);
  assert.deepEqual(h2.map((r) => r.value), [500, 550, 550, 600]);
});

test('portfolio history un-adjusts split-adjusted bars before a ledger split', () => {
  const day = (d) => Date.parse(d + 'T00:00:00Z');
  // Provider bars are adjusted: the real 400 close before a 4:1 split reads 100.
  const bars = { X: [{ t: day('2024-05-30'), c: 100 }, { t: day('2024-05-31'), c: 101 }, { t: day('2024-06-03'), c: 102 }] };
  const txns = [buy('2024-05-30', 'X', 10, 400), { date: '2024-06-03', type: 'split', symbol: 'X', ratio: 4, currency: 'USD' }];
  const h = portfolioHistory(txns, bars, null, {});
  assert.deepEqual(h.map((r) => r.value), [4000, 4040, 4080]);
  // raw bars are taken as they are
  const raw = portfolioHistory(txns, { X: [{ t: day('2024-05-30'), c: 400 }, { t: day('2024-06-03'), c: 102 }] }, null, { splitAdjusted: false });
  assert.deepEqual(raw.map((r) => r.value), [4000, 4080]);
});

test('investor flows for XIRR: deposits when tracked, trades otherwise', () => {
  const a = investorFlows([{ date: '2023-01-01', type: 'deposit', amount: 1000 }, buy('2023-01-02', 'X', 1, 900)],
                          { terminalValue: 1100, asOf: '2024-01-01' });
  assert.deepEqual(a.flows, [{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }]);
  near(xirr(a.flows), 0.1, 1e-9);
  const b = investorFlows([...holdingsToTxns([{ symbol: 'Z', shares: 1, cost: 5 }]), buy('2023-01-01', 'X', 10, 100, { fee: 1 })], { terminalValue: 1200, asOf: '2024-01-01' });
  assert.deepEqual(b.flows[0], { date: '2023-01-01', amount: -1001 });
  assert.equal(b.warnings.length, 1);
});
