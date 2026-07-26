/* providers/finnhub.js — Finnhub adapter (free tier, CORS-enabled).
   Powers real-time-ish US quotes, company profiles, symbol search and market
   status. Series/candles are premium on Finnhub, so sparklines and the detail
   chart route through Twelve Data instead (see twelvedata.js).

   Finnhub has no batch quote endpoint: one refresh of an N-symbol watchlist is
   N HTTP requests. That is the reason the call budget is instrumented down in
   getJSON rather than at the facade — this adapter is the one that would make a
   facade-level count meaningless. */

import { register, normQuote, getJSON, num } from './base.js';

const BASE = 'https://finnhub.io/api/v1';
const ID = 'finnhub';
let KEY = '';
export function setFinnhubKey(k) { KEY = (k || '').trim(); }

// /quote reports no currency, but Finnhub lists foreign tickers too (SHOP.TO is
// CAD), so USD cannot be assumed. profile2 does report it; whatever it taught us
// is reused on later quotes and the field stays null until then.
const currencyBySymbol = new Map();

// /stock/market-status session strings -> the app's four-value vocabulary.
const SESSION_MAP = {
  'pre-market': 'pre',
  premarket: 'pre',
  regular: 'open',
  'post-market': 'post',
  postmarket: 'post',
  closed: 'closed',
};

register({
  id: ID,
  label: 'Finnhub',
  needsKey: true,
  classes: ['equity'],
  batch: false,
  hasSeries: false,

  async quote(symbols) {
    // Finnhub /quote is one symbol per call; the scheduler paces these.
    const out = {};
    await Promise.all(symbols.map(async (sym) => {
      try {
        const q = await getJSON(`${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`, { provider: ID });
        if (q && q.c != null && q.c !== 0) {
          out[sym] = normQuote(sym, {
            c: q.c, pc: q.pc, o: q.o, h: q.h, l: q.l, change: q.d, changePct: q.dp,
            ts: (q.t ? q.t * 1000 : Date.now()),
            currency: currencyBySymbol.get(sym) || null,
            // pc is the official consolidated regular-session close — the one
            // baseline in this codebase that needs no caveat.
            baseline: 'prev_close',
            baselineNote: 'Official previous regular-session close',
            // /quote carries no session flag. market-status does, but it is a
            // separate request and asserting one symbol's session from a
            // market-wide poll taken at another moment is a guess.
            session: null,
          }, ID);
        }
      } catch (e) { if (e.rateLimited) throw e; }
    }));
    return out;
  },

  async profile(sym) {
    const p = await getJSON(`${BASE}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${KEY}`, { provider: ID });
    if (!p || !p.name) return null;
    const currency = (p.currency || '').toUpperCase() || null;
    if (currency) currencyBySymbol.set(sym, currency);
    return { symbol: sym, name: p.name, exchange: p.exchange || '', sector: p.finnhubIndustry || '',
             currency: currency || 'USD', marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : 0,
             logo: p.logo || '' };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/search?q=${encodeURIComponent(q)}&token=${KEY}`, { provider: ID });
    return (r.result || [])
      .filter((x) => x.symbol && !x.symbol.includes('.') || (x.type === 'Common Stock'))
      .slice(0, 12)
      .map((x) => ({ symbol: x.symbol, description: x.description }));
  },

  async marketStatus() {
    try {
      const r = await getJSON(`${BASE}/stock/market-status?exchange=US&token=${KEY}`, { provider: ID });
      const raw = String(r.session || '').toLowerCase();
      return {
        isOpen: !!r.isOpen,
        session: SESSION_MAP[raw] || (r.isOpen ? 'open' : 'closed'),
        // A holiday name here is the cheapest available check on the local
        // holiday table drifting out of date; the facade surfaces it.
        holiday: r.holiday || null,
      };
    } catch (e) { return null; }
  },

  // Validate a key with a single cheap call.
  async validate() {
    const q = await getJSON(`${BASE}/quote?symbol=AAPL&token=${KEY}`, { provider: ID });
    return num(q.c) != null;
  },
});
