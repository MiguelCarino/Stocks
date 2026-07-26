/* providers/demo.js — keyless DEMO adapter. Serves bundled sample data from
   data/demo.json and applies a tiny random walk on every quote so prices tick
   and sparklines breathe with no API key. Purely illustrative — clearly badged
   DEMO in the UI.

   The bundled file is same-origin and costs no quota, so it is fetched directly
   rather than through getJSON: counting it would put a number in the call
   budget that no free tier is charging for. */

import { register, normQuote } from './base.js';
import { classify } from './assetclass.js';

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
  // Both the floor and the rounding have to scale with the price. A fixed $0.50
  // floor with two decimals pinned every sub-dollar coin to exactly $0.50 and
  // rounded an FX pair's entire daily range away.
  const dp = st.price >= 100 ? 2 : (st.price >= 1 ? 4 : 6);
  const floor = base.price * 0.2;
  st.price = Math.max(floor, +(st.price + (Math.random() - 0.5) * vol).toFixed(dp));
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
      // Crypto has no close to measure against, so claiming 'prev_close' over it
      // would have the demo assert the one thing the real crypto adapters go out
      // of their way not to.
      const crypto = classify(sym) === 'crypto';
      out[sym] = normQuote(sym, {
        ...t.quote, price: st.price,
        baseline: crypto ? 'rolling_24h' : 'prev_close',
        baselineNote: 'Sample data — not a real ' + (crypto ? '24h window' : 'close'),
        // The random walk runs whenever the page is open, including at 3am on a
        // Sunday. It is not evidence that anything is trading.
        session: null,
      }, 'demo');
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

  // Sample data has no clock. The old { isOpen: true } was what made the market
  // strip announce OPEN at 3am on a Sunday — a fabricated fact dressed as a
  // provider report. The local calendar answers this now.
  async marketStatus() { return null; },
});
