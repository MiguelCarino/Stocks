/* scan.js — screener metrics, filters and presets. Pure: no DOM, no fetching.

   Every number here is derived from one symbol's DAILY bars (about a year of
   them) plus, when the host has one, its live quote. Bars are what the free
   tiers serve cheaply and cache well, so a scan of thirty symbols is thirty
   cached requests rather than thirty times every indicator endpoint. The live
   quote only overrides what it can know better — today's price, change and gap.

   The screener is a sorting and filtering tool over facts about past prices.
   Presets are worded as descriptions of a chart condition ("RSI below 30"), not
   as opportunities, and the UI labels them educational. */

import { sma, rsiOf, atr as atrOf } from './indicators.js';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (a, b) => (fin(a) && fin(b) && b !== 0 ? (a / b - 1) * 100 : null);

/* The columns a scan produces. `unit` drives formatting; `learn` is the glossary
   id a help icon opens. Labels are English i18n keys. */
export const SCAN_FIELDS = [
  { id: 'price', label: 'Last', unit: 'price', desc: 'Latest price (live quote when available, otherwise the last daily close).', learn: 'last-price' },
  { id: 'chg1d', label: '1D %', unit: 'pct', desc: 'Change over the last trading day.', learn: 'pct-change' },
  { id: 'chg5d', label: '5D %', unit: 'pct', desc: 'Change over the last five trading days.', learn: 'pct-change' },
  { id: 'chg1m', label: '1M %', unit: 'pct', desc: 'Change over about one month (21 trading days).', learn: 'pct-change' },
  { id: 'chgYtd', label: 'YTD %', unit: 'pct', desc: 'Change since the last close of the previous calendar year.', learn: 'pct-change' },
  { id: 'rsi14', label: 'RSI 14', unit: 'num', desc: 'Relative Strength Index over 14 daily bars (0–100).', learn: 'rsi' },
  { id: 'vsSma50', label: 'vs SMA50', unit: 'pct', desc: 'How far the price is above (+) or below (−) its 50-day simple moving average.', learn: 'sma' },
  { id: 'vsSma200', label: 'vs SMA200', unit: 'pct', desc: 'How far the price is above (+) or below (−) its 200-day simple moving average.', learn: 'sma' },
  { id: 'fromHigh52', label: 'From 52w high', unit: 'pct', desc: 'Distance below the highest high of the last 52 weeks (0% = at the high).', learn: '52-week-high' },
  { id: 'fromLow52', label: 'Above 52w low', unit: 'pct', desc: 'Distance above the lowest low of the last 52 weeks.', learn: '52-week-low' },
  { id: 'relVol', label: 'Rel vol', unit: 'x', desc: 'Latest volume divided by the average of the previous 20 days. Not adjusted for time of day.', learn: 'relative-volume' },
  { id: 'atrPct', label: 'ATR %', unit: 'pct', desc: 'Average True Range (14) as a percentage of price — a typical day’s range.', learn: 'atr' },
  { id: 'gap', label: 'Gap %', unit: 'pct', desc: 'Today’s open versus the previous close.', learn: 'gap' },
  { id: 'trend', label: 'Trend', unit: 'text', desc: 'Up: price above SMA50 above SMA200. Down: the reverse. Otherwise mixed. A description, not a forecast.', learn: 'trend' },
];
export const SCAN_FIELD_BY_ID = Object.fromEntries(SCAN_FIELDS.map((f) => [f.id, f]));

// Filter operators. 'is' compares text fields (trend) and the cross flags.
export const SCAN_OPS = { gt: '>', lt: '<', is: '=' };

