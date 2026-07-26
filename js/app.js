/* app.js — Carino Stocks controller + view.
   Monitoring & visualization only: no trading, no brokerage, no advice. */

import { store, normalizeSymbol } from './store.js';
import { market } from './providers/index.js';
import { sparkline, drawLineChart } from './viz.js';
import { createScheduler, evaluateAlerts, portfolioTotals, costPerShare } from './engine.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const DISCLAIMER = 'Not investment advice. Quotes may be delayed and come from third-party APIs using your own keys. '
  + 'Alerts fire only while a tab is open. Your watchlist, holdings, rules and keys stay in your browser and are never '
  + 'sent anywhere but the data provider. Stocks is a monitoring and visualization tool only — it does not place trades, '
  + 'connect to brokerages, or move money.';

const state = { quotes: {}, view: 'watch', lastUpdated: 0 };
let scheduler;

/* ---- boot ----------------------------------------------------------------- */
function boot() {
  store.initWatchlist();
  $('pageDisclaimer').textContent = DISCLAIMER;
  $('railDisclaimer').textContent = 'Data stays in your browser. Not investment advice.';
  $('ackText').textContent = DISCLAIMER;

  applySettingsToUI();
  wireControls();
  wireModals();
  wireDrawer();
  renderRail();
  renderCards();
  updateModeChip();

  if (!store.settings.ack) $('ackGate').hidden = false;

  scheduler = createScheduler(tick);
  scheduler.start();
}

/* ---- refresh tick --------------------------------------------------------- */
async function tick() {
  const syms = store.watchlist.slice();
  const portSyms = store.holdings.map((h) => h.symbol);
  const idx = store.settings.showMarket ? ['SPY', 'QQQ', 'DIA'] : [];
  const all = [...new Set([...syms, ...portSyms, ...idx])];
  if (!all.length) { renderCards(); renderMarketStrip(); return; }

  let quotes;
  try {
    quotes = await market.quotes(all);
    state.fetchError = null;
  } catch (e) {
    if (e && e.rateLimited) throw e;   // let the scheduler back off on HTTP 429
    state.fetchError = 'Quote fetch failed — check your API key or connection.';
    updateModeChip();
    return;
  }
  state.quotes = { ...state.quotes, ...quotes };
  state.lastUpdated = Date.now();

  // sparkline series: the facade's TTL decides cache vs refetch (conserves budget).
  await Promise.all(syms.map((s) => market.series(s).catch(() => {})));

  evaluateAlerts(state.quotes, fireAlert);

  renderCards();
  renderRail();
  if (state.view === 'port') renderPortfolio();
  renderMarketStrip();
}

/* ---- watchlist cards ------------------------------------------------------ */
function sortedWatchlist() {
  const w = store.watchlist.slice();
  const mode = $('sortSel').value;
  if (mode === 'alpha') w.sort((a, b) => a.localeCompare(b));
  else if (mode === 'change') w.sort((a, b) => (state.quotes[b]?.changePct ?? -1e9) - (state.quotes[a]?.changePct ?? -1e9));
  return w;
}

function renderCards() {
  const grid = $('cardGrid');
  const empty = $('emptyState');
  const list = sortedWatchlist();
  empty.hidden = list.length > 0;
  grid.hidden = list.length === 0;
  grid.textContent = '';

  for (const sym of list) {
    const q = state.quotes[sym];
    const prof = store.profiles[sym];
    const card = el('article', 'card');
    card.dataset.sym = sym;

    const head = el('div', 'card-head');
    const idBox = el('div', 'card-id');
    idBox.append(el('span', 'card-sym', sym));
    idBox.append(el('span', 'card-name', prof?.name || ''));
    const btns = el('div', 'card-btns');
    const bell = el('button', 'icon-mini', '🔔'); bell.title = 'Alerts'; bell.dataset.act = 'alert';
    const rm = el('button', 'icon-mini', '✕'); rm.title = 'Remove'; rm.dataset.act = 'remove';
    const nrules = store.rulesFor(sym).filter((r) => r.armed).length;
    if (nrules) { const b = el('span', 'rule-badge', String(nrules)); bell.appendChild(b); }
    btns.append(bell, rm);
    head.append(idBox, btns);

    const priceRow = el('div', 'card-price-row');
    priceRow.append(el('span', 'card-price amount', q ? fmtPrice(q.price) : '—'));
    priceRow.append(deltaChip(q));

    const spark = el('div', 'card-spark');
    spark.innerHTML = sparkline(store.series[sym]?.points || []);

    const range = el('div', 'card-range');
    range.appendChild(rangeBar(q));

    const foot = el('div', 'card-foot');
    foot.append(el('span', 'card-src', q ? q.source : '—'));
    foot.append(el('span', 'card-ts', q ? 'as of ' + fmtTime(q.ts) : ''));

    card.append(head, priceRow, spark, range, foot);
    grid.appendChild(card);
  }
}

