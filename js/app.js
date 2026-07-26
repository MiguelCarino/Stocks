/* app.js — Carino Stocks controller + view.
   Monitoring & visualization only: no trading, no brokerage, no advice.

   Everything the user sees is rendered here, but almost nothing is decided here:
   sessions come from the local calendar (session.js), cross-window coordination
   from peers.js, panel windows from displays.js, persistence from store.js. The
   controller's one rule is that it must never present a guess as a fact. A
   session the holiday table cannot vouch for, a price whose timestamp stopped
   advancing, a provider whose idea of "open" contradicts the clock, a window the
   compositor refused to place — each is said out loud rather than smoothed over,
   because a monitoring tool that quietly rounds off its own uncertainty is worse
   than no tool at all. */

import { store, normalizeSymbol } from './store.js';
// budget comes from the facade rather than base.js so the UI never reaches past
// the provider boundary it is supposed to be insulated from.
import { market, budget } from './providers/index.js';
import { sparkline, drawLineChart } from './viz.js';
import { createScheduler, evaluateAlerts, portfolioTotals, pollSeconds } from './engine.js';
import { sessionAt, marketForSymbol, formatCountdown, HOLIDAY_HORIZON, MARKETS } from './session.js';
import { peers } from './peers.js';
import { displays, PANELS } from './displays.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };

const DISCLAIMER = 'Not investment advice. Quotes may be delayed and come from third-party APIs using your own keys. '
  + 'Alerts fire only while a tab is open. Your watchlist, holdings, rules and keys stay in your browser and are never '
  + 'sent anywhere but the data provider. Stocks is a monitoring and visualization tool only — it does not place trades, '
  + 'connect to brokerages, or move money.';

const PROVIDER_LABELS = { finnhub: 'Finnhub', twelvedata: 'Twelve Data', polygon: 'Polygon', alpaca: 'Alpaca', alphavantage: 'Alpha Vantage', coingecko: 'CoinGecko', demo: 'Demo' };

// Whether a provider's quote endpoint can SEE trades outside regular hours.
// true = extended prices reach us; false = regular session only, so a pre/post
// rule could never fire and must not be offered; null = the provider does not
// document it, which is worth saying rather than guessing.
const EXT_HOURS = {
  finnhub: null, twelvedata: false, polygon: true, alpaca: true,
  alphavantage: false, coingecko: true, demo: true,
};

// Published free-tier ceilings, requests per minute. null = no per-minute cap to
// scale a bar against (or, for demo, no network calls at all).
const RATE_CEILING = { finnhub: 60, twelvedata: 8, polygon: 5, alpaca: 200, alphavantage: 5, coingecko: 30, demo: null };

// Rule session scope <-> the rule's `sessions` array. An empty array means every
// session, which is also what a rule written before scoping existed implies.
const SESSION_SCOPES = { regular: ['open'], extended: ['pre', 'open', 'post'], any: [] };
const SCOPE_LABEL = { regular: 'Regular hours', extended: 'Extended hours', any: 'Any session' };

const state = {
  quotes: {}, view: 'watch', lastUpdated: 0, fetchError: null,
  freshness: {},        // symbol -> { ts, changedAt, polls }: staleness is derived, never asserted
  logFilter: '',
  screens: [],
};
let scheduler = null;
let clockTimer = null;

/* ---- boot ----------------------------------------------------------------- */
function boot() {
  store.initWatchlist();
  // A TTL sweep before the first render, so a page opened after a long gap is not
  // drawing from caches the store is about to drop anyway.
  safe(() => store.evictCaches && store.evictCaches());

  $('pageDisclaimer').textContent = DISCLAIMER;
  $('railDisclaimer').textContent = 'Data stays in your browser. Not investment advice.';
  $('ackText').textContent = DISCLAIMER;
  $('sessApprox').textContent = 'Holiday table ends ' + HOLIDAY_HORIZON + ' — later dates are rule-derived, not confirmed';

  applySettingsToUI();
  wireControls();
  wireModals();
  wireDrawer();
  wireHashBanner();
  wireDisplays();
  renderRail();
  renderCards();
  renderMarketStrip();
  updateModeChip();
  renderSession();
  wireQuota();
  renderQuota();
  reportStorage();

  if (!store.settings.ack) $('ackGate').hidden = false;

  startClock();
  startEngine();
}

// Session countdowns and staleness ages are the only things that change without a
// new frame, so they get their own one-second pass instead of a full re-render.
function startClock() {
  clearInterval(clockTimer);
  let n = 0;
  clockTimer = setInterval(() => {
    renderSession();
    refreshTags();
    if (++n % 10 === 0) checkLeadership();
  }, 1000);
}

/* ---- leadership watchdog ---------------------------------------------------
   Exactly one window is supposed to fetch, and the Web Lock that decides which
   one can strand: a page the browser froze or put in its back/forward cache is
   not destroyed, so it keeps its hold (and its queue) while every live window
   waits politely behind a client that will never run again. Observed in Chrome
   after an ordinary reload — the lock reports no holder and still refuses to be
   granted. A mesh that cannot elect anyone must not mean nobody polls, so this
   window starts fetching for itself and says so once. */
const LEADER_GRACE_MS = 6 * 60 * 1000;   // longer than the shut-market poll floor
let leaderless = false, leaderlessTold = false, lastPeerFrame = 0;

function shouldFetch() { return peers.isLeader() || leaderless; }

function checkLeadership() {
  if (peers.isLeader() || Date.now() - lastPeerFrame < LEADER_GRACE_MS) { leaderless = false; return; }
  if (!navigator.locks || typeof navigator.locks.query !== 'function') return;
  navigator.locks.query().then((q) => {
    if (peers.isLeader()) { leaderless = false; return; }
    leaderless = !(q.held || []).some((l) => l.name === 'stk-leader');
    if (leaderless && !leaderlessTold) {
      leaderlessTold = true;
      toast('No window holds the shared refresh lock — this tab is refreshing on its own.', 'err');
      updateModeChip();
    }
  }).catch(() => {});
}

