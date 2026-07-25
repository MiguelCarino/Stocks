/* providers/finnhub.js — Finnhub adapter (free tier, CORS-enabled).
   Powers real-time-ish US quotes, company profiles, symbol search and market
   status. Series/candles are premium on Finnhub, so sparklines and the detail
   chart route through Twelve Data instead (see twelvedata.js). */

import { register, normQuote, getJSON, num } from './base.js';

const BASE = 'https://finnhub.io/api/v1';
let KEY = '';
export function setFinnhubKey(k) { KEY = (k || '').trim(); }

register({
  id: 'finnhub',
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
        const q = await getJSON(`${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`);
        if (q && q.c != null && q.c !== 0) {
          out[sym] = normQuote(sym, { c: q.c, pc: q.pc, o: q.o, h: q.h, l: q.l, change: q.d, changePct: q.dp, ts: (q.t ? q.t * 1000 : Date.now()) }, 'finnhub');
        }
      } catch (e) { if (e.rateLimited) throw e; }
    }));
    return out;
  },

  async profile(sym) {
    const p = await getJSON(`${BASE}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${KEY}`);
    if (!p || !p.name) return null;
    return { symbol: sym, name: p.name, exchange: p.exchange || '', sector: p.finnhubIndustry || '',
             currency: p.currency || 'USD', marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : 0,
             logo: p.logo || '' };
  },

  async search(q) {
    const r = await getJSON(`${BASE}/search?q=${encodeURIComponent(q)}&token=${KEY}`);
    return (r.result || [])
      .filter((x) => x.symbol && !x.symbol.includes('.') || (x.type === 'Common Stock'))
      .slice(0, 12)
      .map((x) => ({ symbol: x.symbol, description: x.description }));
  },

  async marketStatus() {
    try {
      const r = await getJSON(`${BASE}/stock/market-status?exchange=US&token=${KEY}`);
      return { isOpen: !!r.isOpen, session: r.session || (r.isOpen ? 'open' : 'closed') };
    } catch (e) { return null; }
  },

  // Validate a key with a single cheap call.
  async validate() {
    const q = await getJSON(`${BASE}/quote?symbol=AAPL&token=${KEY}`);
    return num(q.c) != null;
  },
});
