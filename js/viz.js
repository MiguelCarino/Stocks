/* viz.js — dependency-free chart primitives.
   sparkline(): inline SVG micro line+area for cards.
   hexA()/toRGB(): theme-token colour helpers shared with chart.js.

   The full price chart (drawer, chart widget, compare, performance) lives in
   chart.js; the old drawLineChart() canvas path it replaced is gone. */

// Build an inline-SVG sparkline string from an array of numbers.
// dir: 'up' | 'down' | 'flat' selects the accent color via CSS classes.
export function sparkline(points, { w = 220, h = 40, pad = 2 } = {}) {
  // A provider hiccup leaves null/NaN holes in a series; one of them in
  // Math.min turns every coordinate into NaN and the path into "MNaN NaN".
  points = finiteOnly(points);
  if (points.length < 2) return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const n = points.length;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const dir = points[n - 1] > points[0] ? 'up' : points[n - 1] < points[0] ? 'down' : 'flat';

  let line = '';
  for (let i = 0; i < n; i++) line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(points[i]).toFixed(1) + ' ';
  const area = line + `L${x(n - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`;
  const lx = x(n - 1).toFixed(1), ly = y(points[n - 1]).toFixed(1);

  return `<svg class="spark ${dir}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="spark-area" d="${area}"/>`
    + `<path class="spark-line" d="${line.trim()}" fill="none"/>`
    + `<circle class="spark-dot" cx="${lx}" cy="${ly}" r="2.2"/>`
    + `</svg>`;
}

// Keep only real numbers. Returns a new array; the caller's series is untouched.
function finiteOnly(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) { const n = p == null ? NaN : Number(p); if (Number.isFinite(n)) out.push(n); }
  return out;
}

/* A theme token with an alpha applied. Tokens are hex today, but nothing stops
   a theme from moving to rgb()/hsl()/oklch(); the old parser read 'rgb(' as hex
   digits and produced rgba(NaN,NaN,NaN,a) — which canvas silently ignores, so
   the gradient vanished. Hex and rgb() are parsed directly; anything else is
   resolved by painting one pixel and reading it back, which works for every
   colour syntax the browser itself understands. Exported for chart.js. */
const colorCache = new Map();
export function hexA(color, a) {
  const rgb = toRGB(color);
  if (!rgb) return color || 'transparent';
  const al = Math.max(0, Math.min(1, Number(a)));
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Number.isFinite(al) ? al : 1})`;
}

export function toRGB(color) {
  const c = String(color || '').trim();
  if (!c) return null;
  if (colorCache.has(c)) return colorCache.get(c);
  let out = null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (hex) {
    let v = hex[1];
    if (v.length === 3 || v.length === 4) v = v.split('').map((ch) => ch + ch).join('');
    if (v.length === 6 || v.length === 8) out = [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16));
  } else {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
    if (m) out = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)));
    else out = probe(c);
  }
  if (out && out.some((x) => !Number.isFinite(x))) out = null;
  colorCache.set(c, out);
  return out;
}

let probeCtx = null;
function probe(c) {
  try {
    if (typeof document === 'undefined') return null;
    if (!probeCtx) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      probeCtx = cv.getContext('2d', { willReadFrequently: true });
    }
    if (!probeCtx) return null;
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillStyle = '#000'; probeCtx.fillStyle = c;   // an unparsable value leaves #000 in place
    probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch (e) { return null; }
}