async function startEngine() {
  // Subscribed before init, not after: init waits up to a third of a second for
  // the leader lock, and a popout that says hello inside that window would find
  // nobody listening and sit visibly stale until the next scheduled tick — up to
  // five minutes of it when the market is shut. on() only touches a local map.
  wirePeers();
  try { await peers.init('main'); } catch (e) { /* solo window; peers fails open */ }

  const frame = safe(() => peers.lastFrame());
  // Adopting without painting is how a reloaded window ends up showing dashes
  // over a perfectly good frame until something else happens to re-render.
  if (frame) { adoptFrame(frame); renderAll(); }

  checkLeadership();
  scheduler = createScheduler(tick, {
    getSession: () => governingSession(),
    isLeader: () => shouldFetch(),
    anyVisible: () => peers.anyVisible(),
  });
  scheduler.start();
}

/* ---- cross-window mesh -----------------------------------------------------
   One window fetches; every other window and every popout paints what it
   broadcasts. Incoming 'state' is deliberately NOT adopted by a main window: it
   reads localStorage itself, and a tab showing an ephemeral shared-link view must
   not have a peer's saved watchlist pushed on top of it. */
function wirePeers() {
  peers.on('quotes', (payload) => {
    // Somebody is feeding the mesh, so this window has no reason to fetch even if
    // the lock never came its way.
    lastPeerFrame = Date.now();
    leaderless = false;
    if (peers.isLeader()) return;   // the leader already has this frame; it sent it
    adoptFrame(payload);
    renderAll();
  });

  // A popout paints from the last persisted frame, which may be hours old. Answer
  // its hello immediately rather than leaving it visibly stale until the next tick.
  peers.on('hello', (payload) => {
    if (!shouldFetch() || !state.lastUpdated) return;
    if (!payload || payload.role !== 'popout') return;
    publishFrame();
  });

  // Alerts raised by the leader are shown everywhere, but only the window that
  // raised one may escalate to an OS notification or a beep — otherwise every
  // open tab reports the same alert separately.
  peers.on('alert', (payload) => {
    const text = payload && (payload.text || payload.message);
    if (text) toast('🔔 ' + text, 'alert');
  });
}

