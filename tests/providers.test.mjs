/* tests/providers.test.mjs — data-layer tests. Run: node --test tests/
   Covers the pure parts of js/providers: bar normalization, the demo generator
   (determinism, range lengths, OHLC validity, calendars), aggregation and
   trimming, the per-provider pacer, typed getJSON errors and asset-class
   routing. No network: fetch is stubbed where getJSON is exercised. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (f) => path.join(ROOT, 'js', 'providers', f);

const base = await import(P('base.js'));
const candles = await import(P('candles.js'));
const ac = await import(P('assetclass.js'));
const demo = await import(P('demo.js'));
demo.setDemoData(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo.json'), 'utf8')));

const DAY = 86400000;
// Fixed instants (US Eastern is UTC-4 in October, UTC-5 after Nov 1 2026).
const SAT = Date.parse('2026-10-10T16:00:00Z');        // Saturday — market shut
const THU_1100 = Date.parse('2026-10-08T15:00:00Z');   // Thursday 11:00 New York, session in progress
const BLACK_FRI = Date.parse('2026-11-27T22:00:00Z');  // half day (13:00 close), after the close

function validOHLC(bars) {
  for (const b of bars) {
    assert.ok(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0, 'positive prices');
    assert.ok(b.h >= Math.max(b.o, b.c), `h >= max(o,c) at ${b.t}`);
    assert.ok(b.l <= Math.min(b.o, b.c), `l <= min(o,c) at ${b.t}`);
    assert.ok(b.v === null || b.v >= 0, 'volume null or non-negative');
  }
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].t > bars[i - 1].t, 'strictly ascending t');
}
function nyDow(t) { return new Date(t).getUTCDay(); }

/* ---- normBar ---------------------------------------------------------------- */

test('normBar keeps a valid bar and coerces strings', () => {
  const b = base.normBar({ t: '2026-01-05T14:30:00Z', o: '10', h: '11', l: '9.5', c: '10.5', v: '1000' });
  assert.deepEqual(b, { t: Date.parse('2026-01-05T14:30:00Z'), o: 10, h: 11, l: 9.5, c: 10.5, v: 1000 });
});

test('normBar drops bars that cannot be drawn honestly', () => {
  assert.equal(base.normBar({ t: 1, o: 10, h: 9, l: 8, c: 10 }), null, 'high below open');
  assert.equal(base.normBar({ t: 1, o: 10, h: 12, l: 10.5, c: 11 }), null, 'low above open');
  assert.equal(base.normBar({ t: 1, o: NaN, h: 12, l: 9, c: 11 }), null, 'NaN');
  assert.equal(base.normBar({ t: 'garbage', o: 1, h: 1, l: 1, c: 1 }), null, 'bad time');
  assert.equal(base.normBar({ t: 1, o: 0, h: 1, l: 0, c: 1 }), null, 'zero price');
  assert.equal(base.normBar(null), null);
});

test('normBar volume: missing or negative is null, never 0', () => {
  assert.equal(base.normBar({ t: 1, o: 1, h: 1, l: 1, c: 1 }).v, null);
  assert.equal(base.normBar({ t: 1, o: 1, h: 1, l: 1, c: 1, v: -5 }).v, null);
  assert.equal(base.normBar({ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }).v, 0);
});

test('normBars sorts oldest-first and de-duplicates on t (last wins)', () => {
  const out = base.normBars([
    { t: 3, o: 1, h: 1, l: 1, c: 1 }, { t: 1, o: 1, h: 1, l: 1, c: 1 },
    { t: 3, o: 2, h: 2, l: 2, c: 2 }, { t: 2, o: 5, h: 1, l: 1, c: 1 },
  ]);
  assert.deepEqual(out.map((b) => b.t), [1, 3]);
  assert.equal(out[1].c, 2);
});

/* ---- Demo generator ------------------------------------------------------------ */

test('demo candles are deterministic for the same instant', () => {
  for (const [sym, range] of [['AAPL', '1D'], ['BTC', '1M'], ['EURUSD', '1Y'], ['NOTREAL', '3M']]) {
    const a = demo.demoCandles(sym, { range }, THU_1100);
    const b = demo.demoCandles(sym, { range }, THU_1100);
    assert.ok(a.length > 0, sym + ' has bars');
    assert.deepEqual(a, b, sym + ' ' + range);
  }
});

