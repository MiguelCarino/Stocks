/* providers/coingecko.js — keyless crypto adapter (CoinGecko public API, CORS-
   enabled, no key). The auto-router sends every crypto ticker here. Symbols
   arrive as a bare base (BTC), a compacted pair (BTCUSD, BTCEUR) or a dashed
   one (LINK-USD); each is priced in its OWN quote currency — BTCEUR used to be
   served the dollar price under a 'USD' label.

   Crypto has no close, so price_change_percentage_24h is a rolling window that
   slides continuously: the same coin at the same price shows a different
   percentage an hour later purely because the far end of the window moved.
   Every quote from here declares baseline 'rolling_24h' precisely so the UI
   labels it "vs 24h" and never "Today" — and so session.js can recognise a
   continuously traded instrument from the quote itself.

   COIN IDS. A ticker is not an identity on CoinGecko: dozens of tokens call
   themselves BTC. /coins/markets?symbols= ranks matches by market cap, so the
   coin a ticker resolves to is the LARGEST one with that ticker — never the top
   hit of /search, which ranks by text relevance. The big coins are pinned in a
   static table so they cost no lookup at all. */

import { register, normQuote, getJSON, num } from './base.js';
import { cryptoBase, cryptoQuote } from './assetclass.js';
import { barsFromSamples, rangeStart } from './candles.js';

const BASE = 'https://api.coingecko.com/api/v3';
const ID = 'coingecko';
const DAY = 86400000;

const KNOWN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', USDC: 'usd-coin', BNB: 'binancecoin', XRP: 'ripple', SOL: 'solana',
  ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron', TON: 'the-open-network', DOT: 'polkadot', MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token', LTC: 'litecoin', SHIB: 'shiba-inu', DAI: 'dai', AVAX: 'avalanche-2', LINK: 'chainlink',
  BCH: 'bitcoin-cash', XLM: 'stellar', UNI: 'uniswap', ATOM: 'cosmos', XMR: 'monero', ETC: 'ethereum-classic',
  FIL: 'filecoin', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism', NEAR: 'near', ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph', ALGO: 'algorand', AAVE: 'aave', PEPE: 'pepe', SUI: 'sui', DASH: 'dash', KAS: 'kaspa',
};
const idBySymbol = new Map(Object.entries(KNOWN_IDS));   // learned additions from /coins/markets
const rowById = new Map();                                // last /coins/markets row per coin, for profile()

async function resolveId(sym, priority = 1, maxWait) {
  const base = cryptoBase(sym).toUpperCase();
  if (idBySymbol.has(base)) return idBySymbol.get(base);
  const rows = await getJSON(`${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&symbols=${encodeURIComponent(base.toLowerCase())}`, { provider: ID, priority, maxWait });
  const r = Array.isArray(rows) && rows[0];
  if (!r) return null;
  idBySymbol.set(base, r.id); rowById.set(r.id, r);
  return r.id;
}

// Range -> market_chart days. The public API serves at most 365 days of history.
function daysFor(range, now = Date.now()) {
  if (range === '1D') return 1;
  if (range === '5D') return 5;
  if (range === 'YTD') return Math.max(1, Math.ceil((now - rangeStart('YTD', now)) / DAY));
  return Math.min(365, Math.ceil((now - rangeStart(range, now)) / DAY));
}