function adoptFrame(payload) {
  if (!payload || typeof payload !== 'object') return;
  const quotes = payload.quotes && typeof payload.quotes === 'object' ? payload.quotes : payload;
  const clean = {};
  for (const [sym, q] of Object.entries(quotes)) if (q && typeof q === 'object' && !Array.isArray(q)) clean[sym] = q;
  if (!Object.keys(clean).length) return;
  noteFreshness(clean);
  state.quotes = { ...state.quotes, ...clean };
  const ts = Number(payload.ts);
  state.lastUpdated = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function publishFrame() {
  if (!shouldFetch()) return;   // only a window that fetches may speak for the feed
  const now = Date.now();
  const sess = governingSession(now);
  peers.broadcast('quotes', {
    quotes: state.quotes,
    symbols: store.watchlist.slice(),
    ts: state.lastUpdated,
    // The effective cadence, not the nominal setting: a panel sizes its staleness
    // threshold off this number, and telling it 15s while actually publishing
    // every 300s makes it cry stale through every closed market it ever sees.
    interval: pollSeconds(sess, store.settings.interval),
    paused: !!(scheduler && scheduler.isPaused()),
  });
  // One per market on screen, so a panel showing crypto is not handed the equity
  // calendar's idea of closed.
  for (const mkt of watchedMarkets()) {
    const s = safe(() => sessionAt(now, mkt));
    if (s) peers.broadcast('session', { market: mkt, session: s });
  }
}

// Panels follow the user's edits without a reload; sent on change, not on a timer.
function publishState() {
  peers.broadcast('state', {
    watchlist: store.watchlist.slice(),
    holdings: store.holdings.slice(),
    interval: store.settings.interval,
    settings: { privacy: !!store.settings.privacy },
  });
}

/* ---- refresh tick --------------------------------------------------------- */

// Everything one tick fetches, in one place, because the cadence is decided from
// the same set: a batch is only as closed as its most-open market.
function watchedSymbols() {
  const portSyms = store.holdings.map((h) => h.symbol);
  // Armed rules on symbols that are in neither list would otherwise never be
  // evaluated: the rule would sit there looking live and never fire.
  const ruleSyms = store.rules.filter((r) => r.armed).map((r) => r.symbol);
  const idx = store.settings.showMarket ? ['SPY', 'QQQ', 'DIA'] : [];
  return [...new Set([...store.watchlist, ...portSyms, ...ruleSyms, ...idx])].filter(Boolean);
}

async function tick() {
  // The scheduler already gates on leadership; this is the second belt, because a
  // duplicated fetch spends a real free-tier budget the user cannot get back.
  if (!shouldFetch()) { renderAll(); return; }

  const syms = store.watchlist.slice();
  const all = watchedSymbols();
  if (!all.length) { renderCards(); renderMarketStrip(); return; }

  let quotes;
  try {
    quotes = await market.quotes(all);
    if (state.fetchError) { state.fetchError = null; updateModeChip(); }
  } catch (e) {
    if (e && e.rateLimited) throw e;   // let the scheduler back off on HTTP 429
    state.fetchError = 'Quote fetch failed — check your API key or connection.';
    updateModeChip();
    return;
  }
  noteFreshness(quotes);
  state.quotes = { ...state.quotes, ...quotes };
  state.lastUpdated = Date.now();

  // sparkline series: the facade's TTL decides cache vs refetch (conserves budget).
  await Promise.all(syms.map((s) => market.series(s).catch(() => {})));

  evaluateAlerts(state.quotes, fireAlert, { sessionFor });

  publishFrame();
  renderAll();
  renderQuota();
}

function renderAll() {
  renderCards();
  renderRail();
  if (state.view === 'port') renderPortfolio();
  renderMarketStrip();
  renderSession();
}

/* ---- freshness -------------------------------------------------------------
   A quote is stale when its own timestamp stops advancing across polls, which is
   the only evidence we have; a provider that keeps stamping Date.now() on a
   frozen price would otherwise look permanently live. One observation proves
   nothing, so the clock only starts on the second poll carrying the same ts. */
function noteFreshness(quotes) {
  const now = Date.now();
  for (const [sym, q] of Object.entries(quotes || {})) {
    if (!q) continue;
    const ts = q.ts == null ? null : q.ts;
    const f = state.freshness[sym];
    if (!f || f.ts !== ts) state.freshness[sym] = { ts, changedAt: now, polls: 1 };
    else f.polls++;
  }
}

function frozenMs(sym) {
  const f = state.freshness[sym];
  if (!f || f.polls < 2) return 0;
  return Date.now() - f.changedAt;
}

function staleThreshold() {
  return Math.max(90000, (Number(store.settings.interval) || 15) * 3000);
}

/* ---- sessions --------------------------------------------------------------
   The chip is driven by the local calendar, on a one-second clock, because a
   countdown that only moves when a quote arrives is not a countdown. The
   provider's own view of the session is a corroborator: the facade polls it in
   the background and reports the disagreement, and this renders that report
   rather than picking a winner. */
function sessionFor(symbol) {
  return sessionAt(Date.now(), marketForSymbol(symbol, state.quotes[symbol]));
}

function watchedMarkets() {
  const set = new Set();
  for (const sym of watchedSymbols()) set.add(safe(() => marketForSymbol(sym, state.quotes[sym]), 'US_EQUITY') || 'US_EQUITY');
  return set;
}

// How permissive a session is, for choosing between the markets in one batch. An
// approximate session outranks a confirmed closed one because the scheduler will
// not grant it the shut floor either: a calendar that admits it is guessing has
// not earned five minutes of blindness.
function permissiveness(s) {
  if (!s) return -1;
  return s.isOpen ? 3 : s.isTradeable ? 2 : s.approx ? 1 : 0;
}

/* One tick fetches every watched symbol in one batch, so the batch's cadence is
   governed by whichever of its markets is most awake. Deriving it from the US
   equity calendar alone throttled a crypto or FX watchlist to the shut-market
   floor every night and all weekend — five minutes of alert latency on a market
   session.js itself reports as open. */
function governingSession(now = Date.now()) {
  let best = null;
  for (const mkt of watchedMarkets()) {
    const s = safe(() => sessionAt(now, mkt));
    if (permissiveness(s) > permissiveness(best)) best = s;
  }
  return best || sessionAt(now, 'US_EQUITY');
}

// The chip speaks for whatever is on screen. US equities win when they are in the
// watchlist at all — it is the calendar most users mean — but a crypto-only board
// must not be told the market is closed while its prices are moving.
function chipMarket() {
  const mkts = watchedMarkets();
  if (!mkts.size || mkts.has('US_EQUITY')) return 'US_EQUITY';
  return mkts.has('CRYPTO') ? 'CRYPTO' : [...mkts][0];
}

const STATUS_POLL_MS = 5000;
let statusReport = null, statusAt = 0, statusBusy = false;

// market.marketStatus() answers locally and never blocks on the network; the
// provider round-trip it may start lands on a later poll.
function pollStatus(force) {
  if (statusBusy || (!force && Date.now() - statusAt < STATUS_POLL_MS)) return;
  statusBusy = true;
  market.marketStatus()
    .then((r) => { statusReport = r || null; })
    .catch(() => { statusReport = null; })
    .then(() => { statusAt = Date.now(); statusBusy = false; renderSession(); });
}

function renderSession() {
  const now = Date.now();
  const mkt = chipMarket();
  const s = sessionAt(now, mkt);
  const chip = $('sessChip');
  const count = s.nextChange ? formatCountdown(s.nextChange - now) : '';

  pollStatus();
  // The provider's status endpoint answers for the equity market; hanging its
  // verdict off a crypto chip would be corroboration of the wrong thing.
  const rep = mkt === 'US_EQUITY' ? statusReport : null;
  const conflict = !!(rep && rep.conflict);

  chip.dataset.state = s.state;
  chip.classList.toggle('approx', !!s.approx);
  chip.classList.toggle('conflict', conflict);
  $('sessChipTxt').textContent = s.label + (count ? ' · ' + count : '') + (s.approx ? ' ≈' : '');
  chip.title = [
    ((MARKETS[mkt] && MARKETS[mkt].label) || mkt) + ' · ' + s.tz,
    s.nextLabel || '',
    s.detail || '',
    s.approx ? 'The holiday table is authoritative through ' + HOLIDAY_HORIZON + '; this date is rule-derived and unconfirmed.' : '',
    conflict ? rep.disagreement : '',
    rep && rep.agrees === true ? 'Your provider agreed at ' + fmtTime(rep.checkedAt || now) + '.' : '',
    'Click to re-check with your provider.',
  ].filter(Boolean).join('\n');

  $('sessNext').textContent = s.nextLabel || '';
  $('sessDetail').textContent = s.detail || '';
  $('sessApprox').hidden = !s.approx;
  const cf = $('sessConflict');
  cf.hidden = !conflict;
  if (conflict) cf.textContent = rep.disagreement;
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
    priceRow.append(el('span', 'card-price amount', q ? fmtPrice(q.price, q.currency) : '—'));
    priceRow.append(deltaChip(q));

    const tags = el('div', 'card-tags');
    tags.dataset.sym = sym;
    fillTags(tags, sym);

    const spark = el('div', 'card-spark');
    spark.innerHTML = sparkline(store.series[sym]?.points || []);

    const range = el('div', 'card-range');
    range.appendChild(rangeBar(q));

    const foot = el('div', 'card-foot');
    foot.append(el('span', 'card-src', q ? q.source : '—'));
    foot.append(el('span', 'card-ts', q ? 'as of ' + fmtTime(q.ts) : ''));

    card.append(head, priceRow, tags, spark, range, foot);
    grid.appendChild(card);
  }
}