test('demo: a finished US session is 78 five-minute bars from 09:30 New York', () => {
  const bars = demo.demoCandles('AAPL', { interval: '5m', range: '1D' }, SAT);
  assert.equal(bars.length, 78);
  assert.equal(new Date(bars[0].t).toISOString(), '2026-10-09T13:30:00.000Z');   // Friday 09:30 EDT
  validOHLC(bars);
});

test('demo: range lengths respect sessions and calendars', () => {
  assert.equal(demo.demoCandles('AAPL', { interval: '15m', range: '5D' }, SAT).length, 5 * 26);
  assert.equal(demo.demoCandles('AAPL', { interval: '1h', range: '1M' }, SAT).length % 7, 0, 'hourly bars are session-anchored: 7 per day');
  const y = demo.demoCandles('AAPL', { interval: '1d', range: '1Y' }, SAT);
  assert.ok(y.length >= 248 && y.length <= 254, '~252 trading days, got ' + y.length);
  assert.ok(y.every((b) => nyDow(b.t) !== 0 && nyDow(b.t) !== 6), 'no weekend daily bars for equities');
  const btc = demo.demoCandles('BTC', { interval: '1d', range: '1Y' }, SAT);
  assert.ok(btc.length >= 365 && btc.length <= 367, 'crypto trades every day, got ' + btc.length);
  assert.ok(btc.some((b) => nyDow(b.t) === 0), 'crypto has Sunday bars');
  assert.equal(demo.demoCandles('BTC', { interval: '5m', range: '1D' }, SAT).length, 288, 'crypto 1D is a rolling 24h');
  const w = demo.demoCandles('SPY', { interval: '1w', range: '5Y' }, SAT);
  assert.ok(w.length >= 258 && w.length <= 263, 'weekly over 5Y, got ' + w.length);
});

test('demo: holidays are skipped and half days end at 13:00', () => {
  const d = demo.demoCandles('MSFT', { interval: '1d', range: '1M' }, BLACK_FRI);
  const days = d.map((b) => new Date(b.t).toISOString().slice(0, 10));
  assert.ok(!days.includes('2026-11-26'), 'Thanksgiving skipped');
  assert.ok(days.includes('2026-11-27'), 'day after Thanksgiving trades');
  const half = demo.demoCandles('MSFT', { interval: '5m', range: '1D' }, BLACK_FRI);
  assert.equal(half.length, 42, '09:30-13:00 = 42 five-minute bars');
});

test('demo: OHLC validity across classes, ranges and intervals', () => {
  for (const sym of ['AAPL', 'BTC', 'EURUSD', 'DOGE', 'USDJPY', 'ZZZ']) {
    for (const [range, interval] of [['1D', '1m'], ['5D', '30m'], ['3M', '1d'], ['2Y', '1w'], ['MAX', '1M']]) {
      validOHLC(demo.demoCandles(sym, { interval, range }, THU_1100));
    }
  }
});

test('demo: spot FX has no volume; equities and crypto do', () => {
  assert.ok(demo.demoCandles('EURUSD', { range: '1M', interval: '1d' }, SAT).every((b) => b.v === null));
  assert.ok(demo.demoCandles('AAPL', { range: '1M', interval: '1d' }, SAT).every((b) => b.v > 0));
});

test('demo: a session in progress stops at now, and the quote agrees with the chart', () => {
  assert.equal(demo.demoCandles('AAPL', { interval: '1m', range: '1D' }, THU_1100).length, 90, '09:30 -> 11:00:00 is 90 full minutes');
  const at = THU_1100 + 30000;
  const bars = demo.demoCandles('AAPL', { interval: '1m', range: '1D' }, at);
  assert.equal(bars.length, 91, 'plus the forming minute at 11:00:30');
  assert.ok(bars[bars.length - 1].t <= at);
  const q = demo.__demo.demoQuoteFrom('AAPL', at);
  assert.equal(q.high, Math.max(...bars.map((b) => b.h)));
  assert.equal(q.low, Math.min(...bars.map((b) => b.l)));
  assert.equal(q.price, bars[bars.length - 1].c);
  assert.equal(q.prevClose, 222.45, 'previous close is the bundled anchor');
  const d = demo.demoCandles('AAPL', { interval: '1d', range: '5D' }, at);
  assert.equal(d[d.length - 1].h, q.high, 'daily bar high = intraday high');
});

test('demo: the session before the latest closes at the anchor', () => {
  const d = demo.demoCandles('JPM', { interval: '1d', range: '1M' }, SAT);
  assert.equal(d[d.length - 2].c, 203.08);
});