/* Educational presets: each one names a chart condition in plain words. */
export const SCAN_PRESETS = [
  { id: 'all', label: 'Everything', desc: 'No filter — every symbol in the list.', filters: [] },
  { id: 'oversold', label: 'Oversold RSI < 30', desc: 'RSI(14) below 30: the price has fallen fast relative to its recent rises. It can keep falling.', filters: [{ f: 'rsi14', op: 'lt', v: 30 }] },
  { id: 'overbought', label: 'Overbought RSI > 70', desc: 'RSI(14) above 70: the price has risen fast relative to its recent falls. It can keep rising.', filters: [{ f: 'rsi14', op: 'gt', v: 70 }] },
  { id: 'near-high', label: 'Near 52w high', desc: 'Within 3% of the highest price of the last year.', filters: [{ f: 'fromHigh52', op: 'gt', v: -3 }] },
  { id: 'near-low', label: 'Near 52w low', desc: 'Within 5% of the lowest price of the last year.', filters: [{ f: 'fromLow52', op: 'lt', v: 5 }] },
  { id: 'golden', label: 'Golden cross', desc: 'The 50-day average crossed above the 200-day average within the last 10 trading days.', filters: [{ f: 'cross', op: 'is', v: 'golden' }] },
  { id: 'death', label: 'Death cross', desc: 'The 50-day average crossed below the 200-day average within the last 10 trading days.', filters: [{ f: 'cross', op: 'is', v: 'death' }] },
  { id: 'unusual-vol', label: 'Unusual volume', desc: 'Latest volume at least twice its 20-day average.', filters: [{ f: 'relVol', op: 'gt', v: 2 }] },
  { id: 'gap-up', label: 'Gap up', desc: 'Opened more than 2% above the previous close.', filters: [{ f: 'gap', op: 'gt', v: 2 }] },
  { id: 'gap-down', label: 'Gap down', desc: 'Opened more than 2% below the previous close.', filters: [{ f: 'gap', op: 'lt', v: -2 }] },
  { id: 'uptrend', label: 'Uptrend', desc: 'Price above the 50-day average, which is above the 200-day average.', filters: [{ f: 'trend', op: 'is', v: 'up' }] },
  { id: 'volatile', label: 'High volatility', desc: 'A typical day’s range (ATR) above 4% of the price.', filters: [{ f: 'atrPct', op: 'gt', v: 4 }] },
];

/* metricsFromBars(bars, quote?) → one screener row's numbers, or null when there
   are no bars. Quote fields win for price/1D/gap only when the quote is for the
   same trading day as the last bar or later. */