// Baseline, session and staleness for one symbol. Rebuilt in place by the clock
// so a dead feed's age keeps climbing instead of freezing at whatever the last
// frame said.
function fillTags(box, sym) {
  const q = state.quotes[sym];
  const mkt = marketForSymbol(sym, q);
  const s = sessionAt(Date.now(), mkt);
  const stale = s.isTradeable ? frozenMs(sym) : 0;
  const parts = [];

  // 'unknown' is a real answer, not a missing one: an FX spot rate has no
  // reference close, and printing "vs prev close" over it would invent the
  // comparison the provider just said it could not make.
  if (q) {
    if (q.baseline === 'rolling_24h' || q.baseline === 'prev_close') {
      parts.push(['basis', q.baseline === 'rolling_24h' ? 'vs 24h' : 'vs prev close',
        q.baselineNote || 'Baseline reported by the data provider.']);
    } else if (mkt === 'CRYPTO') {
      parts.push(['basis', 'vs 24h', q.baselineNote || 'Baseline inferred from asset class — the provider did not state one.']);
    } else {
      parts.push(['basis unstated', 'no baseline',
        q.baselineNote || 'The provider did not say what this change is measured against.']);
    }
  }

  if (mkt === 'CRYPTO') parts.push(['always', '24/7', 'Crypto trades continuously; it is never closed.']);
  else if (s.state !== 'open') parts.push(['closed', s.label, [s.detail, s.nextLabel].filter(Boolean).join(' · ')]);

  if (stale > staleThreshold()) parts.push(['stale', 'Stale ' + formatCountdown(stale), 'This quote’s own timestamp has not advanced while the market is tradeable.']);

  const sig = parts.map((p) => p[0] + p[1]).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  for (const [kind, text, tip] of parts) {
    const t = el('span', 'tag ' + kind, text);
    if (tip) t.title = tip;
    box.appendChild(t);
  }
}

function refreshTags() {
  for (const box of document.querySelectorAll('.card-tags[data-sym]')) fillTags(box, box.dataset.sym);
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
    row.append(el('span', 'rr-price amount', q ? fmtPrice(q.price, q.currency) : '—'));
    row.appendChild(deltaChip(q));
    row.addEventListener('click', () => openDrawer(sym));
    list.appendChild(row);
  }
}

/* ---- market strip --------------------------------------------------------- */
function renderMarketStrip() {
  const strip = $('marketStrip');
  strip.hidden = !store.settings.showMarket;
  if (!store.settings.showMarket) return;
  const tiles = $('mktTiles');
  tiles.textContent = '';
  for (const [sym, label] of [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow 30']]) {
    const q = state.quotes[sym];
    const tile = el('div', 'stat-tile');
    tile.append(el('div', 'st-label', label));
    tile.append(el('div', 'st-value amount', q ? fmtPrice(q.price, q.currency) : '—'));
    tile.appendChild(deltaChip(q));
    tiles.appendChild(tile);
  }
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

  const sess = sessionFor(sym);
  const line = el('div', 'drawer-session');
  const chip = el('span', 'tag ' + (sess.isTradeable ? 'live' : 'closed'), sess.label);
  line.appendChild(chip);
  const bits = [sess.detail, sess.nextLabel].filter(Boolean).join(' · ');
  if (bits) line.append(el('span', 'ds-note', bits));
  if (sess.approx) line.append(el('span', 'tag approx', 'approx'));
  const froz = sess.isTradeable ? frozenMs(sym) : 0;
  if (froz > staleThreshold()) line.append(el('span', 'tag stale', 'Stale ' + formatCountdown(froz)));
  body.appendChild(line);

  const kv = el('div', 'kv-grid');
  const pair = (k, v, tip) => {
    kv.append(el('div', 'kv-k', k));
    const d = el('div', 'kv-v amount', v);
    if (tip) d.title = tip;
    kv.append(d);
  };
  pair('Last', q ? fmtPrice(q.price, q.currency) : '—');
  pair('Change', q && q.changePct != null ? `${fmtNum(q.change)} (${fmtNum(q.changePct)}%)` : '—');
  // The three-value vocabulary is too coarse for "an IEX close" versus "the
  // official one", so the provider's own sentence is the tooltip when it has one.
  pair('Baseline', baselineText(sym, q), q && q.baselineNote ? q.baselineNote : null);
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

  // Name the provider the router actually picked for candles — it is often not
  // the one serving quotes (Finnhub has no free candles, for one).
  const seriesId = safe(() => market.routeSeries(sym), 'demo');
  const note = el('p', 'field-note', 'Series via ' + (PROVIDER_LABELS[seriesId] || seriesId) + '. Delayed · not advice.');
  body.appendChild(note);

  const pts = await market.series(sym, drawerRange).catch(() => []);
  drawLineChart(canvas, pts);
}

function baselineText(sym, q) {
  if (!q) return '—';
  if (q.baseline === 'rolling_24h') return 'Rolling 24h (provider)';
  if (q.baseline === 'prev_close') return 'Previous close (provider)';
  if (marketForSymbol(sym, q) === 'CRYPTO') return 'Rolling 24h (inferred)';
  return 'Not stated by provider';
}

/* ---- portfolio ------------------------------------------------------------ */

// Totals are a plain sum with no FX conversion in it, so they may only carry a
// currency symbol when every holding is quoted in the same one. Mixed holdings
// get bare numbers and a line saying why, which is the honest shape of a figure
// that adds dollars to rupees.
function portfolioCurrency() {
  const set = new Set();
  for (const h of store.holdings) {
    const c = state.quotes[h.symbol] && state.quotes[h.symbol].currency;
    if (c) set.add(c);
  }
  if (set.size > 1) return false;
  return set.size === 1 ? [...set][0] : null;
}

function renderPortfolio() {
  const { rows, value, cost, dayPL, totalPL, totalPLPct } = portfolioTotals(store.holdings, state.quotes);
  const cur = portfolioCurrency();
  const money = (v) => (v == null ? '—' : cur === false ? fmtNum(v) : fmtPrice(v, cur));
  const signedMoney = (v) => (v == null ? '—' : (v >= 0 ? '+' : '−') + money(Math.abs(v)));
  const curNote = $('portCurNote');
  curNote.hidden = cur !== false;
  if (cur === false) {
    curNote.textContent = 'Your holdings are quoted in more than one currency. These totals are a plain sum with no '
      + 'conversion applied, so they are shown without a currency symbol.';
  }
  const stats = $('portStats');
  stats.textContent = '';
  const tile = (label, val, delta) => {
    const t = el('div', 'stat-tile');
    t.append(el('div', 'st-label', label));
    t.append(el('div', 'st-value amount', val));
    if (delta) t.appendChild(delta);
    return t;
  };
  stats.append(tile('Total value', money(value)));
  stats.append(tile('Day P/L', signedMoney(dayPL), plChip(dayPL, null)));
  stats.append(tile('Total P/L', signedMoney(totalPL), plChip(totalPL, totalPLPct)));
  stats.append(tile('Cost basis', money(cost)));

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
      money(r.marketValue),
      signedMoney(r.dayPL),
      signedMoney(r.totalPL),
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
    if (!scheduler) return;
    const p = !scheduler.isPaused(); scheduler.setPaused(p);
    $('btnPause').textContent = p ? '▶' : '⏸';
    $('btnPause').classList.toggle('active', p);
    publishFrame();
  });
  $('intervalSel').addEventListener('change', (e) => {
    store.settings.interval = +e.target.value; store.saveSettings(); publishState();
  });
  $('intervalSel').value = String(store.settings.interval);
  $('btnAdd').addEventListener('click', () => openModal('addModal', () => { $('addSearch').value = ''; $('addAuto').textContent = ''; $('addSearch').focus(); }));
  $('viewWatch').addEventListener('click', () => setView('watch'));
  $('viewPort').addEventListener('click', () => setView('port'));
  $('btnPrivacy').addEventListener('click', () => { setPrivacy(!store.settings.privacy); publishState(); });
  $('btnAlerts').addEventListener('click', () => openAlerts(store.watchlist[0] || ''));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnDisplays').addEventListener('click', () => openSettings('displaysSection'));
  $('sessChip').addEventListener('click', () => {
    safe(() => market.refreshMarketStatus());
    pollStatus(true);
    toast('Re-checking the session with your data provider.');
  });
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