test('demo: fundamentals, events and news are sample-but-coherent', () => {
  const f = demo.__demo.demoFundamentals('AAPL', SAT);
  assert.equal(f.source, 'demo');
  const y = demo.demoCandles('AAPL', { interval: '1d', range: '1Y' }, SAT);
  assert.equal(f.high52, Math.max(...y.map((b) => b.h)));
  assert.ok(f.pe > 0 && f.marketCap > 0);
  assert.equal(demo.__demo.demoFundamentals('EURUSD', SAT), null, 'FX has no fundamentals');
  const ev = demo.__demo.demoEvents('NVDA', SAT);
  assert.ok(ev.splits.some((s) => s.date === '2024-06-10' && s.ratio === 10));
  assert.ok(ev.earnings.length >= 4 && ev.dividends.length >= 4);
  const news = demo.__demo.demoNews('AAPL', 5, SAT);
  assert.ok(news.length > 0 && news.every((n) => n.headline.startsWith('[Sample]')));
});

/* ---- Aggregation / trimming --------------------------------------------------- */

test('aggregate: 1m -> 1h is session-anchored and sums volume', () => {
  const m = demo.demoCandles('AAPL', { interval: '1m', range: '1D' }, SAT);
  const h = candles.aggregate(m, '1h', 'equity');
  assert.equal(h.length, 7);
  assert.equal(new Date(h[0].t).toISOString(), '2026-10-09T13:30:00.000Z');
  assert.equal(h.reduce((a, b) => a + b.v, 0), m.reduce((a, b) => a + b.v, 0));
  assert.equal(h[0].o, m[0].o);
  assert.equal(h[6].c, m[m.length - 1].c);
  validOHLC(h);
});

test('trimToRange 1D keeps only the last session date', () => {
  const m = demo.demoCandles('AAPL', { interval: '15m', range: '5D' }, SAT);
  const t = candles.trimToRange(m, '1D', 'equity', '15m', SAT);
  assert.equal(t.length, 26);
});

test('barsFromSamples opens each bar at the previous close', () => {
  const s = [[0, 10], [60000, 11], [300000, 12], [360000, 9]];
  const b = candles.barsFromSamples(s, '5m');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { t: 0, o: 10, h: 11, l: 10, c: 11, v: null });
  assert.deepEqual(b[1], { t: 300000, o: 11, h: 12, l: 9, c: 9, v: null });
});

test('RANGES: every default interval is allowed by its own range', () => {
  for (const r of candles.RANGES) assert.ok(r.intervals.includes(r.interval), r.id);
});

test('createLRU evicts the least recently used entry', () => {
  const c = candles.createLRU(null, { max: 2 });
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.peek('b'), null);
  assert.equal(c.peek('a'), 1);
  assert.equal(c.size(), 2);
});

/* ---- Pacer ---------------------------------------------------------------------- */

function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; },
    async advance(ms) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > t) break;
        timers.shift().fn();
        await new Promise((r) => setImmediate(r));
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('pacer: holds the 6th call on a 5/min provider until the minute rolls', async () => {
  const clk = fakeClock();
  const p = base.createPacer({ limits: { x: { perMin: 5 } }, now: clk.now, setTimer: clk.setTimer });
  const done = [];
  for (let i = 0; i < 6; i++) p.acquire('x', { maxWait: 120000 }).then(() => done.push(i));
  await clk.advance(0);
  assert.deepEqual(done, [0, 1, 2, 3, 4]);
  await clk.advance(30000);
  assert.equal(done.length, 5, 'still waiting at +30s');
  await clk.advance(31000);
  assert.deepEqual(done, [0, 1, 2, 3, 4, 5]);
});

test('pacer: higher priority leaves the queue first', async () => {
  const clk = fakeClock();
  const p = base.createPacer({ limits: { x: { perMin: 1 } }, now: clk.now, setTimer: clk.setTimer });
  const order = [];
  await p.acquire('x');
  p.acquire('x', { priority: 0, maxWait: 1e6 }).then(() => order.push('spark'));
  p.acquire('x', { priority: 2, maxWait: 1e6 }).then(() => order.push('chart'));
  await clk.advance(61000);
  await clk.advance(61000);
  assert.deepEqual(order, ['chart', 'spark']);
});