export function metricsFromBars(bars, quote) {
  const b = (Array.isArray(bars) ? bars : []).filter((x) => x && fin(x.c));
  if (!b.length) return null;
  const n = b.length;
  const closes = b.map((x) => x.c);
  const last = b[n - 1];
  const q = quote && fin(quote.price) ? quote : null;
  const price = q ? q.price : last.c;
  // When the quote is live and the last bar is today's still-forming bar, the
  // "previous close" is the bar before it; otherwise the last bar's own close.
  const lastDay = new Date(last.t).toISOString().slice(0, 10);
  const qDay = q && fin(q.ts) ? new Date(q.ts).toISOString().slice(0, 10) : null;
  const barIsToday = qDay && qDay === lastDay;
  const ref = (k) => { const i = n - 1 - k - (q && !barIsToday ? -1 : 0); return i >= 0 && i < n ? b[i].c : null; };
  const chg1d = q && fin(q.changePct) ? q.changePct : pct(price, ref(1));
  const chg5d = pct(price, ref(5));
  const chg1m = pct(price, ref(21));

  // YTD: last close of the previous calendar year (UTC trading date).
  const year = new Date((q && fin(q.ts)) ? q.ts : last.t).getUTCFullYear();
  let ytdBase = null;
  for (let i = n - 1; i >= 0; i--) { if (new Date(b[i].t).getUTCFullYear() < year) { ytdBase = b[i].c; break; } }
  const chgYtd = pct(price, ytdBase);

  const rsiArr = rsiOf(closes, 14);
  const rsi14 = rsiArr[n - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const sma50 = s50[n - 1], sma200 = s200[n - 1];
  const vsSma50 = pct(price, sma50);
  const vsSma200 = pct(price, sma200);

  // Golden/death cross within the last 10 bars.
  let cross = null;
  for (let i = Math.max(1, n - 10); i < n; i++) {
    const a0 = s50[i - 1], b0 = s200[i - 1], a1 = s50[i], b1 = s200[i];
    if (![a0, b0, a1, b1].every(fin)) continue;
    if (a0 <= b0 && a1 > b1) cross = 'golden';
    else if (a0 >= b0 && a1 < b1) cross = 'death';
  }

  const yearBars = b.slice(-252);
  let high52 = -Infinity, low52 = Infinity;
  for (const x of yearBars) { const h = fin(x.h) ? x.h : x.c, l = fin(x.l) ? x.l : x.c; if (h > high52) high52 = h; if (l < low52) low52 = l; }
  if (q) { high52 = Math.max(high52, q.high ?? price, price); low52 = Math.min(low52, q.low ?? price, price); }
  const fromHigh52 = pct(price, high52);
  const fromLow52 = pct(price, low52);

  const vols = b.map((x) => (fin(x.v) ? x.v : null));
  const todayVol = q && fin(q.volume) ? q.volume : vols[n - 1];
  const prior = vols.slice(barIsToday || !q ? -21 : -20, barIsToday || !q ? -1 : undefined).filter(fin);
  const avgVol20 = prior.length >= 5 ? prior.reduce((a, c) => a + c, 0) / prior.length : null;
  const relVol = fin(todayVol) && fin(avgVol20) && avgVol20 > 0 ? todayVol / avgVol20 : null;

  const atrArr = atrOf(b, 14);
  const atrV = atrArr[n - 1];
  const atrPct = fin(atrV) && price ? (atrV / price) * 100 : null;

  const prevClose = q && fin(q.prevClose) ? q.prevClose : (n >= 2 ? b[n - 2].c : null);
  const open = q && fin(q.open) ? q.open : last.o;
  const gap = pct(open, prevClose);

  let trend = 'mixed';
  if (fin(sma50) && fin(sma200)) {
    if (price > sma50 && sma50 > sma200) trend = 'up';
    else if (price < sma50 && sma50 < sma200) trend = 'down';
  } else trend = null;

  return {
    price, chg1d, chg5d, chg1m, chgYtd, rsi14: fin(rsi14) ? rsi14 : null,
    sma50: fin(sma50) ? sma50 : null, sma200: fin(sma200) ? sma200 : null, vsSma50, vsSma200,
    high52: fin(high52) ? high52 : null, low52: fin(low52) ? low52 : null, fromHigh52, fromLow52,
    volume: fin(todayVol) ? todayVol : null, avgVol20, relVol, atrPct, gap, trend, cross,
    bars: n, asOf: last.t,
  };
}

// One filter against one row. A missing number never passes: a symbol the
// provider could not measure is not "below 30".
export function passes(row, f) {
  if (!row || !f) return false;
  const v = row[f.f];
  if (f.op === 'is') return v === f.v;
  if (!fin(v) || !fin(Number(f.v))) return false;
  return f.op === 'gt' ? v > Number(f.v) : f.op === 'lt' ? v < Number(f.v) : false;
}

export function applyFilters(rows, filters) {
  const fs = (Array.isArray(filters) ? filters : []).filter((f) => f && f.f);
  if (!fs.length) return rows.slice();
  return rows.filter((r) => fs.every((f) => passes(r.m, f)));
}

/* Squarified treemap (Bruls, Huizing, van Wijk 2000). items: [{value, ...}],
   returns the same items with {x, y, w, h} inside the given rectangle. Values
   must be positive; zero-sized items are dropped. */
export function treemap(items, x, y, w, h) {
  const list = items.filter((it) => fin(it.value) && it.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((a, it) => a + it.value, 0);
  if (!list.length || w <= 0 || h <= 0 || total <= 0) return [];
  const scale = (w * h) / total;
  const out = [];
  let rect = { x, y, w, h };
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, it) => a + it.value * scale, 0);
    if (!s) return Infinity;
    let mx = 0, mn = Infinity;
    for (const it of r) { const a = it.value * scale; if (a > mx) mx = a; if (a < mn) mn = a; }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layout = (r) => {
    const s = r.reduce((a, it) => a + it.value * scale, 0);
    if (rect.w >= rect.h) {
      const cw = s / rect.h;
      let cy = rect.y;
      for (const it of r) { const ch = (it.value * scale) / cw; out.push({ ...it, x: rect.x, y: cy, w: cw, h: ch }); cy += ch; }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const ch = s / rect.w;
      let cx = rect.x;
      for (const it of r) { const cw = (it.value * scale) / ch; out.push({ ...it, x: cx, y: rect.y, w: cw, h: ch }); cx += cw; }
      rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
    }
  };
  for (const it of list) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
    else { layout(row); row = [it]; }
  }
  if (row.length) layout(row);
  return out;
}