/* ---- shared-link banner ----------------------------------------------------
   A #AAPL,MSFT link seeds an ephemeral watchlist that is never written to disk.
   The banner exists so that state is visible: nothing about it is obvious from a
   watchlist that simply looks populated. */
function wireHashBanner() {
  const banner = $('hashBanner');
  banner.hidden = !store.hashActive;
  if (!store.hashActive) return;

  $('hashAdopt').addEventListener('click', () => {
    if (typeof store.adoptHash === 'function') store.adoptHash();
    else {
      // A cached older store.js has neither helper; do the same two things here.
      store.saveWatchlist(); store.hashActive = false;
      safe(() => history.replaceState(null, '', location.pathname + location.search));
    }
    banner.hidden = true;
    refreshAll();
    toast('Shared watchlist saved to this browser.');
  });

  $('hashDiscard').addEventListener('click', () => {
    if (typeof store.exitHash === 'function') {
      store.exitHash();
      banner.hidden = true;
      refreshAll();
      toast('Shared view discarded — your saved watchlist is back.');
    } else {
      location.hash = '';
      location.reload();
    }
  });
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
  $('ruleSym').addEventListener('change', updateRuleSessionNote);
  $('logFilter').addEventListener('change', (e) => { state.logFilter = e.target.value; renderAlertLog(); });
  $('btnLogCsv').addEventListener('click', exportAlertLog);

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
function updateProviderConfig() {
  const sel = $('setProvider').value;
  for (const box of document.querySelectorAll('.provider-config')) box.hidden = box.dataset.provider !== sel;
  const universal = $('setUniversal').checked;
  $('providerModeNote').textContent = universal
    ? `Every symbol uses ${PROVIDER_LABELS[sel] || sel}.`
    : 'Auto-route: equities use the selected stock provider, crypto uses CoinGecko (keyless), FX uses Twelve Data. Symbols are grouped so each provider gets one batched call — add keys for whichever providers you use.';
}
function openSettings(scrollTo) {
  openModal('settingsModal', () => {
    applySettingsToUI();
    $('keyStatus').textContent = '';
    renderDisplays();
    reportStorage();
    if (scrollTo) safe(() => $(scrollTo).scrollIntoView({ block: 'start' }));
  });
}
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
  publishState();
  safe(() => market.refreshMarketStatus());   // a new provider owes us its own answer
  pollStatus(true);
  renderQuota();
  reportStorage();

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

// The export carries the alert log (the store puts it there); keys never travel.
function doExport() {
  downloadFile('carino-stocks-' + Math.floor(Date.now() / 1000) + '.json', 'application/json', store.exportState());
}
function doImport(e) {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const r = store.importState(rd.result);
      applySettingsToUI(); refreshAll();
      const dropped = r && r.dropped ? Object.values(r.dropped).reduce((a, b) => a + b, 0) : 0;
      toast(r
        ? `Imported ${r.watchlist} symbols, ${r.rules} rules, ${r.holdings} holdings.` + (dropped ? ` ${dropped} unreadable entries were skipped.` : '')
        : 'Imported.');
    } catch (err) { toast('Import failed: ' + err.message, 'err'); }
  };
  rd.readAsText(f); e.target.value = '';
}
function downloadFile(name, mime, text) {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---- storage --------------------------------------------------------------- */
function reportStorage() {
  const info = safe(() => store.storageInfo && store.storageInfo());
  const note = $('storageNote');
  if (!info) { note.textContent = ''; return; }
  const size = fmtBytes(info.bytes);
  note.classList.toggle('warn-note', !!info.quotaHit);
  note.textContent = info.quotaHit
    ? 'A save to this browser failed — storage is full (' + size + ' in use). Export your data, then clear cached charts with "Clear all data" or free space in your browser settings. Until then, new holdings, rules and settings may not survive a reload.'
    : 'Using ' + size + ' of this browser’s storage.';
  if (info.quotaHit && !reportStorage.warned) { reportStorage.warned = true; toast('Browser storage is full — recent changes may not be saved.', 'err'); }
}

/* ---- API budget widget ------------------------------------------------------
   Free tiers are the real constraint on this app, so the widget shows the last
   minute against the provider's published per-minute ceiling rather than an
   abstract "credits" number nobody can act on. */
let quotaDirty = false, quotaTimer = null;

function renderQuota() {
  const box = $('quotaBox');
  const stats = budget && typeof budget.stats === 'function' ? safe(() => budget.stats()) : null;
  if (!stats) { box.hidden = true; return; }
  box.hidden = false;

  const by = stats.byProvider && typeof stats.byProvider === 'object' ? stats.byProvider : {};
  const perMin = (v) => (typeof v === 'number' ? v : Number(v && (v.lastMin ?? v.min ?? v.minute)) || 0);
  const perHour = (v) => (typeof v === 'number' ? 0 : Number(v && (v.lastHour ?? v.hour)) || 0);

  let worst = null;
  for (const [id, v] of Object.entries(by)) {
    const cap = RATE_CEILING[id];
    const used = perMin(v);
    const util = cap ? used / cap : -1;
    if (!worst || util > worst.util) worst = { id, used, cap, util, hour: perHour(v) };
  }

  const totalMin = Number(stats.lastMin) || 0;
  const totalHour = Number(stats.lastHour) || 0;
  const bar = $('quotaBar');

  if (!worst && !totalMin && !totalHour) {
    bar.style.width = '0%';
    bar.classList.remove('hot');
    $('quotaTxt').textContent = market.modeLabel().live ? 'No calls yet.' : 'Demo mode — no API calls.';
    $('quotaSub').textContent = '';
    return;
  }

  const pct = worst && worst.cap ? Math.min(100, (worst.used / worst.cap) * 100) : 0;
  bar.style.width = pct.toFixed(0) + '%';
  bar.classList.toggle('hot', pct >= 80);

  $('quotaTxt').textContent = worst && worst.cap
    ? `${PROVIDER_LABELS[worst.id] || worst.id} ${worst.used}/${worst.cap} per min`
    : `${totalMin} calls in the last minute`;
  const others = Object.keys(by).length;
  $('quotaSub').textContent = totalHour
    ? `${totalHour} in the last hour${others > 1 ? ' · ' + others + ' providers' : ''}`
    : '';
  box.title = Object.entries(by)
    .map(([id, v]) => `${PROVIDER_LABELS[id] || id}: ${perMin(v)}/min${RATE_CEILING[id] ? ' of ' + RATE_CEILING[id] : ''}`)
    .join('\n') || 'No provider calls recorded.';
}

function wireQuota() {
  if (!budget || typeof budget.on !== 'function') return;
  // Every recorded call would repaint; coalesce to at most one repaint a second.
  safe(() => budget.on(() => {
    quotaDirty = true;
    if (quotaTimer) return;
    quotaTimer = setTimeout(() => { quotaTimer = null; if (quotaDirty) { quotaDirty = false; renderQuota(); } }, 1000);
  }));
}

/* ---- detached displays ------------------------------------------------------
   Reports what THIS machine can actually do, then tells the truth about what
   happened. Placement is advisory on Wayland, so a window that landed somewhere
   else says so instead of the UI pretending the monitor choice took effect. */
function wireDisplays() {
  const panelSel = $('dispPanel');
  for (const p of PANELS) { const o = el('option', null, p.label); o.value = p.id; panelSel.appendChild(o); }
  panelSel.addEventListener('change', renderPanelDesc);
  renderPanelDesc();

  fillScreenPicker(safe(() => displays.screens(), []) || []);

  $('dispDetect').addEventListener('click', async () => {
    const list = await displays.detectScreens().catch(() => []);
    fillScreenPicker(list || []);
    renderDisplays();
    if (!list || list.length < 2) toast('One monitor detected — panels will open on this screen.');
  });

  $('dispOpen').addEventListener('click', () => {
    // No await before this call: window.open must run inside the user gesture.
    const res = displays.open($('dispPanel').value, {
      mode: $('dispMode').value,
      screenId: $('dispScreen').value || null,
    });
    Promise.resolve(res).then((r) => {
      if (!r) return;
      if (r.reason === 'popup-blocked') toast('Popup blocked — allow popups for this site, then try again.', 'err');
      else if (r.reason === 'unknown-panel') toast('That panel does not exist.', 'err');
      renderDisplays();
    }).catch(() => {});
  });

  $('dispReplace').addEventListener('click', () => { displays.rePlaceAll(); renderDisplays(); });
  $('dispCloseAll').addEventListener('click', () => { displays.closeAll(); renderDisplays(); });

  safe(() => displays.onChange(renderDisplays));
}

function renderPanelDesc() {
  const p = PANELS.find((x) => x.id === $('dispPanel').value);
  $('dispPanelDesc').textContent = p ? p.desc : '';
}

function fillScreenPicker(list) {
  state.screens = Array.isArray(list) ? list : [];
  const sel = $('dispScreen');
  const prev = sel.value;
  sel.textContent = '';
  const none = el('option', null, state.screens.length ? 'Wherever the browser puts it' : 'This monitor');
  none.value = '';
  sel.appendChild(none);
  for (const s of state.screens) {
    const o = el('option', null, s.label || s.id);
    o.value = s.id;
    sel.appendChild(o);
  }
  if (prev && state.screens.some((s) => s.id === prev)) sel.value = prev;
}

function screenLabel(id) {
  if (!id) return 'default position';
  const s = state.screens.find((x) => x.id === id);
  return s ? (s.label || s.id) : id;
}

function renderDisplays() {
  const sup = displays.support();
  const caps = $('dispCaps');
  caps.textContent = '';

  const rows = [
    ['Multi-monitor placement', sup.windowMgmt
      ? (sup.permission === 'granted' ? ['ok', 'Allowed. Panels can be aimed at a specific monitor.']
        : sup.permission === 'denied' ? ['off', 'Blocked. The monitor permission was refused, so panels open on this screen.']
          : ['warn', 'Available. Your browser will ask permission the first time you detect monitors.'])
      : ['off', 'Not supported by this browser. Panels open here and can be dragged.']],
    ['Picture-in-Picture', sup.pip
      ? ['ok', 'Supported. A small always-on-top tile that stays visible over other apps.']
      : ['off', 'Not supported by this browser. Panels will open as ordinary windows.']],
    ['Popup windows', ['warn', 'Always attempted. A popup blocker can still refuse one — if nothing opens, allow popups for this site.']],
  ];
  for (const [k, [tone, text]] of rows) {
    const row = el('div', 'cap-row');
    row.append(el('span', 'cap-dot ' + tone));
    row.append(el('span', 'cap-k', k));
    row.append(el('span', 'cap-v', text));
    caps.appendChild(row);
  }

  const open = safe(() => displays.openPanels(), []) || [];
  const orphans = safe(() => displays.orphanPanels(), []) || [];
  const list = $('dispOpenList');
  list.textContent = '';
  if (!open.length && !orphans.length) {
    list.appendChild(el('p', 'field-note', 'No panels open.'));
  } else {
    for (const p of open) {
      const panel = PANELS.find((x) => x.id === p.panelId);
      const row = el('div', 'disp-row');
      row.append(el('span', 'dr-name', panel ? panel.label : p.panelId));
      row.append(el('span', 'tag ' + (p.alive ? 'live' : 'closed'), p.mode === 'pip' ? 'Picture-in-Picture' : 'Window'));
      row.append(el('span', 'dr-where', p.mode === 'pip' ? 'browser-placed' : screenLabel(p.screenId)));
      if (p.placed === false) row.append(el('span', 'tag stale', 'placement ignored'));
      const x = el('button', 'cs-btn', 'Close');
      x.addEventListener('click', () => { displays.close(p.panelId); renderDisplays(); });
      row.append(el('span', 'spacer'), x);
      list.appendChild(row);
    }
    // A popout deliberately outlives its opener, but the handle that controlled it
    // does not. These are the panels storage says are still on screen somewhere
    // with nothing in this window able to reach them; re-opening from a click
    // re-adopts the existing window through its shared name, so nothing is
    // duplicated and the user gets the controls back.
    for (const p of orphans) {
      const panel = PANELS.find((x) => x.id === p.panelId);
      const row = el('div', 'disp-row');
      row.append(el('span', 'dr-name', panel ? panel.label : p.panelId));
      row.append(el('span', 'tag closed', 'Detached'));
      row.append(el('span', 'dr-where', 'opened before this page loaded'));
      const re = el('button', 'cs-btn', 'Re-open');
      re.title = 'Reconnect to the panel window if it is still open, or open it again if it is not.';
      re.addEventListener('click', () => {
        Promise.resolve(safe(() => displays.open(p.panelId, { mode: p.mode, screenId: p.screenId })))
          .then(() => renderDisplays()).catch(() => {});
      });
      const forget = el('button', 'cs-btn', 'Forget');
      forget.title = 'Stop listing this panel. Any window still open must be closed from its own controls.';
      forget.addEventListener('click', () => { displays.close(p.panelId); renderDisplays(); });
      row.append(el('span', 'spacer'), re, forget);
      list.appendChild(row);
    }
  }

  const ignored = open.some((p) => p.placed === false);
  const note = $('dispPlaceNote');
  note.hidden = !ignored;
  if (ignored) {
    note.textContent = 'Your desktop ignored the placement request — Wayland and most tiling window managers do not let a '
      + 'web page position windows. Nothing is broken: drag the panel onto the monitor you want and it will stay there.';
  }
}

/* ---- alerts modal --------------------------------------------------------- */
function openAlerts(sym) {
  openModal('alertsModal', () => {
    const sel = $('ruleSym'); sel.textContent = '';
    const syms = [...new Set([...store.watchlist, ...store.rules.map((r) => r.symbol)])].filter(Boolean);
    for (const s of syms) { const o = el('option', null, s); o.value = s; sel.appendChild(o); }
    if (sym) sel.value = sym;
    $('ruleSess').value = 'regular';
    updateRuleSessionNote();
    renderRuleList(); renderAlertLog();
  });
}

// A scope the routed provider cannot observe is a rule that can never fire, so
// the option is withdrawn and the reason stated rather than silently offered.
function updateRuleSessionNote() {
  const sym = $('ruleSym').value;
  const sel = $('ruleSess');
  const note = $('ruleSessNote');
  const extOpt = sel.querySelector('option[value="extended"]');
  if (!sym) { note.textContent = 'Add a symbol to the watchlist first.'; return; }

  const mkt = marketForSymbol(sym, state.quotes[sym]);
  if (mkt !== 'US_EQUITY') {
    extOpt.disabled = true;
    if (sel.value === 'extended') sel.value = 'any';
    note.textContent = mkt === 'CRYPTO'
      ? `${sym} trades continuously — there is no pre- or post-market session to scope to.`
      : `${sym} is an FX pair — one continuous session from Sunday 17:00 to Friday 17:00 ET, so extended hours do not apply.`;
    return;
  }

  const pid = safe(() => market.routeQuote(sym), 'demo') || 'demo';
  const ext = EXT_HOURS[pid];
  const label = PROVIDER_LABELS[pid] || pid;
  extOpt.disabled = ext === false;
  if (ext === false && sel.value === 'extended') sel.value = 'regular';
  note.textContent = ext === false
    ? `${label} reports regular-session prices only, so an extended-hours rule on ${sym} could never fire. Change provider to scope one.`
    : ext === null
      ? `${label} does not document whether its free quote endpoint includes pre- and post-market trades, so an extended-hours rule may never fire.`
      : `${label} reports extended-hours trades for ${sym}. Rules are still only checked while a tab is open.`;
}

function addRuleFromForm() {
  const symbol = $('ruleSym').value; const value = parseFloat($('ruleVal').value);
  if (!symbol || !Number.isFinite(value)) { toast('Enter a valid threshold.', 'err'); return; }
  const scope = SESSION_SCOPES[$('ruleSess').value] ? $('ruleSess').value : 'regular';
  store.addRule({
    id: 'r' + Date.now() + Math.floor(Math.random() * 1e4),
    symbol, type: $('ruleType').value, op: $('ruleOp').value, value, armed: true,
    sessions: SESSION_SCOPES[scope].slice(),
  });
  $('ruleVal').value = '';
  renderRuleList(); renderCards();
}

// Legacy rules carry no `sessions`, and they were written when every session
// counted — reporting them as 'Any session' keeps that promise visible.
function scopeOf(rule) {
  const s = rule && rule.sessions;
  if (!Array.isArray(s) || !s.length) return 'any';
  return s.length === 1 && s[0] === 'open' ? 'regular' : 'extended';
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
    const scope = scopeOf(r);
    const chip = el('span', 'tag scope ' + scope, SCOPE_LABEL[scope]);
    chip.title = scope === 'regular' ? 'Only while regular hours are open.'
      : scope === 'extended' ? 'Pre-market, regular hours and after hours.'
        : 'Every session, including while the market is closed.';
    row.appendChild(chip);
    const del = el('button', 'icon-mini', '✕'); del.addEventListener('click', () => { store.removeRule(r.id); renderRuleList(); renderCards(); });
    row.appendChild(del);
    list.appendChild(row);
  }
}