function deltaChip(q) {
  const c = el('span', 'delta');
  if (!q || q.changePct == null) { c.classList.add('flat'); c.textContent = '—'; return c; }
  const up = q.changePct >= 0;
  c.classList.add(up ? 'up' : 'down');
  c.textContent = `${up ? '▲' : '▼'} ${fmtNum(q.change)} (${fmtNum(q.changePct)}%)`;
  return c;
}

function rangeBar(q) {
  const bar = el('div', 'rangebar');
  if (!q || q.low == null || q.high == null || q.price == null || q.high <= q.low) { bar.classList.add('empty'); return bar; }
  const pct = Math.max(0, Math.min(100, ((q.price - q.low) / (q.high - q.low)) * 100));
  bar.append(el('span', 'rb-lo', fmtNum(q.low)));
  const track = el('div', 'rb-track'); const mark = el('div', 'rb-mark'); mark.style.left = pct + '%';
  track.appendChild(mark); bar.appendChild(track);
  bar.append(el('span', 'rb-hi', fmtNum(q.high)));
  return bar;
}

/* card click delegation */
document.addEventListener('click', (e) => {
  const card = e.target.closest && e.target.closest('.card');
  if (!card) return;
  const sym = card.dataset.sym;
  const act = e.target.dataset.act;
  if (act === 'remove') { store.removeSymbol(sym); refreshAll(); }
  else if (act === 'alert') { openAlerts(sym); }
  else { openDrawer(sym); }
});

/* ---- left rail ------------------------------------------------------------ */
function renderRail() {
  const list = $('railList');
  list.textContent = '';
  for (const sym of sortedWatchlist()) {
    const q = state.quotes[sym];
    const row = el('div', 'rail-row'); row.dataset.sym = sym;
    row.append(el('span', 'rr-sym', sym));
    row.append(el('span', 'rr-price amount', q ? fmtPrice(q.price) : '—'));
    row.appendChild(deltaChip(q));
    row.addEventListener('click', () => openDrawer(sym));
    list.appendChild(row);
  }
}

