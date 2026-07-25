/* providers/demo.js — keyless DEMO adapter. Serves bundled sample data from
   data/demo.json and applies a tiny random walk on every quote so prices tick
   and sparklines breathe with no API key. Purely illustrative — clearly badged
   DEMO in the UI. */

import { register, normQuote } from './base.js';

let DATA = null;
let loading = null;

async function load() {
  if (DATA) return DATA;
  if (!loading) loading = fetch('data/demo.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => (DATA = d));
  return loading;
}

// Per-symbol live-ish state so successive quotes drift instead of jumping.
const live = {};
function tick(sym, base) {
  const st = live[sym] || (live[sym] = { price: base.price, series: base.series.slice() });
  const vol = st.price * 0.0015;
  st.price = Math.max(0.5, +(st.price + (Math.random() - 0.5) * vol).toFixed(2));
  st.series = st.series.slice(1).concat(st.price);
  return st;
}

register({
  id: 'demo',
  label: 'Demo',
  needsKey: false,
  classes: ['equity', 'fx', 'crypto'],
  batch: true,

  async quote(symbols) {
    const d = await load();
    const out = {};
    for (const sym of symbols) {
      const t = d.tickers[sym];
      if (!t) continue;
      const st = tick(sym, { price: t.quote.price, series: t.series });
      out[sym] = normQuote(sym, { ...t.quote, price: st.price }, 'demo');
    }
    return out;
  },

  async series(sym) {
    const d = await load();
    const t = d.tickers[sym];
    if (!t) return [];
    return (live[sym]?.series || t.series).slice();
  },

  async profile(sym) {
    const d = await load();
    return d.tickers[sym]?.profile || null;
  },

  async search(q) {
    const d = await load();
    q = q.toUpperCase();
    return Object.values(d.tickers)
      .filter((t) => t.profile.symbol.includes(q) || t.profile.name.toUpperCase().includes(q))
      .slice(0, 12)
      .map((t) => ({ symbol: t.profile.symbol, description: t.profile.name }));
  },

  async marketStatus() { return { isOpen: true, session: 'demo' }; },
});