/* The log records what was true when a rule fired: session, price and change at
   that instant. It deliberately does NOT record what the price did afterwards —
   a "you should have acted" column would turn a monitoring tool into a scorecard
   for decisions this app does not make. */
function renderAlertLog() {
  const log = $('alertLog'); log.textContent = '';
  const all = Array.isArray(store.alertlog) ? store.alertlog : [];

  const filter = $('logFilter');
  const syms = [...new Set(all.map((a) => a.symbol).filter(Boolean))].sort();
  const prev = state.logFilter;
  filter.textContent = '';
  const opt = el('option', null, 'All symbols'); opt.value = ''; filter.appendChild(opt);
  for (const s of syms) { const o = el('option', null, s); o.value = s; filter.appendChild(o); }
  filter.value = syms.includes(prev) ? prev : '';
  state.logFilter = filter.value;

  const rows = all.filter((a) => !state.logFilter || a.symbol === state.logFilter).slice(-12).reverse();
  if (!rows.length) {
    log.appendChild(el('p', 'field-note', all.length ? 'Nothing logged for that symbol.' : 'Nothing has triggered yet.'));
    return;
  }
  for (const a of rows) {
    const r = el('div', 'log-row');
    r.append(el('span', 'log-time', fmtTime(a.ts)));
    if (a.sessionLabel || a.session) {
      const st = el('span', 'tag sess' + (a.approx ? ' approx' : ''), a.sessionLabel || a.session);
      st.title = a.approx
        ? 'Market session when the rule fired — the calendar could not confirm this date.'
        : 'Market session when the rule fired.';
      r.append(st);
    }
    r.append(el('span', 'log-text', a.text));
    if (a.quote && a.quote.price != null) {
      const snap = el('span', 'log-snap amount', fmtPrice(a.quote.price, a.quote.currency)
        + (a.quote.changePct != null ? ' (' + fmtNum(a.quote.changePct) + '%)' : ''));
      snap.title = 'Quote at the moment the rule fired' + (a.quote.source ? ' · ' + a.quote.source : '');
      r.append(snap);
    }
    log.appendChild(r);
  }
}

