/* providers/coingecko.js — keyless crypto adapter (CoinGecko public API, CORS-
   enabled, no key). The auto-router sends every crypto ticker here. Symbols
   arrive as a bare base (BTC) or a compacted pair (BTCUSD); both map to the
   coin's USD market. One batched /coins/markets call covers the whole group.

   Crypto has no close, so price_change_percentage_24h is a rolling window that
   slides continuously: the same coin at the same price shows a different
   percentage an hour later purely because the far end of the window moved.
   Every quote from here declares baseline 'rolling_24h' precisely so the UI
   labels it "vs 24h" and never "Today" — and so session.js can recognise a
   continuously traded instrument from the quote itself. */

import { register, normQuote, getJSON, num } from './base.js';
import { cryptoBase } from './assetclass.js';

const BASE = 'https://api.coingecko.com/api/v3';
const ID = 'coingecko';
const idBySymbol = new Map();   // BTC -> bitcoin, learned from /coins/markets so series() can resolve the coin id.

register({
  id: ID,
  label: 'CoinGecko',
  needsKey: false,
  classes: ['crypto'],
  batch: true,
  hasSeries: true,

  async quote(symbols) {
    if (!symbols.length) return {};
    // base ticker -> original app symbol, so results key back to the watchlist entry.
    const backMap = new Map();
    for (const s of symbols) backMap.set(cryptoBase(s).toLowerCase(), s);
    const bases = [...backMap.keys()].join(',');
    const rows = await getJSON(`${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&symbols=${encodeURIComponent(bases)}`, { provider: ID });
    const out = {};
    if (!Array.isArray(rows)) return out;
    for (const r of rows) {
      const sym = backMap.get((r.symbol || '').toLowerCase());
      if (!sym || out[sym]) continue;   // highest-cap match wins on symbol collisions
      idBySymbol.set(cryptoBase(sym).toUpperCase(), r.id);
      out[sym] = normQuote(sym, {
        price: r.current_price,
        prevClose: (r.current_price != null && r.price_change_24h != null) ? r.current_price - r.price_change_24h : null,
        change: r.price_change_24h, changePct: r.price_change_percentage_24h,
        high: r.high_24h, low: r.low_24h, open: null, volume: r.total_volume,
        // vs_currency=usd is in the request: the denomination is asked for, not
        // assumed.
        currency: 'USD',
        baseline: 'rolling_24h',
        baselineNote: 'Rolling 24 hours — no session close exists',
        // CoinGecko aggregates exchanges that never close; there is no session
        // to name, and 'open' here would invite the equities reading.
        session: null,
      }, ID);
    }
    return out;
  },

  async series(sym, range = '1D') {
    const days = range === '1Y' ? 365 : range === '1M' ? 30 : 1;
    let id = idBySymbol.get(cryptoBase(sym).toUpperCase());
    if (!id) {
      const s = await getJSON(`${BASE}/search?query=${encodeURIComponent(cryptoBase(sym))}`, { provider: ID }).catch(() => null);
      id = s && s.coins && s.coins[0] ? s.coins[0].id : null;
      if (id) idBySymbol.set(cryptoBase(sym).toUpperCase(), id);
    }
    if (!id) return [];
    const r = await getJSON(`${BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`, { provider: ID });
    if (!r || !Array.isArray(r.prices)) return [];
    let pts = r.prices.map((p) => num(p[1])).filter((n) => n != null);
    if (pts.length > 90) { const step = Math.ceil(pts.length / 80); pts = pts.filter((_, i) => i % step === 0); }
    return pts;
  },

  async profile(sym) {
    const s = await getJSON(`${BASE}/search?query=${encodeURIComponent(cryptoBase(sym))}`, { provider: ID }).catch(() => null);
    const c = s && s.coins && s.coins[0];
    if (!c) return null;
    return { symbol: sym, name: c.name, exchange: 'Crypto', sector: 'Cryptocurrency', currency: 'USD', marketCap: 0, logo: c.large || c.thumb || '' };
  },

  async search(q) {
    const s = await getJSON(`${BASE}/search?query=${encodeURIComponent(q)}`, { provider: ID }).catch(() => null);
    if (!s || !Array.isArray(s.coins)) return [];
    return s.coins.slice(0, 12).map((c) => ({ symbol: c.symbol.toUpperCase(), description: `${c.name} · Crypto` }));
  },

  // The facade asks marketStatus about the US equity session. CoinGecko has no
  // opinion on that, and the old { isOpen: true } was read as one — it is the
  // reason a crypto-only watchlist showed the market OPEN on a Sunday. Silence
  // is the honest answer; the local calendar decides.
  async marketStatus() { return null; },

  async validate() { const r = await getJSON(`${BASE}/ping`, { provider: ID }).catch(() => null); return !!(r && r.gecko_says); },
});