/* ---- market strip --------------------------------------------------------- */
async function renderMarketStrip() {
  const strip = $('marketStrip');
  strip.hidden = !store.settings.showMarket;
  if (!store.settings.showMarket) return;
  const tiles = $('mktTiles');
  tiles.textContent = '';
  for (const [sym, label] of [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow 30']]) {
    const q = state.quotes[sym];
    const tile = el('div', 'stat-tile');
    tile.append(el('div', 'st-label', label));
    tile.append(el('div', 'st-value amount', q ? fmtPrice(q.price) : '—'));
    tile.appendChild(deltaChip(q));
    tiles.appendChild(tile);
  }
  const st = await market.marketStatus();
  const chip = $('mktState');
  if (st) { chip.textContent = st.isOpen ? 'OPEN' : 'CLOSED'; chip.classList.toggle('live', st.isOpen); }
  else { const m = market.modeLabel(); chip.textContent = m.text; chip.classList.toggle('live', m.live); }
  $('mktUpdated').textContent = state.lastUpdated ? 'Updated ' + fmtTime(state.lastUpdated) : '';
}

/* ---- detail drawer -------------------------------------------------------- */
let drawerSym = null, drawerRange = '1D';
function openDrawer(sym) {
  drawerSym = sym; drawerRange = '1D';
  $('drawerScrim').hidden = false;
  const d = $('drawer'); d.hidden = false; d.setAttribute('aria-hidden', 'false');
  void d.offsetWidth;                 // force reflow so the slide-in transition plays reliably
  d.classList.add('open');
  renderDrawer();
}
function closeDrawer() {
  const d = $('drawer'); d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
  $('drawerScrim').hidden = true;
  setTimeout(() => { d.hidden = true; }, 250);
  drawerSym = null;
}
function wireDrawer() {
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
}
async function renderDrawer() {
  const sym = drawerSym; if (!sym) return;
  const q = state.quotes[sym];
  const prof = await market.profile(sym).catch(() => null);
  $('drawerTitle').textContent = sym + (prof ? ' · ' + prof.name : '');
  const body = $('drawerBody');
  body.textContent = '';

  const kv = el('div', 'kv-grid');
  const pair = (k, v) => { kv.append(el('div', 'kv-k', k)); const d = el('div', 'kv-v amount', v); kv.append(d); };
  pair('Last', q ? fmtPrice(q.price) : '—');
  pair('Change', q && q.changePct != null ? `${fmtNum(q.change)} (${fmtNum(q.changePct)}%)` : '—');
  pair('Open', q ? fmtNum(q.open) : '—');
  pair('Prev close', q ? fmtNum(q.prevClose) : '—');
  pair('Day range', q && q.low != null ? `${fmtNum(q.low)} – ${fmtNum(q.high)}` : '—');
  pair('Volume', q && q.volume != null ? fmtInt(q.volume) : '—');
  if (prof) { pair('Exchange', prof.exchange || '—'); pair('Sector', prof.sector || '—'); pair('Market cap', prof.marketCap ? fmtCap(prof.marketCap) : '—'); }
  body.appendChild(kv);

  const tabs = el('div', 'range-tabs');
  for (const r of ['1D', '1M', '1Y']) {
    const b = el('button', 'range-tab' + (r === drawerRange ? ' active' : ''), r);
    b.addEventListener('click', () => { drawerRange = r; renderDrawer(); });
    tabs.appendChild(b);
  }
  body.appendChild(tabs);

  const chartWrap = el('div', 'chart-wrap');
  const canvas = el('canvas', 'detail-chart');
  chartWrap.appendChild(canvas);
  body.appendChild(chartWrap);

  const note = el('p', 'field-note', 'Series via ' + (store.settings.twelvedataKey || store.settings.provider === 'demo' || (!store.settings.finnhubKey && !store.settings.twelvedataKey) ? 'chart provider' : 'demo cache') + '. Delayed · not advice.');
  body.appendChild(note);

  const pts = await market.series(sym, drawerRange).catch(() => []);
  drawLineChart(canvas, pts);
}

/* ---- portfolio ------------------------------------------------------------ */
function renderPortfolio() {
  const { rows, value, cost, dayPL, totalPL, totalPLPct } = portfolioTotals(store.holdings, state.quotes);
  const stats = $('portStats');
  stats.textContent = '';
  const tile = (label, val, delta) => {
    const t = el('div', 'stat-tile');
    t.append(el('div', 'st-label', label));
    t.append(el('div', 'st-value amount', val));
    if (delta) t.appendChild(delta);
    return t;
  };
  stats.append(tile('Total value', value != null ? fmtPrice(value) : '—'));
  stats.append(tile('Day P/L', dayPL != null ? signed(dayPL) : '—', plChip(dayPL, null)));
  stats.append(tile('Total P/L', totalPL != null ? signed(totalPL) : '—', plChip(totalPL, totalPLPct)));
  stats.append(tile('Cost basis', fmtPrice(cost)));

  const body = $('portBody');
  body.textContent = '';
  if (!rows.length) {
    const tr = el('tr'); const td = el('td', 'empty-cell', 'No holdings yet. Add one below.'); td.colSpan = 9; tr.appendChild(td); body.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = el('tr'); tr.dataset.id = r.holding.id;
    const cells = [
      r.holding.symbol,
      fmtNum(r.shares), fmtNum(r.avg),
      r.price != null ? fmtNum(r.price) : '—',
      r.marketValue != null ? fmtPrice(r.marketValue) : '—',
      r.dayPL != null ? signed(r.dayPL) : '—',
      r.totalPL != null ? `${signed(r.totalPL)}` : '—',
      r.weight != null ? r.weight.toFixed(1) + '%' : '—',
    ];
    tr.append(el('td', 'sym', cells[0]));
    for (let i = 1; i < cells.length; i++) {
      const td = el('td', 'num amount', cells[i]);
      if (i === 5 && r.dayPL != null) td.classList.add(r.dayPL >= 0 ? 'pos' : 'neg');
      if (i === 6 && r.totalPL != null) td.classList.add(r.totalPL >= 0 ? 'pos' : 'neg');
      tr.appendChild(td);
    }
    const edit = el('td'); const eb = el('button', 'icon-mini', '✎'); eb.addEventListener('click', () => openHolding(r.holding)); edit.appendChild(eb); tr.appendChild(edit);
    body.appendChild(tr);
  }
}
function plChip(v, pct) {
  if (v == null) return null;
  const c = el('span', 'delta ' + (v >= 0 ? 'up' : 'down'));
  c.textContent = (v >= 0 ? '▲' : '▼') + (pct != null ? ' ' + fmtNum(pct) + '%' : '');
  return c;
}

/* ---- controls ------------------------------------------------------------- */
function wireControls() {
  $('btnPause').addEventListener('click', () => {
    const p = !scheduler.isPaused(); scheduler.setPaused(p);
    $('btnPause').textContent = p ? '▶' : '⏸';
    $('btnPause').classList.toggle('active', p);
  });
  $('intervalSel').addEventListener('change', (e) => {
    store.settings.interval = +e.target.value; store.saveSettings();
  });
  $('intervalSel').value = String(store.settings.interval);
  $('btnAdd').addEventListener('click', () => openModal('addModal', () => { $('addSearch').value = ''; $('addAuto').textContent = ''; $('addSearch').focus(); }));
  $('viewWatch').addEventListener('click', () => setView('watch'));
  $('viewPort').addEventListener('click', () => setView('port'));
  $('btnPrivacy').addEventListener('click', () => { setPrivacy(!store.settings.privacy); });
  $('btnAlerts').addEventListener('click', () => openAlerts(store.watchlist[0] || ''));
  $('btnSettings').addEventListener('click', openSettings);
  $('sortSel').addEventListener('change', () => { renderCards(); renderRail(); });

  wireAutocomplete($('railSearch'), $('railAuto'), (sym) => { if (store.addSymbol(sym)) { $('railSearch').value = ''; $('railAuto').hidden = true; refreshAll(); } });
  $('emptyAdd').addEventListener('click', () => $('btnAdd').click());
  $('emptyDemo').addEventListener('click', () => { store.watchlist = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'AMD']; store.saveWatchlist(); refreshAll(); });
  $('addHolding').addEventListener('click', () => openHolding(null));

  $('ackBtn').addEventListener('click', () => { store.settings.ack = true; store.saveSettings(); $('ackGate').hidden = true; });

  setPrivacy(store.settings.privacy);
}