function exportAlertLog() {
  const rows = [['time', 'symbol', 'session', 'session_approx', 'scope', 'text', 'price', 'currency', 'change', 'change_pct', 'source']];
  for (const a of store.alertlog) {
    const q = a.quote || {};
    rows.push([new Date(a.ts).toISOString(), a.symbol || '', a.sessionLabel || a.session || '', a.approx ? 'yes' : '',
      a.scope || '', a.text || '', q.price ?? '', q.currency || '', q.change ?? '', q.changePct ?? '', q.source || '']);
  }
  downloadFile('carino-stocks-alerts-' + Math.floor(Date.now() / 1000) + '.csv', 'text/csv', rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
}
function csvCell(v) {
  let s = String(v == null ? '' : v);
  // Spreadsheets execute a leading =, +, - or @; only a plain number is safe as-is.
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = '\'' + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
function fireAlert(rule, text, q, meta) {
  recordAlertContext(rule, text, q, meta);
  toast('🔔 ' + text, 'alert');
  peers.broadcast('alert', { ts: Date.now(), symbol: rule.symbol, text });
  if (store.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Carino Stocks — ' + rule.symbol, { body: text }); } catch (e) {}
  }
  if (store.settings.sound) beep();
  renderAlertLog();
}

// The alert pass writes the bare entry and hands it back; the firing quote and
// the rule's own scope are context only this side has, so they are attached to
// that same entry rather than logged twice.
function recordAlertContext(rule, text, q, meta) {
  const sess = safe(() => sessionFor(rule.symbol));
  const extra = {
    session: (meta && meta.session) || (sess && sess.state) || null,
    sessionLabel: (meta && meta.label) || (sess && sess.label) || null,
    approx: !!(meta ? meta.approx : sess && sess.approx),
    scope: scopeOf(rule),
    quote: q ? {
      price: q.price ?? null, change: q.change ?? null, changePct: q.changePct ?? null,
      // Without it the log would render a rupee price as dollars a month later,
      // when nothing is left to correct it from.
      currency: q.currency || null,
      ts: q.ts ?? null, source: q.source || null,
    } : null,
  };
  const log = store.alertlog;
  const last = log[log.length - 1];
  const target = (meta && meta.entry) || (last && last.symbol === rule.symbol && Math.abs(Date.now() - (last.ts || 0)) < 4000 ? last : null);
  if (target) Object.assign(target, extra);
  else log.push({ ts: Date.now(), symbol: rule.symbol, text, ...extra });
  safe(() => store.saveAlertlog());
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
  chip.textContent = m.text; chip.classList.toggle('live', m.live);
  chip.title = 'Data source' + (leaderless ? ' · refreshing independently: no window holds the shared lock' : '');
}
function refreshAll() {
  renderRail(); renderCards(); updateModeChip(); renderMarketStrip(); renderSession();
  if (state.view === 'port') renderPortfolio();
  publishState();
  scheduler && scheduler.now();
}

/* ---- formatters ----------------------------------------------------------- */
// The provider layer reports a real ISO code where it knows one and null where it
// does not, so the '$' is only for the currency that actually is dollars. A
// portfolio total mixes currencies and is therefore printed without a symbol at
// all rather than picking one of them to be wrong in.
function fmtPrice(v, currency) {
  if (v == null) return '—';
  const prefix = !currency || currency === 'USD' ? '$' : currency + ' ';
  return prefix + fmtNum(v);
}
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtInt(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('en-US', { hour12: false }); }
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' bytes';
}
function fmtCap(v) {
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  return '$' + fmtInt(v);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