test('pacer: rejects past maxWait and when the daily cap is spent', async () => {
  const clk = fakeClock();
  const p = base.createPacer({ limits: { x: { perMin: 1, perDay: 2 } }, now: clk.now, setTimer: clk.setTimer });
  await p.acquire('x');
  await assert.rejects(p.acquire('x', { maxWait: 5000 }), (e) => e.rateLimited && e.queued);
  await clk.advance(61000);
  await p.acquire('x');
  await assert.rejects(p.acquire('x'), (e) => e.rateLimited && e.daily);
  assert.equal(p.usage('x').usedDay, 2);
  assert.equal(p.forecast('x', 1), Infinity);
});

test('pacer: a multi-credit call is charged its cost', async () => {
  const clk = fakeClock();
  const p = base.createPacer({ limits: { x: { perMin: 8 } }, now: clk.now, setTimer: clk.setTimer });
  await p.acquire('x', { cost: 6 });
  assert.equal(p.usage('x').usedMin, 6);
  let ok = false;
  p.acquire('x', { cost: 3, maxWait: 1e6 }).then(() => { ok = true; });
  await clk.advance(1000);
  assert.equal(ok, false, '6 + 3 > 8 must wait');
  await clk.advance(60000);
  assert.equal(ok, true);
});

test('pacer: unknown or unlimited providers pass straight through', async () => {
  const p = base.createPacer({ limits: {} });
  await p.acquire('anything');
});

/* ---- getJSON typed errors ------------------------------------------------------ */

test('getJSON maps HTTP failures to typed errors and shares in-flight requests', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const status = Number(new URL(url).searchParams.get('s'));
    if (status === 0) throw new TypeError('Failed to fetch');
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };
  try {
    await assert.rejects(base.getJSON('https://t.test/?s=401', { provider: 'demo' }), (e) => e.authError && e.kind === 'authError');
    await assert.rejects(base.getJSON('https://t.test/?s=429', { provider: 'demo' }), (e) => e.rateLimited);
    await assert.rejects(base.getJSON('https://t.test/?s=403', { provider: 'demo' }), (e) => e.premium);
    await assert.rejects(base.getJSON('https://t.test/?s=0', { provider: 'demo' }), (e) => e.network);
    calls = 0;
    const [a, b] = await Promise.all([base.getJSON('https://t.test/?s=200', { provider: 'demo' }), base.getJSON('https://t.test/?s=200', { provider: 'demo' })]);
    assert.deepEqual(a, { ok: true });
    assert.equal(a, b);
    assert.equal(calls, 1, 'one fetch for two concurrent identical requests');
  } finally { globalThis.fetch = realFetch; }
});

/* ---- Asset classes ---------------------------------------------------------------- */

test('assetclass: coins, collisions, explicit pairs and FX', () => {
  const c = ac.classify;
  assert.equal(c('BTC'), 'crypto');
  assert.equal(c('SOL'), 'crypto');
  assert.equal(c('BTCUSD'), 'crypto');
  assert.equal(c('ETHUSDT'), 'crypto');
  assert.equal(c('LINK'), 'equity', 'Interlink Electronics, not Chainlink');
  assert.equal(c('DASH'), 'equity', 'DoorDash');
  assert.equal(c('LINK-USD'), 'crypto');
  assert.equal(c('LINKUSD'), 'crypto');
  assert.equal(c('PENGU-USD'), 'crypto', 'any dashed fiat pair is the explicit crypto form');
  assert.equal(c('EURUSD'), 'fx');
  assert.equal(c('EUR-USD'), 'fx');
  assert.equal(c('USDMXN'), 'fx');
  assert.equal(c('AAPL'), 'equity');
  assert.equal(c('BRK.B'), 'equity');
  assert.equal(c('BRK-B'), 'equity');
  assert.equal(ac.cryptoQuote('BTCEUR'), 'EUR');
  assert.equal(ac.cryptoQuote('ETH-USDT'), 'USD');
  assert.equal(ac.cryptoBase('LINK-USD'), 'LINK');
  assert.deepEqual(ac.fxPair('EUR-USD'), ['EUR', 'USD']);
  assert.ok(ac.isAmbiguousBare('LINK'));
});

test('assetclass: per-symbol overrides win', () => {
  ac.setClassOverrides({ LINK: 'crypto', SOL: 'equity' });
  try {
    assert.equal(ac.classify('LINK'), 'crypto');
    assert.equal(ac.classify('SOL'), 'equity');
  } finally { ac.setClassOverrides({}); }
  assert.equal(ac.classify('LINK'), 'equity');
});