function setView(v) {
  state.view = v;
  $('watchView').hidden = v !== 'watch';
  $('portView').hidden = v !== 'port';
  $('viewWatch').classList.toggle('active', v === 'watch');
  $('viewPort').classList.toggle('active', v === 'port');
  if (v === 'port') renderPortfolio();
}
function setPrivacy(on) {
  store.settings.privacy = on; store.saveSettings();
  document.body.classList.toggle('privacy-on', on);
  $('btnPrivacy').classList.toggle('active', on);
}

/* ---- autocomplete --------------------------------------------------------- */
// Wire an input + result box into a keyboard-navigable autocomplete:
// type to search, ↑/↓ to highlight, Enter to commit the highlight or the typed
// symbol, Esc to dismiss; clicking a row still works.
function wireAutocomplete(input, box, onPick) {
  let acTimer = null;
  box.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');

  const hi = (i) => {
    const rows = [...box.querySelectorAll('.ac-row')];
    box._hi = i = Math.max(-1, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('active', k === i));
  };

  input.addEventListener('input', () => {
    clearTimeout(acTimer);
    const q = input.value.trim();
    if (q.length < 1) { box.hidden = true; box.textContent = ''; box._hi = -1; return; }
    acTimer = setTimeout(async () => {
      const results = await market.search(q).catch(() => []);
      box.textContent = ''; box._hi = -1;
      for (const r of results.slice(0, 10)) {
        const row = el('div', 'ac-row'); row.setAttribute('role', 'option');
        row.dataset.sym = normalizeSymbol(r.symbol);
        row.append(el('span', 'ac-sym', r.symbol));
        row.append(el('span', 'ac-desc', r.description || ''));
        row.addEventListener('click', () => onPick(row.dataset.sym));
        box.appendChild(row);
      }
      // Always offer to add exactly what was typed, so committing never depends
      // on a search match (demo mode only knows the bundled tickers).
      const typed = normalizeSymbol(q);
      if (typed && ![...box.querySelectorAll('.ac-row')].some((r) => r.dataset.sym === typed)) {
        const row = el('div', 'ac-row'); row.setAttribute('role', 'option');
        row.dataset.sym = typed;
        row.append(el('span', 'ac-sym', typed));
        row.append(el('span', 'ac-desc', 'Add symbol'));
        row.addEventListener('click', () => onPick(row.dataset.sym));
        box.appendChild(row);
      }
      box.hidden = box.children.length === 0;
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    const rows = [...box.querySelectorAll('.ac-row')];
    if (e.key === 'ArrowDown') { e.preventDefault(); if (box.hidden) return; hi((box._hi ?? -1) + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (box.hidden) return; hi((box._hi ?? -1) - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = (box._hi >= 0 && rows[box._hi]) ? rows[box._hi].dataset.sym : normalizeSymbol(input.value);
      if (pick) onPick(pick);
    } else if (e.key === 'Escape') { box.hidden = true; }
  });
}

/* ---- modals --------------------------------------------------------------- */
function openModal(id, after) {
  $('modalScrim').hidden = false;
  for (const m of document.querySelectorAll('.modal')) m.hidden = m.id !== id;
  if (after) after();
}
function closeModal() {
  $('modalScrim').hidden = true;
  for (const m of document.querySelectorAll('.modal')) m.hidden = true;
}
function wireModals() {
  $('modalScrim').addEventListener('click', (e) => { if (e.target === $('modalScrim')) closeModal(); });
  for (const x of document.querySelectorAll('[data-close]')) x.addEventListener('click', closeModal);

  wireAutocomplete($('addSearch'), $('addAuto'), (sym) => { store.addSymbol(sym); closeModal(); refreshAll(); });

  // Settings
  $('setProvider').addEventListener('change', updateProviderConfig);
  $('setUniversal').addEventListener('change', updateProviderConfig);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', doImport);
  $('btnClearData').addEventListener('click', () => {
    if (confirm('Erase all watchlists, holdings, rules, keys and settings from this browser?')) { store.clearAll(); location.reload(); }
  });

  // Alerts
  $('ruleAdd').addEventListener('click', addRuleFromForm);

  // Holding
  $('holdSave').addEventListener('click', saveHolding);
  $('holdDelete').addEventListener('click', deleteHolding);
}

/* ---- settings ------------------------------------------------------------- */
function applySettingsToUI() {
  const s = store.settings;
  $('setFinnhub').value = s.finnhubKey; $('setTwelve').value = s.twelvedataKey;
  $('setPolygon').value = s.polygonKey; $('setAlpha').value = s.alphaVantageKey;
  $('setAlpacaId').value = s.alpacaKeyId; $('setAlpacaSecret').value = s.alpacaSecret;
  // Derive the toggle + dropdown from the (possibly legacy) stored provider.
  const universal = s.provider !== 'auto';
  const selected = universal ? s.provider : (s.selectedProvider || 'finnhub');
  $('setUniversal').checked = universal;
  $('setProvider').value = selected;
  $('setInterval').value = s.interval;
  $('setNotify').checked = s.notify; $('setSound').checked = s.sound;
  $('setMarket').checked = s.showMarket; $('setPrivacy').checked = s.privacy;
  updateProviderConfig();
}

// Show only the selected provider's key fields; update the mode note.
const PROVIDER_LABELS = { finnhub: 'Finnhub', twelvedata: 'Twelve Data', polygon: 'Polygon', alpaca: 'Alpaca', alphavantage: 'Alpha Vantage', demo: 'Demo' };
function updateProviderConfig() {
  const sel = $('setProvider').value;
  for (const box of document.querySelectorAll('.provider-config')) box.hidden = box.dataset.provider !== sel;
  const universal = $('setUniversal').checked;
  $('providerModeNote').textContent = universal
    ? `Every symbol uses ${PROVIDER_LABELS[sel] || sel}.`
    : 'Auto-route: equities use the selected stock provider, crypto uses CoinGecko (keyless), FX uses Twelve Data. Symbols are grouped so each provider gets one batched call — add keys for whichever providers you use.';
}
function openSettings() { openModal('settingsModal', () => { applySettingsToUI(); $('keyStatus').textContent = ''; }); }
async function saveSettings() {
  const s = store.settings;
  s.finnhubKey = $('setFinnhub').value.trim();
  s.twelvedataKey = $('setTwelve').value.trim();
  s.polygonKey = $('setPolygon').value.trim();
  s.alphaVantageKey = $('setAlpha').value.trim();
  s.alpacaKeyId = $('setAlpacaId').value.trim();
  s.alpacaSecret = $('setAlpacaSecret').value.trim();
  s.selectedProvider = $('setProvider').value;
  s.universal = $('setUniversal').checked;
  s.provider = s.universal ? s.selectedProvider : 'auto';   // derived: the router's input
  s.interval = Math.max(5, Math.min(600, +$('setInterval').value || 15));
  s.notify = $('setNotify').checked; s.sound = $('setSound').checked;
  s.showMarket = $('setMarket').checked; s.privacy = $('setPrivacy').checked;
  store.saveSettings();
  $('intervalSel').value = String(s.interval);
  setPrivacy(s.privacy);
  updateModeChip();

  if (s.notify && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (e) {}
  }
  // validate keys (best-effort)
  const status = $('keyStatus'); status.textContent = 'Checking keys…';
  const parts = [];
  if (s.finnhubKey) parts.push('Finnhub ' + (await market.validate('finnhub').catch(() => false) ? '✓' : '✕'));
  if (s.twelvedataKey) parts.push('Twelve Data ' + (await market.validate('twelvedata').catch(() => false) ? '✓' : '✕'));
  if (s.polygonKey) parts.push('Polygon ' + (await market.validate('polygon').catch(() => false) ? '✓' : '✕'));
  if (s.alphaVantageKey) parts.push('Alpha Vantage ' + (await market.validate('alphavantage').catch(() => false) ? '✓' : '✕'));
  if (s.alpacaKeyId && s.alpacaSecret) parts.push('Alpaca ' + (await market.validate('alpaca').catch(() => false) ? '✓' : '✕'));
  status.textContent = parts.join('  ·  ') || 'Demo mode (no keys).';
  refreshAll();
}
function doExport() {
  const blob = new Blob([store.exportState()], { type: 'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = 'carino-stocks-' + Math.floor(Date.now() / 1000) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function doImport(e) {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { store.importState(rd.result); applySettingsToUI(); refreshAll(); toast('Imported.'); } catch (err) { toast('Import failed: ' + err.message, 'err'); } };
  rd.readAsText(f); e.target.value = '';
}

/* ---- alerts modal --------------------------------------------------------- */
function openAlerts(sym) {
  openModal('alertsModal', () => {
    const sel = $('ruleSym'); sel.textContent = '';
    for (const s of store.watchlist) { const o = el('option', null, s); o.value = s; sel.appendChild(o); }
    if (sym) sel.value = sym;
    renderRuleList(); renderAlertLog();
  });
}
function addRuleFromForm() {
  const symbol = $('ruleSym').value; const value = parseFloat($('ruleVal').value);
  if (!symbol || !Number.isFinite(value)) { toast('Enter a valid threshold.', 'err'); return; }
  store.addRule({ id: 'r' + Date.now() + Math.floor(Math.random() * 1e4), symbol, type: $('ruleType').value, op: $('ruleOp').value, value, armed: true });
  $('ruleVal').value = '';
  renderRuleList(); renderCards();
}
function renderRuleList() {
  const list = $('ruleList'); list.textContent = '';
  if (!store.rules.length) { list.appendChild(el('p', 'field-note', 'No alert rules yet.')); return; }
  for (const r of store.rules) {
    const row = el('div', 'rule-row');
    const sw = el('button', 'switch' + (r.armed ? ' on' : '')); sw.title = 'Arm/disarm';
    sw.addEventListener('click', () => { store.updateRule(r.id, { armed: !r.armed }); renderRuleList(); renderCards(); });
    row.appendChild(sw);
    row.append(el('span', 'rr-sym', r.symbol));
    row.append(el('span', 'rule-cond', `${r.type === 'pct' ? 'Δ%' : 'price'} ${r.op === 'above' ? '≥' : '≤'} ${r.value}${r.type === 'pct' ? '%' : ''}`));
    const del = el('button', 'icon-mini', '✕'); del.addEventListener('click', () => { store.removeRule(r.id); renderRuleList(); renderCards(); });
    row.appendChild(del);
    list.appendChild(row);
  }
}
function renderAlertLog() {
  const log = $('alertLog'); log.textContent = '';
  const recent = store.alertlog.slice(-8).reverse();
  if (!recent.length) return;
  log.appendChild(el('div', 'rail-lbl', 'Recently triggered'));
  for (const a of recent) { const r = el('div', 'log-row'); r.append(el('span', 'log-time', fmtTime(a.ts))); r.append(el('span', 'log-text', a.text)); log.appendChild(r); }
}

/* ---- holding editor ------------------------------------------------------- */
let editingHolding = null;
function openHolding(h) {
  editingHolding = h;
  openModal('holdingModal', () => {
    $('holdingTitle').textContent = h ? 'Edit holding' : 'Add holding';
    $('holdSym').value = h ? h.symbol : ''; $('holdShares').value = h ? h.shares : '';
    $('holdCost').value = h ? h.cost : ''; $('holdMode').value = h ? h.costMode : 'per';
    $('holdNote').value = h ? (h.note || '') : '';
    $('holdDelete').hidden = !h;
  });
}
function saveHolding() {
  const symbol = normalizeSymbol($('holdSym').value);
  const shares = parseFloat($('holdShares').value); const cost = parseFloat($('holdCost').value);
  if (!symbol || !Number.isFinite(shares)) { toast('Symbol and shares are required.', 'err'); return; }
  const rec = { symbol, shares, cost: Number.isFinite(cost) ? cost : 0, costMode: $('holdMode').value, note: $('holdNote').value.trim() };
  if (editingHolding) { Object.assign(editingHolding, rec); }
  else { rec.id = 'h' + Date.now() + Math.floor(Math.random() * 1e4); store.holdings.push(rec); }
  store.saveHoldings(); closeModal(); refreshAll();
}
function deleteHolding() {
  if (editingHolding) { store.holdings = store.holdings.filter((x) => x.id !== editingHolding.id); store.saveHoldings(); }
  closeModal(); refreshAll();
}

/* ---- alert delivery ------------------------------------------------------- */
function fireAlert(rule, text) {
  toast('🔔 ' + text, 'alert');
  if (store.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Carino Stocks — ' + rule.symbol, { body: text }); } catch (e) {}
  }
  if (store.settings.sound) beep();
  renderAlertLog();
}
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination); g.gain.value = 0.05;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 160);
  } catch (e) {}
}

/* ---- toasts --------------------------------------------------------------- */
function toast(msg, kind) {
  const rack = $('toastRack');
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  rack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 5000);
}

/* ---- misc ----------------------------------------------------------------- */
function updateModeChip() {
  const chip = $('modeChip');
  if (!chip) return;
  if (state.fetchError) { chip.textContent = 'ERROR'; chip.classList.remove('live'); chip.title = state.fetchError; return; }
  const m = market.modeLabel();
  chip.textContent = m.text; chip.classList.toggle('live', m.live); chip.title = 'Data source';
}
function refreshAll() {
  renderRail(); renderCards(); updateModeChip(); renderMarketStrip();
  if (state.view === 'port') renderPortfolio();
  scheduler && scheduler.now();
}

/* ---- formatters ----------------------------------------------------------- */
function fmtPrice(v) { return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtInt(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }
function signed(v) { return (v >= 0 ? '+' : '−') + fmtPrice(Math.abs(v)).replace('$', '$'); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('en-US', { hour12: false }); }
function fmtCap(v) {
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  return '$' + fmtInt(v);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
