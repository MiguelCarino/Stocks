/* viz.js — dependency-free chart primitives.
   sparkline(): inline SVG micro line+area for cards.
   drawLineChart(): themed <canvas> line chart for the detail drawer. */

// Build an inline-SVG sparkline string from an array of numbers.
// dir: 'up' | 'down' | 'flat' selects the accent color via CSS classes.
export function sparkline(points, { w = 220, h = 40, pad = 2 } = {}) {
  if (!points || points.length < 2) return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
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

// Draw a themed line chart into a <canvas>. Reads colors from CSS custom
// properties so it stays true to whatever theme the page is in.
export function drawLineChart(canvas, points) {
  if (!canvas) return;
  const cs = getComputedStyle(document.documentElement);
  const col = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  const accent = col('--accent', '#eab308');
  const grid = col('--border', '#262626');
  const axis = col('--text-muted', '#666');
  const up = col('--ok', '#22c55e'), down = col('--err', '#ef4444');

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!points || points.length < 2) {
    ctx.fillStyle = axis; ctx.font = "12px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center';
    ctx.fillText('No series data', W / 2, H / 2);
    return;
  }

  const padL = 52, padR = 10, padT = 12, padB = 22;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const n = points.length;
  const X = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const line = points[n - 1] >= points[0] ? up : down;

  // gridlines + price labels
  ctx.strokeStyle = grid; ctx.fillStyle = axis; ctx.lineWidth = 1;
  ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const rows = 4;
  for (let r = 0; r <= rows; r++) {
    const v = min + (span * r) / rows, yy = Y(v);
    ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillText(v.toFixed(2), padL - 6, yy);
  }

  // area
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, hexA(line, 0.20)); grad.addColorStop(1, hexA(line, 0));
  ctx.beginPath(); ctx.moveTo(X(0), Y(points[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(points[i]));
  ctx.lineTo(X(n - 1), H - padB); ctx.lineTo(X(0), H - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath(); ctx.moveTo(X(0), Y(points[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(points[i]));
  ctx.strokeStyle = line; ctx.lineWidth = 1.6; ctx.stroke();

  // last point marker
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(X(n - 1), Y(points[n - 1]), 2.6, 0, Math.PI * 2); ctx.fill();
}

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