register({
  id: ID,
  label: 'CoinGecko',
  needsKey: false,
  classes: ['crypto'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    if (!symbols.length) return {};
    // One /coins/markets call per quote currency (usually just USD).
    const byCcy = new Map();
    for (const s of symbols) {
      const ccy = cryptoQuote(s);
      if (!byCcy.has(ccy)) byCcy.set(ccy, []);
      byCcy.get(ccy).push(s);
    }
    const out = {};
    for (const [ccy, syms] of byCcy) {
      // base ticker -> app symbols (BTC and BTCUSD can both be on a watchlist).
      const backMap = new Map();
      for (const s of syms) { const b = cryptoBase(s).toLowerCase(); if (!backMap.has(b)) backMap.set(b, []); backMap.get(b).push(s); }
      const rows = await getJSON(`${BASE}/coins/markets?vs_currency=${ccy.toLowerCase()}&order=market_cap_desc&per_page=250&symbols=${encodeURIComponent([...backMap.keys()].join(','))}`, { provider: ID });
      if (!Array.isArray(rows)) continue;
      const seen = new Set();
      for (const r of rows) {
        const b = (r.symbol || '').toLowerCase();
        const appSyms = backMap.get(b);
        if (!appSyms || seen.has(b)) continue;   // highest-cap match wins on symbol collisions
        seen.add(b);
        if (!KNOWN_IDS[b.toUpperCase()]) idBySymbol.set(b.toUpperCase(), r.id);
        rowById.set(r.id, r);
        for (const sym of appSyms) out[sym] = normQuote(sym, {
          price: r.current_price,
          prevClose: (r.current_price != null && r.price_change_24h != null) ? r.current_price - r.price_change_24h : null,
          change: r.price_change_24h, changePct: r.price_change_percentage_24h,
          high: r.high_24h, low: r.low_24h, open: null, volume: r.total_volume,
          // vs_currency is in the request: the denomination is asked for, not assumed.
          currency: ccy,
          baseline: 'rolling_24h',
          baselineNote: 'Rolling 24 hours — no session close exists',
          // CoinGecko aggregates exchanges that never close; there is no session
          // to name, and 'open' here would invite the equities reading.
          session: null,
        }, ID);
      }
    }
    return out;
  },

  // market_chart sampling is automatic: 5-minute points for 1 day, hourly for
  // 2-90 days, daily beyond. Intervals finer than the sampling are not offered.
  candleIntervals: (cls, range) => {
    if (range === '1D') return ['5m', '15m', '30m', '1h'];
    if (['5D', '1M', '3M'].includes(range)) return ['1h', '1d', '1w'];
    return ['1d', '1w', '1M'];
  },
  meta: { adjusted: 'n/a', delayed: 'About 1-2 minutes', historyDays: 365 },

  // OHLC built from price samples (see barsFromSamples): exact closes, highs and
  // lows understated where a bucket holds few samples — flagged partial. Daily
  // bars carry the 24h volume CoinGecko reports at the end of that day;
  // intraday bars have no per-bar volume and carry null.
  async candles(sym, { interval = '1d', range = '1Y', priority, maxWait } = {}) {
    const id = await resolveId(sym, priority, maxWait);
    if (!id) return [];
    const days = daysFor(range);
    const r = await getJSON(`${BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${cryptoQuote(sym).toLowerCase()}&days=${days}`, { provider: ID, priority, maxWait });
    if (!r || !Array.isArray(r.prices)) return [];
    const bars = barsFromSamples(r.prices.map((p) => [num(p[0]), num(p[1])]), interval, 'crypto');
    if (interval === '1d' && Array.isArray(r.total_volumes)) {
      const vByDay = new Map();
      for (const [t, v] of r.total_volumes) if (Number.isFinite(t) && Number.isFinite(v)) vByDay.set(Math.floor(t / DAY) * DAY, v);
      for (const b of bars) b.v = vByDay.has(b.t) ? vByDay.get(b.t) : null;
    }
    const sampleMs = days <= 1 ? 5 * 60000 : days <= 90 ? 3600000 : DAY;
    const bucketMs = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '1d': DAY, '1w': 7 * DAY, '1M': 30 * DAY }[interval] || DAY;
    const truncated = ['2Y', '5Y', 'MAX'].includes(range);
    const coarse = bucketMs / sampleMs < 4;
    if (!truncated && !coarse) return bars;
    return {
      bars, partial: true,
      note: [truncated ? 'CoinGecko free history is limited to 365 days' : null, coarse ? 'Highs and lows are approximated from sampled prices' : null].filter(Boolean).join('. '),
    };
  },

  async fundamentals(sym) {
    const id = await resolveId(sym, 0);
    if (!id) return null;
    const c = await getJSON(`${BASE}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`, { provider: ID, priority: 0 });
    const m = c && c.market_data;
    if (!m) return null;
    const ccy = cryptoQuote(sym).toLowerCase();
    const at = (o) => (o && typeof o === 'object' ? num(o[ccy]) : null);
    return {
      symbol: sym, source: ID, asOf: new Date().toISOString(),
      marketCap: at(m.market_cap), pe: null, forwardPe: null, peg: null, eps: null, ps: null, pb: null,
      dividendYield: null, dividendPerShare: null, payoutRatio: null, beta: null,
      // CoinGecko has no 52-week figures; the facade fills them from cached daily bars when it can.
      high52: null, low52: null, high52Date: null, low52Date: null,
      avgVolume10d: null, avgVolume3m: null,
      sharesOutstanding: null,
      revenueGrowth: null, profitMargin: null, roe: null, debtToEquity: null,
      currency: cryptoQuote(sym),
      // Crypto-only extras (outside the shared contract, all optional).
      circulatingSupply: num(m.circulating_supply), totalSupply: num(m.total_supply), maxSupply: num(m.max_supply),
      ath: at(m.ath), athDate: m.ath_date && m.ath_date[ccy] ? String(m.ath_date[ccy]).slice(0, 10) : null,
      atl: at(m.atl), atlDate: m.atl_date && m.atl_date[ccy] ? String(m.atl_date[ccy]).slice(0, 10) : null,
      fullyDilutedValuation: at(m.fully_diluted_valuation),
      volume24h: at(m.total_volume),
    };
  },

  async profile(sym) {
    const id = await resolveId(sym, 0);
    if (!id) return null;
    let r = rowById.get(id);
    if (!r) {
      const rows = await getJSON(`${BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}`, { provider: ID, priority: 0 }).catch(() => null);
      r = Array.isArray(rows) ? rows[0] : null;
      if (r) rowById.set(id, r);
    }
    if (!r) return null;
    return { symbol: sym, name: r.name, exchange: 'Crypto', sector: 'Cryptocurrency', currency: cryptoQuote(sym),
             marketCap: cryptoQuote(sym) === 'USD' ? (num(r.market_cap) || 0) : 0, logo: r.image || '' , coinId: id };
  },

  async search(q) {
    const s = await getJSON(`${BASE}/search?query=${encodeURIComponent(q)}`, { provider: ID, priority: 2, maxWait: 4000 }).catch(() => null);
    if (!s || !Array.isArray(s.coins)) return [];
    return s.coins.slice(0, 12).map((c) => ({ symbol: c.symbol.toUpperCase(), description: `${c.name} · Crypto`, coinId: c.id }));
  },

  // The facade asks marketStatus about the US equity session. CoinGecko has no
  // opinion on that, and the old { isOpen: true } was read as one — it is the
  // reason a crypto-only watchlist showed the market OPEN on a Sunday. Silence
  // is the honest answer; the local calendar decides.
  async marketStatus() { return null; },

  async validate() { const r = await getJSON(`${BASE}/ping`, { provider: ID, priority: 2 }).catch(() => null); return !!(r && r.gecko_says); },
});
