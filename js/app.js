/* app.js — Carino Stocks controller + chrome.
   Monitoring & visualization only: no trading, no brokerage, no advice.

   What used to be the view is now a workspace: #main holds tabs of widgets
   (workspace.js, widgets.js) and this file draws only the chrome around them —
   the header, the rail, the market strip, the drawer, the modals. The controller's
   remaining job at the boundary is to build ONE ctx object per tick out of the
   things only it knows (the feed, the freshness ledger, the session calendar, the
   store) and hand it over. Widgets never fetch and never write storage, so
   anything that does — removing a symbol, editing a holding, arming a rule — stays
   here, which is why the rail owns the ✕ and holdings are edited in a modal rather
   than in the widget that reports them.

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
import { mountChartPanel } from './chartpanel.js';
import { renderFundamentals, renderEvents, renderNewsList } from './widgets-market.js';
import { computePortfolio, fxPairsNeeded, positionsCSV } from './folio.js';
import { initLedgerUI } from './ledger-ui.js';
import { initAlertsUI, scopeOf } from './alerts-ui.js';
import { ALERT_TYPES } from './alerttypes.js';
import { helpIcon, configure as learnConfigure, openLessons, openGlossary, startTour, levelPicker, loadGlossary,
  LEVELS, LEVEL_ORDER, normalizeLevel, levelAllows } from './learn.js';
import { initPalette } from './palette.js';
import { WIDGETS } from './widgets.js';
import { createScheduler, evaluateAlerts, pollSeconds } from './engine.js';
import { sessionAt, marketForSymbol, formatCountdown, HOLIDAY_HORIZON, MARKETS } from './session.js';
import { peers } from './peers.js';
import { displays, PANELS } from './displays.js';
import { workspace } from './workspace.js';
// One copy of every number format, shared with the widgets and the popout. The
// old local copies inferred FX from app state; these take { fx } from the caller,
// which is why they can be shared at all.
import { fmtPrice, fmtMove, fmtNum, fmtInt, fmtTime } from './format.js';

const $ = (id) => document.getElementById(id);
// UI-string translation via the site dictionary (i18n.js); identity when absent.
const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
// A translated template: i18nF('Imported {n} symbols.', {n: 3}). The braces stay
// in the key, so a translation can put the number wherever its grammar wants it.
const i18nF = (s, vars) => i18nT(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
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

const state = {
  quotes: {}, selection: null, lastUpdated: 0, fetchError: null,
  // Symbols a fetch asked for and did not get back. Empty until the first tick,
  // never null, because a widget reads it on every frame.
  uncovered: new Set(),
  freshness: {},        // symbol -> { ts, changedAt, polls }: staleness is derived, never asserted
  misses: {},           // symbol -> consecutive successful polls that did not return it
  daily: {},            // symbol -> { at, bars, isDemo }: daily bars for levels, pivots and scans
  fund: {},             // symbol -> { at, f }: fundamentals already fetched this session
  logFilter: '',
  screens: [],
};
let scheduler = null;
let clockTimer = null;
let alertsUI = null, ledgerUI = null;

/* ---- boot ----------------------------------------------------------------- */
function boot() {
  store.initWatchlist();
  // A TTL sweep before the first render, so a page opened after a long gap is not
  // drawing from caches the store is about to drop anyway.
  safe(() => store.evictCaches && store.evictCaches());

  $('pageDisclaimer').textContent = i18nT(DISCLAIMER);
  $('railDisclaimer').textContent = i18nT('Data stays in your browser. Not investment advice.');
  $('ackText').textContent = i18nT(DISCLAIMER);
  $('sessApprox').textContent = i18nF('Holiday table ends {date} — later dates are rule-derived, not confirmed', { date: HOLIDAY_HORIZON });

  applySettingsToUI();
  wireControls();
  wireModals();
  wireLearn();
  wireLevel();
  wirePalette();
  wireDrawer();
  wireHashBanner();
  wireDisplays();
  renderRail();
  mountWorkspace();
  renderMarketStrip();
  updateModeChip();
  renderSession();
  wireQuota();
  renderQuota();
  wireLangSwitch();
  reportStorage();

  if (!store.settings.ack) $('ackGate').hidden = false;
  else noticeLevel();
  noticeMigration();

  startClock();
  startEngine();
}

/* The chrome's second hand. It also hands the widgets a fresh ctx every second,
   which is not the waste it first looks like: ctx.staleMs is the age of the whole
   frame, and it is computed here — so a board that only re-rendered on a
   successful poll could never show a non-zero one. Every path that stops polling
   (a pause, a failed fetch, a leader that went away) is exactly the path where
   the age matters most, and it was the one path where nothing was repainting.
   The cost is bounded because widgets patch rather than rebuild: each one
   compares before it writes, so a second with no news writes nothing. */
function startClock() {
  clearInterval(clockTimer);
  let n = 0;
  clockTimer = setInterval(() => {
    renderSession();
    refreshWidgets();
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
      toast(i18nT('No window holds the shared refresh lock — this tab is refreshing on its own.'), 'err');
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
  // Let the visible windows drive this one's cadence when its own timers are
  // clamped for being in the background. wake() honours the governor, so this
  // can only ever recover a missed tick, never add one.
  peers.onWake(() => scheduler && scheduler.wake());
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
    // Without this a panel cannot tell "the provider does not cover this symbol"
    // from "not fetched yet", so it prints an em dash where this window prints
    // 'Not covered' — the same quote, described two different ways on two screens.
    uncovered: [...state.uncovered],
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
    settings: { privacy: !!store.settings.privacy, baseCurrency: store.settings.baseCurrency, costMethod: store.settings.costMethod, level: store.settings.level },
  });
}

/* ---- refresh tick --------------------------------------------------------- */

// Everything one tick fetches, in one place, because the cadence is decided from
// the same set: a batch is only as closed as its most-open market.
function watchedSymbols({ forCadence = false } = {}) {
  // Open positions, not every symbol the ledger ever mentioned: a position sold
  // years ago does not need a quote on every poll.
  const pf = folio();
  const portSyms = pf ? pf.positions.map((p) => p.symbol) : [];
  // Armed rules on symbols that are in neither list would otherwise never be
  // evaluated: the rule would sit there looking live and never fire. The
  // portfolio pseudo-symbol is not a ticker and is never fetched.
  const ruleSyms = store.rules.filter((r) => r.armed).map((r) => r.symbol).filter((x) => x && x[0] !== '@');
  const idx = store.settings.showMarket ? stripSymbols() : [];
  // A widget pinned to a symbol outside the watchlist used to show a dash
  // forever: nothing ever asked for its quote. So does the open drawer.
  const pinned = safe(() => workspace.pinnedSymbols(), []) || [];
  const extra = [state.selection, drawerSym].filter(Boolean);
  // The FX legs the base-currency totals need. They are valuation inputs, not
  // things the user is watching, so they do not get to set the poll cadence: an
  // equity-only portfolio in pesos must not be polled all night because USDMXN
  // trades around the clock.
  const fx = forCadence ? [] : safe(() => fxPairsNeeded(store.ledger, state.quotes, store.settings.baseCurrency), []) || [];
  return [...new Set([...store.watchlist, ...portSyms, ...ruleSyms, ...idx, ...pinned, ...extra, ...fx])]
    .filter((x) => typeof x === 'string' && x);
}

async function tick() {
  // The scheduler already gates on leadership; this is the second belt, because a
  // duplicated fetch spends a real free-tier budget the user cannot get back.
  if (!shouldFetch()) { renderAll(); return; }

  const syms = store.watchlist.slice();
  const all = watchedSymbols();
  if (!all.length) { renderAll(); return; }

  let quotes;
  try {
    quotes = await market.quotes(all);
    if (state.fetchError) { state.fetchError = null; updateModeChip(); }
  } catch (e) {
    if (e && e.rateLimited) throw e;   // let the scheduler back off on HTTP 429
    // Say which failure it was: a rejected key and a dropped connection need
    // different fixes, and "check your key or connection" sends people to both.
    const kind = e && (e.kind || (e.authError ? 'authError' : e.network ? 'network' : e.timeout ? 'timeout' : e.premium ? 'premium' : null));
    state.fetchError = i18nT(kind === 'authError' ? 'Your data provider rejected the API key. Check it in Settings.'
      : kind === 'network' ? 'The data provider could not be reached. Check your connection.'
        : kind === 'timeout' ? 'The data provider did not answer in time.'
          : kind === 'premium' ? 'That data needs a paid plan with your provider.'
            : 'Quote fetch failed — check your API key or connection.');
    updateModeChip();
    // Repaint on the way out. state.lastUpdated is untouched, so this is the tick
    // that starts the frame visibly ageing; returning without it left the board
    // looking as live as it did a second ago.
    renderAll();
    return;
  }
  noteFreshness(quotes);
  // A symbol the fetch asked for and did not get back is not "loading" — the
  // routed provider does not cover it. Without this the card sits on an em dash
  // forever and reads as a stuck feed rather than an answer. A symbol that WAS
  // covered and stops coming back is uncovered too, but only after two misses in
  // a row: one gap in a batch is an outage, two is an answer.
  for (const s of all) state.misses[s] = quotes[s] ? 0 : (state.misses[s] || 0) + 1;
  state.uncovered = new Set(all.filter((s) => !quotes[s] && (!state.quotes[s] || state.misses[s] >= 2)));
  state.quotes = { ...state.quotes, ...quotes };
  state.lastUpdated = Date.now();

  // sparkline series: the facade's TTL decides cache vs refetch (conserves budget).
  await Promise.all(syms.map((s) => market.series(s).catch(() => {})));
  prefetchProfiles(syms);

  // Technical and range rules read cached daily bars and fundamentals; both are
  // answered synchronously from what is already here, and fetched in the
  // background (paced) for the armed rules that need them.
  ensureRuleData();
  evaluateAlerts(state.quotes, fireAlert, {
    sessionFor,
    barsFor: dailyFor,
    fundamentalsFor: (s) => (state.fund[s] ? state.fund[s].f : null),
    portfolio: safe(() => { const pf = folio(); return pf && !pf.empty ? pf.totals : null; }),
  });
  alertsUI && alertsUI.refreshPreview();

  publishFrame();
  renderAll();
  renderQuota();
}

/* Names and sectors for the board (cards, heatmap grouping). A profile is cached
   for a week, so this is a handful of calls once, not a cost per tick — and it
   is capped at three per tick so a fresh watchlist does not burst the budget. */
const profileTried = new Set();
function prefetchProfiles(syms) {
  let n = 0;
  for (const s of syms) {
    if (n >= 3) break;
    if (store.profiles[s] || profileTried.has(s)) continue;
    profileTried.add(s);
    n++;
    market.profile(s).then((p) => { if (p) refreshWidgets(); }).catch(() => {});
  }
}

// One frame, one repaint. workspace.update() hands the new ctx to each visible
// widget and lets it patch itself; it adds no timer of its own, so the whole board
// still moves at the poll cadence the scheduler decided.
function renderAll() {
  renderRail();
  refreshWidgets();
  renderMarketStrip();
  renderSession();
  refreshDrawer();
}

function refreshWidgets() { safe(() => workspace.update()); }

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
  for (const sym of watchedSymbols({ forCadence: true })) set.add(safe(() => marketForSymbol(sym, state.quotes[sym]), 'US_EQUITY') || 'US_EQUITY');
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
    i18nT((MARKETS[mkt] && MARKETS[mkt].label) || mkt) + ' · ' + s.tz,
    s.nextLabel || '',
    s.detail || '',
    s.approx ? i18nF('Holiday table ends {date} — later dates are rule-derived, not confirmed', { date: HOLIDAY_HORIZON }) : '',
    conflict ? rep.disagreement : '',
    rep && rep.agrees === true ? i18nT('Your provider agreed at') + ' ' + fmtTime(rep.checkedAt || now) + '.' : '',
    i18nT('Click to re-check with your provider.'),
  ].filter(Boolean).join('\n');

  $('sessNext').textContent = s.nextLabel || '';
  $('sessDetail').textContent = s.detail || '';
  $('sessApprox').hidden = !s.approx;
  const cf = $('sessConflict');
  cf.hidden = !conflict;
  if (conflict) cf.textContent = rep.disagreement;
}

/* ---- watchlist order ------------------------------------------------------
   One order, decided here, handed to every widget as ctx.symbols. Widgets do not
   sort: a board of eight widgets that each sorted for itself would show the same
   list in eight orders. The table's column sort is a view on top of this one, and
   its third click comes back to it. */
function sortedWatchlist() {
  const w = store.watchlist.slice();
  // getCtx() may be called before the chrome is wired, and a missing control must
  // cost the stored order, not the render.
  const sel = $('sortSel');
  const mode = sel ? sel.value : 'added';
  if (mode === 'alpha') w.sort((a, b) => a.localeCompare(b));
  else if (mode === 'change') w.sort((a, b) => (state.quotes[b]?.changePct ?? -1e9) - (state.quotes[a]?.changePct ?? -1e9));
  return w;
}

/* ---- workspace -------------------------------------------------------------
   #main holds the widget workspace and nothing else. The controller keeps what
   only it can know — the feed, the freshness ledger, the session calendar, the
   store — and hands all of it to the widgets as one ctx snapshot per tick. A
   widget never fetches, never writes storage and never asks app.js a question
   that is not on this object, which is what makes the same widget safe to run in
   a detached window. */
let wsWired = false;
function mountWorkspace() {
  const host = $('wsHost');
  if (!host) return;
  // store.ensureWorkspaces() is deliberately NOT called here: the default layout
  // is workspace.js's to define, and workspace.init() seeds it through the store
  // with its own factory. Calling it from here would mean inventing a second
  // default that could disagree with the first.
  safe(() => workspace.init(host, getCtx));
  // init() may run again (an import or a shared-view exit replaces the stored
  // layout underneath us), but the change handler is registered exactly once —
  // twice would mean two rail repaints per selection for the rest of the session.
  if (!wsWired) { wsWired = true; safe(() => workspace.onChange(onWorkspaceChange)); }
  // init() recovers the selection from its own linked widgets and announces it
  // before this handler exists, so the first value is read rather than awaited.
  state.selection = safe(() => workspace.selection()) || null;
  markRailSelection();
  if (!host.childElementCount) {
    // A workspace that failed to build must say so rather than leave a blank
    // panel that looks like an empty watchlist.
    host.appendChild(el('p', 'field-note warn-note',
      i18nT('The widget workspace failed to load, so this area is empty. Your watchlist, holdings and alert rules are '
      + 'untouched — reload the page, and use Export in Settings if it happens again.')));
  }
  syncViewButtons();
}

// Fresh on every call: the workspace calls it on every update, and a cached ctx
// is a frame that lies about its own age.
function getCtx() {
  const uncovered = state.uncovered instanceof Set ? state.uncovered : new Set();
  return {
    quotes: state.quotes,
    symbols: sortedWatchlist(),
    holdings: store.holdings,
    rules: store.rules,
    settings: store.settings,
    selection: state.selection,
    seriesFor,
    profileFor,
    sessionFor,
    marketFor,
    frozenMs,
    uncovered,
    staleMs: frameStaleMs(),
    privacy: !!store.settings.privacy,
    onSelect: selectSymbol,
    // Explicit "show me everything about this symbol" — double-click, Enter, ⓘ.
    openDetails: openDrawer,
    level: store.settings.level || 'standard',
    // Education hooks: the learn widget's level switch and tour button. Absent in
    // a popout, which is how those controls know to hide there.
    setLevel: (lv) => setLevel(lv),
    startTour: () => startAppTour(),
    isDemoMode: () => safe(() => market.isDemoMode(), true),
    // Market data, always through the provider facade (cached, paced, budgeted).
    candles: (sym, o) => market.candles(sym, o || {}),
    dailyBars,
    dailyFor,
    fundamentals: fundamentalsFor,
    news: (sym, o) => market.news(sym, o || {}),
    events: (sym) => market.events(sym),
    calendar: (o) => market.calendar(o || {}),
    universes: loadUniverses,
    scanForecast,
    // Chart annotations and levels. Writes go through the store here, never from
    // a widget directly.
    drawingsFor: (sym) => safe(() => store.drawingsFor(sym), []) || [],
    saveDrawings: saveDrawings,
    levelsFor,
    onRequestAlert: (sym, price, op) => openAlerts(sym, { type: 'price', value: price, op }),
    onLevelDrag,
    // Portfolio: the ledger, one shared valuation, and the few writes the money
    // widgets may ask for. Every write goes through the store here.
    ledger: store.ledger,
    portfolio: (account) => folio(account),
    targets: store.targets,
    setTarget: (key, pct) => { safe(() => store.setTarget(key, pct)); refreshWidgets(); },
    setBaseCurrency,
    setCostMethod,
    openLedger: (o) => ledgerUI && ledgerUI.open({ ...(o || {}), fromWidget: true }),
    downloadCSV: (name, text) => downloadFile(name + '-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv', text),
  };
}

/* ---- portfolio ---------------------------------------------------------------
   One valuation of the ledger per change in its inputs (folio.js memoises it),
   shared by the widgets, the chart's cost lines, the alert engine and the
   watched-symbol set. */
function folio(account = '') {
  return safe(() => computePortfolio({
    ledger: store.ledger, quotes: state.quotes, baseCurrency: store.settings.baseCurrency,
    method: store.settings.costMethod, profileFor, account: account || '',
  }), null);
}

function setBaseCurrency(ccy) {
  const c = String(ccy || '').toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(c) || c === store.settings.baseCurrency) return;
  store.settings.baseCurrency = c;
  store.saveSettings();
  publishState();
  refreshWidgets();
  // The new base may need FX legs nobody has fetched yet.
  if (scheduler) scheduler.now();
}

function setCostMethod(m) {
  if (!['fifo', 'avg'].includes(m) || m === store.settings.costMethod) return;
  store.settings.costMethod = m;
  store.saveSettings();
  publishState();
  refreshWidgets();
}

/* Armed rules that measure daily bars (RSI, moving averages, 52-week range)
   need those bars cached; rules that can fall back on fundamentals need those.
   Only the armed ones, at background priority, and each symbol at most once per
   cache lifetime — this is the whole cost of technical alerts. */
function ensureRuleData() {
  for (const r of store.rules) {
    if (!r || !r.armed || !r.symbol || r.symbol[0] === '@') continue;
    const def = ALERT_TYPES[r.type];
    if (!def) continue;
    if (def.needs === 'bars') {
      const d = state.daily[r.symbol];
      if (!d || Date.now() - d.at > DAILY_TTL) dailyBars(r.symbol).catch(() => {});
    }
    if (def.fundamentals) ensureFund(r.symbol);
  }
}

function noticeMigration() {
  const mig = (store.ledger || []).filter((t) => t && t.date === '1970-01-01' && /^migrated/.test(t.note || '')).length;
  if (!mig || store.settings.ledgerMigrationNoticed) return;
  store.settings.ledgerMigrationNoticed = true;
  safe(() => store.saveSettings());
  setTimeout(() => toast(i18nT('Imported') + ' ' + mig + ' ' + i18nT(mig === 1 ? 'holding' : 'holdings') + ' '
    + i18nT('from the old format into Transactions. Add their purchase dates there for accurate returns.')), 1200);
}

/* ---- market data for widgets ------------------------------------------------
   Daily bars back the screener, pivots and the 52-week lines. They are fetched at
   background priority (a visible chart always goes first in the pacer queue) and
   remembered for the session so a second widget asking is free. */
const DAILY_TTL = 15 * 60 * 1000;
const dailyInflight = new Map();
function dailyBars(sym) {
  const hit = state.daily[sym];
  if (hit && Date.now() - hit.at < DAILY_TTL && hit.bars.length) return Promise.resolve(hit.res);
  // One request per symbol at a time: the screener, a chart and an armed RSI
  // rule asking together must cost one call, not three.
  if (dailyInflight.has(sym)) return dailyInflight.get(sym);
  const p = market.candles(sym, { range: '1Y', interval: '1d', priority: 0, maxWait: 180000 }).then((res) => {
    state.daily[sym] = { at: Date.now(), bars: (res && res.bars) || [], isDemo: !!(res && res.isDemo), res };
    return res;
  }).finally(() => dailyInflight.delete(sym));
  dailyInflight.set(sym, p);
  return p;
}
function dailyFor(sym) { const d = state.daily[sym]; return d && d.bars.length ? d.bars : null; }

const FUND_TTL = 6 * 3600 * 1000;
function fundamentalsFor(sym) {
  return market.fundamentals(sym).then((f) => { state.fund[sym] = { at: Date.now(), f: f || null }; return f; });
}
// Background fetch for the 52-week lines, at most once per symbol per TTL.
const fundAsked = new Map();
function ensureFund(sym) {
  const t = fundAsked.get(sym) || 0;
  if (Date.now() - t < FUND_TTL) return;
  fundAsked.set(sym, Date.now());
  fundamentalsFor(sym).then(() => refreshWidgets()).catch(() => {});
}

let universesP = null;
function loadUniverses() {
  if (!universesP) {
    universesP = fetch('data/universes.json', { cache: 'no-cache' }).then((r) => r.json())
      .then((d) => (Array.isArray(d && d.lists) ? d.lists : []))
      .catch(() => { universesP = null; return []; });
  }
  return universesP;
}

// "About N requests and how long" for a scan, from the pacer's own queue model.
function scanForecast(syms) {
  if (safe(() => market.isDemoMode(), true)) return { demo: true, ms: 0 };
  const list = Array.isArray(syms) ? syms : [];
  if (!list.length) return null;
  const pid = safe(() => market.routeCandles(list[0], '1d', '1Y'), null);
  if (!pid) return null;
  const ms = safe(() => market.forecast(pid, list.length), null);
  return { ms: Number.isFinite(ms) || ms === Infinity ? ms : 0, provider: pid, label: (PROVIDER_LABELS[pid] || pid) + ' ' + i18nT('free tier') };
}

function saveDrawings(sym, arr) {
  const ok = safe(() => store.setDrawings(sym, arr), false);
  if (ok === false && store.hashActive) toast(i18nT('Drawings are not saved while you are viewing a shared link.'), 'err');
  return ok;
}

/* The horizontal lines a chart draws for a symbol: armed price rules (draggable,
   so moving the line moves the rule), the average cost of a position, the
   previous close and the 52-week range. Each says what it is in its label. */
function levelsFor(sym) {
  const out = [];
  for (const r of store.rules) {
    if (!r || !r.armed || r.symbol !== sym || r.type !== 'price' || !Number.isFinite(Number(r.value))) continue;
    const arrow = r.op === 'below' || r.op === 'crossBelow' ? '≤' : '≥';
    out.push({ price: Number(r.value), label: i18nT('Alert') + ' ' + arrow, kind: 'alert', draggable: true, ruleId: r.id });
  }
  const pos = positionFor(sym);
  if (pos && Number.isFinite(pos.avgCost) && pos.avgCost > 0) out.push({ price: pos.avgCost, label: i18nT('Avg cost'), kind: 'cost' });
  const q = state.quotes[sym];
  if (q && Number.isFinite(q.prevClose)) out.push({ price: q.prevClose, label: i18nT('Prev close'), kind: 'prevClose' });
  const f = state.fund[sym] && state.fund[sym].f;
  let hi = f && Number.isFinite(f.high52) ? f.high52 : null, lo = f && Number.isFinite(f.low52) ? f.low52 : null;
  if (hi == null || lo == null) {
    const d = dailyFor(sym);
    if (d && d.length > 150) {
      for (const b of d.slice(-252)) { if (hi == null || b.h > hi) hi = b.h; if (lo == null || b.l < lo) lo = b.l; }
    }
  }
  if (Number.isFinite(hi)) out.push({ price: hi, label: i18nT('52w high'), kind: 'high52' });
  if (Number.isFinite(lo)) out.push({ price: lo, label: i18nT('52w low'), kind: 'low52' });
  if (!state.fund[sym]) ensureFund(sym);
  return out;
}

// Average cost across accounts, from the ledger (the legacy holdings were
// migrated into it at schema v3).
function positionFor(sym) {
  const pf = folio();
  let qty = 0, cost = 0;
  for (const p of (pf && pf.positions) || []) {
    if (p.symbol !== sym || !Number.isFinite(p.avgCost)) continue;
    qty += p.qty; cost += p.avgCost * p.qty;
  }
  return qty ? { qty, cost, avgCost: cost / qty } : null;
}

// Dragging an alert line on a chart moves the rule it stands for.
function onLevelDrag(sym, level, price) {
  if (!level || level.kind !== 'alert' || !level.ruleId || !Number.isFinite(price)) return;
  const value = Number(price.toPrecision(8));
  safe(() => store.updateRule(level.ruleId, { value }));
  toast(i18nT('Alert moved') + ': ' + sym + ' ' + fmtMove(value, value));
  refreshWidgets();
  if (!$('alertsModal').hidden) safe(() => renderRuleList());
}

function seriesFor(sym) {
  const rec = store.series[sym];
  return rec && Array.isArray(rec.points) ? rec.points : [];
}
function profileFor(sym) { return store.profiles[sym] || null; }
function marketFor(sym) { return safe(() => marketForSymbol(sym, state.quotes[sym]), 'US_EQUITY') || 'US_EQUITY'; }

/* The age of the whole frame, not of one symbol: zero while the last completed
   poll is still current, and the real age once it is not. Reported rather than
   hidden, because every figure a widget draws is exactly this far behind — and
   the commonest cause is a pause the user forgot they set. */
function frameStaleMs() {
  if (!state.lastUpdated) return 0;
  const age = Date.now() - state.lastUpdated;
  return age > staleThreshold() ? age : 0;
}

/* Every path that changes which symbol the app is talking about goes through
   here: a widget's onSelect, a rail click, a card click inside the cards widget.
   Selecting only moves the workspace selection so linked widgets follow. The
   details drawer used to open on every click as well, which covered the board
   the user was re-linking; it now opens only on an explicit request
   (double-click, Enter, the ⓘ buttons) through openDrawer. */
function selectSymbol(sym) {
  const clean = normalizeSymbol(sym);
  if (!clean) return;
  const fresh = !state.quotes[clean];
  state.selection = clean;
  safe(() => workspace.select(clean));
  // Repaint now rather than at the next poll: with a shut market the cadence
  // floor is five minutes, and a board that takes five minutes to agree about
  // which symbol is selected reads as broken.
  refreshWidgets();
  markRailSelection();
  closeRailOnMobile();
  // A symbol nobody has fetched yet (picked from a screener list) gets its quote
  // now rather than at the next scheduled poll.
  if (fresh && scheduler) scheduler.now();
}

function onWorkspaceChange(info) {
  state.selection = (info && info.selection) || null;
  markRailSelection();
  syncViewButtons();
}

function markRailSelection() {
  for (const row of document.querySelectorAll('.rail-row[data-sym]')) {
    row.classList.toggle('active', row.dataset.sym === state.selection);
  }
}

/* The old Watchlist/Portfolio toggle, kept as a shortcut to the tab that shows
   each thing. Tabs are the navigation now; two navigations that can disagree
   about what is on screen is worse than one. A user whose layout has no such tab
   is not told no — the widget is added and the addition is announced, because
   losing sight of a portfolio you entered by hand is not an acceptable answer. */
const VIEW_KINDS = { watch: ['cards', 'table'], port: ['portfolio'] };

function gotoView(view) {
  const kinds = VIEW_KINDS[view] || [];
  const tabs = safe(() => workspace.tabs(), []) || [];
  const found = tabs.find((t) => t.widgets.some((w) => kinds.includes(w.kind)));
  if (found) {
    if (found.id !== safe(() => workspace.activeTabId())) workspace.setActiveTab(found.id);
    syncViewButtons();
    return;
  }
  const added = safe(() => workspace.addWidget(kinds[0]));
  if (added) toast(i18nT(view === 'port' ? 'Added a Portfolio widget to this tab.' : 'Added a Cards widget to this tab.'));
  else toast(i18nT('Could not add that widget — use ＋ Widget above the grid.'), 'err');
  syncViewButtons();
}

// Both buttons can be lit at once: a tab holding a card grid and a portfolio is a
// layout the workspace allows, and pretending one of them is not there would be
// the lie the toggle used to tell.
function syncViewButtons() {
  const id = safe(() => workspace.activeTabId());
  const tab = (safe(() => workspace.tabs(), []) || []).find((t) => t.id === id);
  const kinds = tab ? tab.widgets.map((w) => w.kind) : [];
  $('viewWatch').classList.toggle('active', kinds.some((k) => VIEW_KINDS.watch.includes(k)));
  $('viewPort').classList.toggle('active', kinds.some((k) => VIEW_KINDS.port.includes(k)));
}

function deltaChip(q) {
  const c = el('span', 'delta');
  if (!q || q.changePct == null) { c.classList.add('flat'); c.textContent = '—'; return c; }
  const up = q.changePct >= 0;
  c.classList.add(up ? 'up' : 'down');
  // The change shares the price's precision. Two decimals turned every move on a
  // sub-dollar coin or an FX pair into "0.00" next to a non-zero percentage.
  c.textContent = `${up ? '▲' : '▼'} ${fmtMove(q.change, q.price)} (${fmtNum(q.changePct)}%)`;
  return c;
}

/* ---- left rail --------------------------------------------------------------
   The rail is the one list that is always on screen whatever the workspace looks
   like, so it owns the two things a widget may not do: it removes a symbol, and
   it is the keyboard route into the board. The row is a real button for that
   reason — the old div was reachable by mouse only. */
function renderRail() {
  const list = $('railList');
  list.textContent = '';
  const syms = sortedWatchlist();
  for (const sym of syms) {
    const q = state.quotes[sym];
    const row = el('div', 'rail-row'); row.dataset.sym = sym;
    if (sym === state.selection) row.classList.add('active');

    const pick = el('button', 'rr-btn');
    pick.type = 'button';
    pick.title = i18nT('Link the workspace to') + ' ' + sym + ' · ' + i18nT('double-click or Enter for details');
    pick.append(el('span', 'rr-sym', sym));
    pick.append(el('span', 'rr-price amount', q ? fmtPrice(q.price, q.currency, fxOpts(sym)) : '—'));
    pick.appendChild(deltaChip(q));
    pick.addEventListener('click', () => selectSymbol(sym));
    pick.addEventListener('dblclick', () => openDrawer(sym));
    pick.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); selectSymbol(sym); openDrawer(sym); } });
    row.appendChild(pick);

    const info = el('button', 'icon-mini rr-info info-i', 'i');
    info.type = 'button';
    info.title = i18nT('Details for') + ' ' + sym;
    info.setAttribute('aria-label', i18nT('Details for') + ' ' + sym);
    info.addEventListener('click', () => { selectSymbol(sym); openDrawer(sym); });
    row.appendChild(info);

    const rm = el('button', 'icon-mini rr-x', '✕');
    rm.type = 'button';
    rm.title = i18nF('Remove {sym} from the watchlist', { sym });
    rm.setAttribute('aria-label', 'Remove ' + sym);
    rm.addEventListener('click', () => { store.removeSymbol(sym); refreshAll(); });
    row.appendChild(rm);

    list.appendChild(row);
  }
  // The widgets can only report an empty watchlist; the offer to fill one lives
  // here, next to the list it would fill.
  const empty = $('railEmpty');
  if (empty) empty.hidden = syms.length > 0;
}

/* ---- market strip -----------------------------------------------------------
   A configurable list (Settings → Market strip symbols). The defaults are ETFs
   that track the big US indices plus Bitcoin; an index itself (^GSPC, ^VIX) is
   not something the free tiers quote, so the label says which fund stands in. */
const DEFAULT_STRIP = ['SPY', 'QQQ', 'DIA', 'BTC', 'EURUSD'];
const STRIP_LABELS = {
  SPY: 'S&P 500 (SPY)', QQQ: 'Nasdaq 100 (QQQ)', DIA: 'Dow 30 (DIA)', IWM: 'Russell 2000 (IWM)',
  BTC: 'Bitcoin', ETH: 'Ether', EWW: 'Mexico (EWW)', EWZ: 'Brazil (EWZ)', VIXY: 'VIX futures (VIXY)',
  GLD: 'Gold (GLD)', TLT: '20y Treasuries (TLT)', EURUSD: 'EUR/USD', USDMXN: 'USD/MXN',
};
function stripSymbols() {
  const raw = store.settings.stripSymbols;
  const list = Array.isArray(raw) ? raw.map((x) => normalizeSymbol(x)).filter(Boolean) : DEFAULT_STRIP;
  return [...new Set(list)].slice(0, 10);
}
function renderMarketStrip() {
  const strip = $('marketStrip');
  strip.hidden = !store.settings.showMarket;
  if (!store.settings.showMarket) return;
  const tiles = $('mktTiles');
  tiles.textContent = '';
  for (const sym of stripSymbols()) {
    const q = state.quotes[sym];
    const tile = el('button', 'stat-tile mkt-tile');
    tile.type = 'button';
    tile.dataset.sym = sym;
    tile.title = i18nT('Link the workspace to') + ' ' + sym + ' · ' + i18nT('double-click for details');
    tile.append(el('div', 'st-label', i18nT(STRIP_LABELS[sym] || sym)));
    const uncov = !q && state.uncovered.has(sym);
    tile.append(el('div', 'st-value amount', q ? fmtPrice(q.price, q.currency, fxOpts(sym)) : uncov ? i18nT('Not covered') : '—'));
    tile.appendChild(deltaChip(q));
    tile.addEventListener('click', () => selectSymbol(sym));
    tile.addEventListener('dblclick', () => openDrawer(sym));
    tiles.appendChild(tile);
  }
  $('mktUpdated').textContent = state.lastUpdated ? i18nT('Updated') + ' ' + fmtTime(state.lastUpdated) : '';
}

/* ---- detail drawer -----------------------------------------------------------
   Everything about one symbol: the live quote, a full chart (the same chart
   panel the workspace uses), fundamentals, upcoming events and recent news. It
   opens only on an explicit request — double-click, Enter, or an ⓘ button —
   and its header figures are PATCHED on every tick rather than frozen at open.

   Async sections are guarded: every open bumps a token, and an answer that
   arrives for an older token is dropped, so clicking quickly through symbols
   can never paint AAPL's news under MSFT's title. The chart's range, type and
   indicators are remembered while the page is open; type, volume and
   indicators also become the default for new charts (settings.chartDefaults). */
let drawerSym = null, drawerToken = 0, drawerCloseTimer = 0, drawerPanel = null, drawerRefs = null, drawerReturnFocus = null;
let drawerChartState = null;

function openDrawer(sym) {
  const clean = normalizeSymbol(sym);
  if (!clean) return;
  clearTimeout(drawerCloseTimer);
  const d = $('drawer');
  const wasOpen = !d.hidden && d.classList.contains('open');
  if (!wasOpen) drawerReturnFocus = document.activeElement;
  $('drawerScrim').hidden = false;
  d.hidden = false;
  d.setAttribute('aria-hidden', 'false');
  void d.offsetWidth;                 // force reflow so the slide-in transition plays reliably
  d.classList.add('open');
  if (drawerSym === clean && drawerRefs) { refreshDrawer(); return; }
  drawerSym = clean;
  renderDrawer();
  // The drawer's symbol is now a watched one; fetch its quote if nothing has.
  if (!state.quotes[clean] && scheduler) scheduler.now();
  setTimeout(() => safe(() => $('drawerClose').focus({ preventScroll: true })), 30);
}

function closeDrawer() {
  const d = $('drawer');
  if (d.hidden) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  $('drawerScrim').hidden = true;
  drawerToken++;
  drawerSym = null;
  clearTimeout(drawerCloseTimer);
  drawerCloseTimer = setTimeout(() => {
    d.hidden = true;
    if (drawerPanel) { safe(() => drawerPanel.destroy()); drawerPanel = null; }
    drawerRefs = null;
    $('drawerBody').textContent = '';
  }, 250);
  const back = drawerReturnFocus;
  drawerReturnFocus = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) safe(() => back.focus({ preventScroll: true }));
}

function drawerIsOpen() { const d = $('drawer'); return !d.hidden && d.classList.contains('open'); }

function wireDrawer() {
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  /* Escape closes ONE thing: the topmost. Anything that handled the key itself
     (a widget drag, a column menu, a tab rename, the chart's own popover, a
     native <dialog>) calls preventDefault, and that ends it here. */
  // On window, so it runs after every document-level handler has had its turn.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    if (!$('modalScrim').hidden) { e.preventDefault(); closeModal(); return; }
    if (drawerIsOpen()) { e.preventDefault(); closeDrawer(); return; }
    if ($('rail').classList.contains('open')) { e.preventDefault(); setRailOpen(false); }
  });
}

function renderDrawer() {
  const sym = drawerSym;
  if (!sym) return;
  const my = ++drawerToken;
  if (drawerPanel) { safe(() => drawerPanel.destroy()); drawerPanel = null; }
  const body = $('drawerBody');
  body.textContent = '';
  const prof = store.profiles[sym] || null;
  $('drawerTitle').textContent = sym + (prof && prof.name ? ' · ' + prof.name : '');

  const line = el('div', 'drawer-session');
  const sessChip = el('span', 'tag closed', '');
  const sessNote = el('span', 'ds-note', '');
  const approx = el('span', 'tag approx', i18nT('approx'));
  const stale = el('span', 'tag stale', '');
  const ruleBtn = el('button', 'cs-btn sm ds-alert', '🔔 ' + i18nT('Alert rule'));
  ruleBtn.type = 'button';
  ruleBtn.addEventListener('click', () => openAlerts(sym));
  const ruleBadge = el('span', 'rule-badge', '');
  ruleBtn.appendChild(ruleBadge);
  line.append(sessChip, sessNote, approx, stale, el('span', 'spacer'), ruleBtn);
  body.appendChild(line);

  const kv = el('div', 'kv-grid ds-kv');
  const cells = {};
  for (const [k, label, learn] of [['last', 'Last', 'last-price'], ['change', 'Change', 'change'], ['baseline', 'Baseline', 'prev-close'],
    ['open', 'Open', 'open-price'], ['prev', 'Prev close', 'prev-close'], ['range', 'Day range', 'day-range'], ['volume', 'Volume', 'volume'],
    ['exchange', 'Exchange', null], ['sector', 'Sector', null]]) {
    const kk = el('div', 'kv-k', i18nT(label));
    if (learn) safe(() => kk.appendChild(helpIconFor(learn)));
    cells[k] = el('div', 'kv-v' + (['exchange', 'sector'].includes(k) ? '' : ' amount'), '—');
    kv.append(kk, cells[k]);
  }
  body.appendChild(kv);

  const chartBox = el('div', 'ds-chart');
  body.appendChild(chartBox);
  const defaults = store.settings.chartDefaults || {};
  drawerPanel = mountChartPanel(chartBox, {
    getDeps: () => ({ ...getCtx(), quoteFor: (s) => state.quotes[s] || null, linkBus: null }),
    state: drawerChartState,
    defaults,
    variant: 'drawer',
    onState: (st) => {
      drawerChartState = st;
      // Type, volume and indicators become the default for new charts; range,
      // interval, log and compare stay with this page session.
      const next = { type: st.t, volume: st.v, indicators: st.ind.map((x) => ({ id: x.id, params: x.p })) };
      if (JSON.stringify(next) !== JSON.stringify(store.settings.chartDefaults)) { store.settings.chartDefaults = next; safe(() => store.saveSettings()); }
    },
  });
  drawerPanel.setSymbol(sym);

  const sec = (title, learn) => {
    const h = el('h3', 'ds-sec', i18nT(title));
    if (learn) safe(() => h.appendChild(helpIconFor(learn)));
    const box = el('div', 'ds-box');
    box.appendChild(el('p', 'field-note', i18nT('Loading…')));
    body.append(h, box);
    return box;
  };
  const fundBox = sec('Key statistics', 'market-cap');
  const evBox = sec('Upcoming events', 'earnings-report');
  const newsBox = sec('Recent news', null);

  const seriesId = safe(() => market.routeCandles(sym, '1d', '1Y'), 'demo') || 'demo';
  body.appendChild(el('p', 'field-note', i18nT('Bars via') + ' ' + (PROVIDER_LABELS[seriesId] || seriesId) + '. '
    + i18nT('Double-click a symbol anywhere to open this panel; a single click only links the widgets.') + ' ' + i18nT('Delayed · not investment advice.')));

  drawerRefs = { sym, sessChip, sessNote, approx, stale, ruleBtn, ruleBadge, cells };
  refreshDrawer();

  // Profile, fundamentals, events and news arrive independently; each lands
  // only if the drawer still shows the symbol that asked.
  const live = () => my === drawerToken && drawerSym === sym;
  market.profile(sym).then((p) => { if (!live() || !p) return; $('drawerTitle').textContent = sym + (p.name ? ' · ' + p.name : ''); refreshDrawer(); }).catch(() => {});
  fundamentalsFor(sym).then((f) => { if (live()) renderFundamentals(fundBox, f, { quote: state.quotes[sym], fx: fxOpts(sym).fx }); })
    .catch(() => { if (live()) renderFundamentals(fundBox, null); });
  market.events(sym).then((ev) => { if (live()) renderEvents(evBox, ev); }).catch(() => { if (live()) renderEvents(evBox, null); });
  market.news(sym, { limit: 8 }).then((n) => { if (live()) renderNewsList(newsBox, n, { compact: false }); }).catch(() => { if (live()) renderNewsList(newsBox, []); });
  // Daily bars back the 52-week lines and pivots on the chart.
  if (!dailyFor(sym)) dailyBars(sym).then(() => { if (live() && drawerPanel) drawerPanel.tick(); }).catch(() => {});
}

// Patch the header figures and the chart's live bar; called on every tick.
function refreshDrawer() {
  const r = drawerRefs;
  if (!r || !drawerSym || r.sym !== drawerSym) return;
  const sym = r.sym;
  const q = state.quotes[sym];
  const sess = sessionFor(sym);
  setTxt(r.sessChip, sess.label);
  r.sessChip.className = 'tag ' + (sess.isTradeable ? 'live' : 'closed');
  setTxt(r.sessNote, [sess.detail, sess.nextLabel].filter(Boolean).join(' · '));
  r.approx.hidden = !sess.approx;
  const froz = sess.isTradeable ? frozenMs(sym) : 0;
  r.stale.hidden = !(froz > staleThreshold());
  if (!r.stale.hidden) setTxt(r.stale, i18nT('Stale') + ' ' + formatCountdown(froz));
  const armed = safe(() => store.rulesFor(sym).filter((x) => x.armed).length, 0);
  setTxt(r.ruleBadge, armed ? String(armed) : '');
  r.ruleBadge.hidden = !armed;
  r.ruleBtn.title = armed ? armed + ' ' + i18nT(armed === 1 ? 'armed rule on' : 'armed rules on') + ' ' + sym : i18nT('No rules on') + ' ' + sym + ' ' + i18nT('yet');
  const c = r.cells;
  const uncov = !q && state.uncovered.has(sym);
  setTxt(c.last, q ? fmtPrice(q.price, q.currency, fxOpts(sym)) : uncov ? i18nT('Not covered') : '—');
  // Every figure on this row inherits the price's precision, as the delta chip
  // already did: two decimals turns a sub-dollar coin's whole day into "0.00".
  setTxt(c.change, q && q.changePct != null ? `${fmtMove(q.change, q.price)} (${fmtNum(q.changePct)}%)` : '—');
  c.change.className = 'kv-v amount ' + (q && q.changePct > 0 ? 'pos' : q && q.changePct < 0 ? 'neg' : '');
  // The three-value vocabulary is too coarse for "an IEX close" versus "the
  // official one", so the provider's own sentence is the tooltip when it has one.
  setTxt(c.baseline, baselineText(sym, q));
  c.baseline.title = q && q.baselineNote ? i18nT(q.baselineNote) : '';
  setTxt(c.open, q ? fmtMove(q.open, q.price) : '—');
  setTxt(c.prev, q ? fmtMove(q.prevClose, q.price) : '—');
  setTxt(c.range, q && q.low != null ? `${fmtMove(q.low, q.price)} – ${fmtMove(q.high, q.price)}` : '—');
  setTxt(c.volume, q && q.volume != null ? fmtInt(q.volume) : '—');
  const prof = store.profiles[sym];
  setTxt(c.exchange, (prof && prof.exchange) || '—');
  setTxt(c.sector, (prof && prof.sector) || '—');
  if (drawerPanel) drawerPanel.tick();
}

function setTxt(node, t) { const v = t == null ? '' : String(t); if (node.textContent !== v) node.textContent = v; }
function helpIconFor(id) { return helpIcon(id); }

function baselineText(sym, q) {
  if (!q) return '—';
  if (q.baseline === 'rolling_24h') return i18nT('Rolling 24h (provider)');
  if (q.baseline === 'prev_close') return i18nT('Previous close (provider)');
  if (marketForSymbol(sym, q) === 'CRYPTO') return i18nT('Rolling 24h (inferred)');
  return i18nT('Not stated by provider');
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
  $('viewWatch').addEventListener('click', () => gotoView('watch'));
  $('viewPort').addEventListener('click', () => gotoView('port'));
  $('btnHoldings').addEventListener('click', () => ledgerUI && ledgerUI.open());
  $('btnPrivacy').addEventListener('click', () => { setPrivacy(!store.settings.privacy); publishState(); });
  $('btnAlerts').addEventListener('click', () => openAlerts(state.selection || store.watchlist[0] || ''));
  // Phones and tablets: the rail is off-canvas below 900px and this is its door.
  const railBtn = $('btnRail');
  if (railBtn) railBtn.addEventListener('click', () => setRailOpen(!$('rail').classList.contains('open')));
  document.addEventListener('pointerdown', (e) => {
    const rail = $('rail');
    if (!rail.classList.contains('open')) return;
    if (rail.contains(e.target) || (railBtn && railBtn.contains(e.target))) return;
    setRailOpen(false);
  }, true);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnDisplays').addEventListener('click', () => openSettings('displaysSection'));
  $('sessChip').addEventListener('click', () => {
    safe(() => market.refreshMarketStatus());
    pollStatus(true);
    toast(i18nT('Re-checking the session with your data provider.'));
  });
  $('sortSel').addEventListener('change', () => { renderRail(); refreshWidgets(); });

  wireAutocomplete($('railSearch'), $('railAuto'), (sym) => { if (store.addSymbol(sym)) { $('railSearch').value = ''; $('railAuto').hidden = true; refreshAll(); } });
  $('emptyAdd').addEventListener('click', () => $('btnAdd').click());
  $('emptyDemo').addEventListener('click', () => { store.watchlist = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'SPY', 'AMD']; store.saveWatchlist(); refreshAll(); });

  // First run is two short steps on one card: what this tool is (and is not),
  // then how much of it to show first. A returning user who acknowledged before
  // levels existed is never sent back through it (see noticeLevel).
  $('ackBtn').addEventListener('click', () => {
    store.settings.ack = true; store.saveSettings();
    if (store.settings.levelChosen) { $('ackGate').hidden = true; return; }
    $('ackStep1').hidden = true;
    $('ackStep2').hidden = false;
    const first = document.querySelector('#ackStep2 .ack-lv[data-level="' + normalizeLevel(store.settings.level) + '"]')
      || document.querySelector('#ackStep2 .ack-lv');
    if (first) first.focus();
  });
  for (const b of document.querySelectorAll('#ackStep2 .ack-lv')) {
    b.addEventListener('click', () => chooseFirstLevel(b.dataset.level));
  }

  setPrivacy(store.settings.privacy);
}

function setRailOpen(on) {
  const rail = $('rail');
  rail.classList.toggle('open', !!on);
  const b = $('btnRail');
  if (b) { b.setAttribute('aria-expanded', on ? 'true' : 'false'); b.classList.toggle('active', !!on); }
  if (on) setTimeout(() => safe(() => $('railSearch').focus({ preventScroll: true })), 50);
}
function closeRailOnMobile() {
  if ($('rail').classList.contains('open') && safe(() => matchMedia('(max-width: 900px)').matches, false)) setRailOpen(false);
}

/* body.privacy-on covers the chrome. A widget applies the blur itself from
   ctx.privacy, because a detached panel is a different document and has no body
   class of ours to read — so the widgets are told at once rather than at the next
   poll, which with a shut market is five minutes of unblurred figures. */
function setPrivacy(on) {
  store.settings.privacy = on; store.saveSettings();
  document.body.classList.toggle('privacy-on', on);
  $('btnPrivacy').classList.toggle('active', on);
  refreshWidgets();
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
    mountWorkspace();
    refreshAll();
    toast(i18nT('Shared watchlist saved to this browser.'));
  });

  $('hashDiscard').addEventListener('click', () => {
    if (typeof store.exitHash === 'function') {
      store.exitHash();
      banner.hidden = true;
      // exitHash puts the saved layout back; without this the screen would keep
      // showing the tabs the shared view was arranged in.
      mountWorkspace();
      refreshAll();
      toast(i18nT('Shared view discarded — your saved watchlist is back.'));
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
        row.append(el('span', 'ac-desc', i18nT('Add symbol')));
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
// Focus moves into the dialog and back to whatever opened it, so a keyboard or
// screen-reader user is never left on a control hidden behind the scrim.
let modalReturnFocus = null;
function openModal(id, after) {
  const wasOpen = !$('modalScrim').hidden;
  if (!wasOpen) modalReturnFocus = document.activeElement;
  $('modalScrim').hidden = false;
  for (const m of document.querySelectorAll('.modal')) m.hidden = m.id !== id;
  if (after) after();
  const m = $(id);
  if (m && !m.contains(document.activeElement)) {
    const f = m.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea, .modal-body button, .modal-x');
    if (f) safe(() => f.focus({ preventScroll: true }));
  }
}
function closeModal() {
  $('modalScrim').hidden = true;
  for (const m of document.querySelectorAll('.modal')) m.hidden = true;
  const back = modalReturnFocus; modalReturnFocus = null;
  if (back && back.isConnected && typeof back.focus === 'function') safe(() => back.focus({ preventScroll: true }));
}
function wireModals() {
  // Every modal is announced as a dialog named by its own title.
  let n = 0;
  for (const m of document.querySelectorAll('.modal')) {
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    const t = m.querySelector('.modal-title');
    if (t) { if (!t.id) t.id = 'modalTitle' + (++n); m.setAttribute('aria-labelledby', t.id); }
  }
  // Tab stays inside the open modal.
  $('modalScrim').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const m = [...document.querySelectorAll('.modal')].find((x) => !x.hidden);
    if (!m) return;
    const f = [...m.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
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
    if (confirm(i18nT('Erase all watchlists, holdings, rules, keys and settings from this browser?'))) { store.clearAll(); location.reload(); }
  });

  // Alerts and transactions: their dialogs live in their own modules; this file
  // hands them the few things only the controller knows.
  alertsUI = initAlertsUI({
    store, openModal, toast,
    quotes: () => state.quotes,
    sessionFor, marketFor,
    routeQuote: (sym) => market.routeQuote(sym),
    extHours: EXT_HOURS, providerLabels: PROVIDER_LABELS,
    level: () => store.settings.level || 'standard',
    heldSymbols: () => { const pf = folio(); return pf ? pf.positions.map((p) => p.symbol) : []; },
    dailyFor,
    ensureBars: (sym) => dailyBars(sym),
    fundFor: (sym) => (state.fund[sym] ? state.fund[sym].f : null),
    ensureFund,
    portfolioTotals: () => { const pf = folio(); return pf && !pf.empty ? pf.totals : null; },
    onChange: () => { refreshWidgets(); publishState(); },
    downloadFile, fxOpts,
  });
  ledgerUI = initLedgerUI({
    store, openModal, closeModal, toast,
    quotes: () => state.quotes,
    level: () => store.settings.level || 'standard',
    portfolio: (ledger) => (ledger ? safe(() => computePortfolio({ ledger, quotes: state.quotes, baseCurrency: store.settings.baseCurrency,
      method: store.settings.costMethod, profileFor })) : folio()),
    profileFor,
    downloadFile,
    positionsCSV: () => positionsCSV(folio()),
    onChange: () => { refreshAll(); },
  });
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
  if ($('setStrip')) $('setStrip').value = stripSymbols().join(', ');
  if ($('setBaseCcy')) $('setBaseCcy').value = s.baseCurrency || 'USD';
  if ($('setCostMethod')) $('setCostMethod').value = s.costMethod === 'avg' ? 'avg' : 'fifo';
  updateProviderConfig();
}

// Show only the selected provider's key fields; update the mode note.
function updateProviderConfig() {
  const sel = $('setProvider').value;
  for (const box of document.querySelectorAll('.provider-config')) box.hidden = box.dataset.provider !== sel;
  const universal = $('setUniversal').checked;
  $('providerModeNote').textContent = universal
    ? i18nF('Every symbol uses {provider}.', { provider: PROVIDER_LABELS[sel] || sel })
    : i18nT('Auto-route: equities use the selected stock provider, crypto uses CoinGecko (keyless), FX uses Twelve Data. Symbols are grouped so each provider gets one batched call — add keys for whichever providers you use.');
}
function openSettings(scrollTo) {
  openModal('settingsModal', () => {
    applySettingsToUI();
    $('keyStatus').textContent = '';
    renderDisplays();
    reportStorage();
    paintLevelChrome();
    startProviderPanel();
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
  if ($('setStrip')) {
    const list = $('setStrip').value.split(/[\s,;]+/).map((x) => normalizeSymbol(x)).filter(Boolean);
    s.stripSymbols = [...new Set(list)].slice(0, 10);
    if (!s.stripSymbols.length) s.stripSymbols = DEFAULT_STRIP.slice();
  }
  if ($('setBaseCcy')) {
    const c = $('setBaseCcy').value.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(c)) s.baseCurrency = c;
  }
  if ($('setCostMethod')) s.costMethod = $('setCostMethod').value === 'avg' ? 'avg' : 'fifo';
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
  const status = $('keyStatus'); status.textContent = i18nT('Checking keys…');
  const parts = [];
  if (s.finnhubKey) parts.push('Finnhub ' + (await market.validate('finnhub').catch(() => false) ? '✓' : '✕'));
  if (s.twelvedataKey) parts.push('Twelve Data ' + (await market.validate('twelvedata').catch(() => false) ? '✓' : '✕'));
  if (s.polygonKey) parts.push('Polygon ' + (await market.validate('polygon').catch(() => false) ? '✓' : '✕'));
  if (s.alphaVantageKey) parts.push('Alpha Vantage ' + (await market.validate('alphavantage').catch(() => false) ? '✓' : '✕'));
  if (s.alpacaKeyId && s.alpacaSecret) parts.push('Alpaca ' + (await market.validate('alpaca').catch(() => false) ? '✓' : '✕'));
  status.textContent = parts.join('  ·  ') || i18nT('Demo mode (no keys).');
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
      applySettingsToUI();
      // The import replaced the stored layout in place; the frames on screen are
      // still the old tab's, so the workspace is rebuilt rather than left lying.
      mountWorkspace();
      refreshAll();
      const dropped = r && r.dropped ? Object.values(r.dropped).reduce((a, b) => a + b, 0) : 0;
      toast(r
        ? i18nF('Imported {symbols} symbols, {rules} rules, {txns} transactions.', { symbols: r.watchlist, rules: r.rules, txns: r.ledger })
          + (dropped ? ' ' + i18nF('{n} unreadable entries were skipped.', { n: dropped }) : '')
        : i18nT('Imported.'));
    } catch (err) { toast(i18nT('Import failed:') + ' ' + err.message, 'err'); }
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
    ? i18nF('A save to this browser failed — storage is full ({size} in use). Export your data, then clear cached charts with "Clear all data" or free space in your browser settings. Until then, new holdings, rules and settings may not survive a reload.', { size })
    : i18nF('Using {size} of this browser’s storage.', { size });
  if (info.quotaHit && !reportStorage.warned) { reportStorage.warned = true; toast(i18nT('Browser storage is full — recent changes may not be saved.'), 'err'); }
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
    $('quotaTxt').textContent = i18nT(market.modeLabel().live ? 'No calls yet.' : 'Demo mode — no API calls.');
    $('quotaSub').textContent = '';
    return;
  }

  const pct = worst && worst.cap ? Math.min(100, (worst.used / worst.cap) * 100) : 0;
  bar.style.width = pct.toFixed(0) + '%';
  bar.classList.toggle('hot', pct >= 80);

  $('quotaTxt').textContent = worst && worst.cap
    ? `${PROVIDER_LABELS[worst.id] || worst.id} ${worst.used}/${worst.cap} ` + i18nT('per min')
    : i18nF('{n} calls in the last minute', { n: totalMin });
  const others = Object.keys(by).length;
  $('quotaSub').textContent = totalHour
    ? i18nF('{n} in the last hour', { n: totalHour }) + (others > 1 ? ' · ' + i18nF('{n} providers', { n: others }) : '')
    : '';
  box.title = Object.entries(by)
    .map(([id, v]) => `${PROVIDER_LABELS[id] || id}: ${perMin(v)}/min${RATE_CEILING[id] ? ' of ' + RATE_CEILING[id] : ''}`)
    .join('\n') || i18nT('No provider calls recorded.');
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
  for (const p of PANELS) { const o = el('option', null, i18nT(p.label)); o.value = p.id; panelSel.appendChild(o); }
  panelSel.addEventListener('change', renderPanelDesc);
  renderPanelDesc();

  fillScreenPicker(safe(() => displays.screens(), []) || []);

  $('dispDetect').addEventListener('click', async () => {
    const list = await displays.detectScreens().catch(() => []);
    fillScreenPicker(list || []);
    renderDisplays();
    if (!list || list.length < 2) toast(i18nT('One monitor detected — panels will open on this screen.'));
  });

  $('dispOpen').addEventListener('click', () => {
    // No await before this call: window.open must run inside the user gesture.
    const res = displays.open($('dispPanel').value, {
      mode: $('dispMode').value,
      screenId: $('dispScreen').value || null,
      // Explicitly null, not omitted: displays.open() reads an omitted `widget` as
      // "keep whatever this panel last drew", so a panel that once hosted a
      // popped-out widget would re-open as that widget while this picker still
      // named the panel. The orphan re-adopt below omits it on purpose.
      widget: null,
    });
    Promise.resolve(res).then((r) => {
      if (!r) return;
      if (r.reason === 'popup-blocked') toast(i18nT('Popup blocked — allow popups for this site, then try again.'), 'err');
      else if (r.reason === 'unknown-panel') toast(i18nT('That panel does not exist.'), 'err');
      renderDisplays();
    }).catch(() => {});
  });

  $('dispReplace').addEventListener('click', () => { displays.rePlaceAll(); renderDisplays(); });
  $('dispCloseAll').addEventListener('click', () => { displays.closeAll(); renderDisplays(); });

  safe(() => displays.onChange(renderDisplays));
}

function renderPanelDesc() {
  const p = PANELS.find((x) => x.id === $('dispPanel').value);
  $('dispPanelDesc').textContent = p ? i18nT(p.desc) : '';
}

function fillScreenPicker(list) {
  state.screens = Array.isArray(list) ? list : [];
  const sel = $('dispScreen');
  const prev = sel.value;
  sel.textContent = '';
  const none = el('option', null, i18nT(state.screens.length ? 'Wherever the browser puts it' : 'This monitor'));
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
    row.append(el('span', 'cap-k', i18nT(k)));
    row.append(el('span', 'cap-v', i18nT(text)));
    caps.appendChild(row);
  }

  const open = safe(() => displays.openPanels(), []) || [];
  const orphans = safe(() => displays.orphanPanels(), []) || [];
  const list = $('dispOpenList');
  list.textContent = '';
  if (!open.length && !orphans.length) {
    list.appendChild(el('p', 'field-note', i18nT('No panels open.')));
  } else {
    for (const p of open) {
      const panel = PANELS.find((x) => x.id === p.panelId);
      const row = el('div', 'disp-row');
      row.append(el('span', 'dr-name', panel ? i18nT(panel.label) : p.panelId));
      row.append(el('span', 'tag ' + (p.alive ? 'live' : 'closed'), i18nT(p.mode === 'pip' ? 'Picture-in-Picture' : 'Window')));
      row.append(el('span', 'dr-where', p.mode === 'pip' ? 'browser-placed' : screenLabel(p.screenId)));
      if (p.placed === false) row.append(el('span', 'tag stale', 'placement ignored'));
      const x = el('button', 'cs-btn', i18nT('Close'));
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
      row.append(el('span', 'dr-name', panel ? i18nT(panel.label) : p.panelId));
      row.append(el('span', 'tag closed', i18nT('Detached')));
      row.append(el('span', 'dr-where', 'opened before this page loaded'));
      const re = el('button', 'cs-btn', i18nT('Re-open'));
      re.title = i18nT('Reconnect to the panel window if it is still open, or open it again if it is not.');
      re.addEventListener('click', () => {
        Promise.resolve(safe(() => displays.open(p.panelId, { mode: p.mode, screenId: p.screenId })))
          .then(() => renderDisplays()).catch(() => {});
      });
      const forget = el('button', 'cs-btn', i18nT('Forget'));
      forget.title = i18nT('Stop listing this panel. Any window still open must be closed from its own controls.');
      forget.addEventListener('click', () => { displays.close(p.panelId); renderDisplays(); });
      row.append(el('span', 'spacer'), re, forget);
      list.appendChild(row);
    }
  }

  const ignored = open.some((p) => p.placed === false);
  const note = $('dispPlaceNote');
  note.hidden = !ignored;
  if (ignored) {
    note.textContent = i18nT('Your desktop ignored the placement request — Wayland and most tiling window managers do not let a '
      + 'web page position windows. Nothing is broken: drag the panel onto the monitor you want and it will stay there.');
  }
}

/* ---- experience level ---------------------------------------------------------
   Beginner / Standard / Pro decides what is OFFERED first — which chart types,
   indicators, alert conditions, portfolio columns and widgets are in front of
   the user — never what data is kept or what is possible: everything gated is
   one click ("Show all widgets", the level switch) away. Changing level never
   moves a widget; the layout templates are applied only on first run or when
   asked for by name. */
function levelNow() { return normalizeLevel(store.settings.level); }

function setLevel(lv, o = {}) {
  const next = normalizeLevel(lv);
  const changed = next !== store.settings.level;
  store.settings.level = next;
  store.settings.levelChosen = true;
  store.saveSettings();
  if (o.layout) safe(() => workspace.reset(next));
  // Widgets build some level-dependent structure once (help icons, columns),
  // so a level change rebuilds them; layout and widget state live on the model.
  else if (changed) safe(() => workspace.relabel());
  paintLevelChrome();
  publishState();
  if (changed && !o.quiet) {
    toast(i18nF('Level set to {level}.', { level: i18nT(LEVELS[next].label) }) + ' '
      + i18nT(o.layout ? 'The layout was replaced with this level’s starting layout.'
        : 'Your widgets stay where they are. “Reset layout” gives you this level’s starting layout.'));
  }
}

function chooseFirstLevel(lv) {
  setLevel(lv, { layout: true, quiet: true });
  $('ackGate').hidden = true;
  $('ackStep1').hidden = false;
  $('ackStep2').hidden = true;
  if (normalizeLevel(lv) === 'beginner' && !store.learn.tourDone) setTimeout(() => startAppTour(), 400);
  else toast(i18nF('Level set to {level}.', { level: i18nT(LEVELS[normalizeLevel(lv)].label) }) + ' '
    + i18nT('Press ? for keyboard shortcuts, or Ctrl+K for the command palette.'));
}

// Someone who acknowledged before levels existed was given 'standard' by the
// store migration. Tell them once where the switch is, rather than re-gating.
function noticeLevel() {
  if (store.settings.levelChosen || store.settings.levelHintShown) return;
  store.settings.levelHintShown = true;
  safe(() => store.saveSettings());
  setTimeout(() => toast(i18nT('New: choose Beginner, Standard or Pro from the level button in the header. It changes what is shown first, never your data.')), 2500);
}

function paintLevelChrome() {
  const lv = levelNow();
  document.body.dataset.level = lv;
  const b = $('btnLevel');
  if (b) {
    setTxt($('btnLevelTxt'), i18nT(LEVELS[lv].label));
    b.title = i18nT('Experience level') + ': ' + i18nT(LEVELS[lv].label) + ' — ' + i18nT(LEVELS[lv].summary);
  }
  const pal = $('btnPalette');
  if (pal) pal.hidden = !levelAllows(lv, 'commandPalette');
  if (levelPick) levelPick.setLevel(lv);
  if (settingsLevelPick) settingsLevelPick.setLevel(lv);
  const sum = $('levelPopSummary'); if (sum) setTxt(sum, i18nT(LEVELS[lv].summary));
  const ssum = $('setLevelSummary'); if (ssum) setTxt(ssum, i18nT(LEVELS[lv].summary));
  const lay = $('levelPopLayout'); if (lay) setTxt(lay, i18nF('Use the {level} starting layout', { level: i18nT(LEVELS[lv].label) }));
}

let levelPick = null, settingsLevelPick = null;
function wireLevel() {
  const btn = $('btnLevel'), pop = $('levelPop');
  if (btn && pop) {
    levelPick = levelPicker(levelNow(), (lv) => setLevel(lv));
    $('levelPopPicker').appendChild(levelPick);
    const close = (focus) => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
    btn.addEventListener('click', () => {
      if (!pop.hidden) { close(false); return; }
      const r = btn.getBoundingClientRect();
      pop.hidden = false;
      const w = pop.offsetWidth;
      pop.style.top = Math.round(r.bottom + 6) + 'px';
      pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      const on = pop.querySelector('[aria-checked="true"]'); if (on) on.focus();
    });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(false); }, true);
    $('levelPopLayout').addEventListener('click', () => {
      const lv = levelNow();
      if (!confirm(i18nT('Discard your tabs and widgets and restore the default workspace?') + '\n' + i18nT('Layout') + ': ' + i18nT(LEVELS[lv].label))) return;
      close(false);
      setLevel(lv, { layout: true, quiet: true });
      toast(i18nT('The layout was replaced with this level’s starting layout.'));
    });
    $('levelPopLearn').addEventListener('click', () => { close(false); openLessons(); });
  }
  // The same switch in Settings, with the three layout templates beside it.
  const host = $('setLevelPicker');
  if (host) {
    settingsLevelPick = levelPicker(levelNow(), (lv) => setLevel(lv));
    host.appendChild(settingsLevelPick);
  }
  for (const b of document.querySelectorAll('[data-layout-level]')) {
    b.addEventListener('click', () => {
      const lv = b.dataset.layoutLevel;
      if (!confirm(i18nT('Discard your tabs and widgets and restore the default workspace?') + '\n' + i18nT('Layout') + ': ' + i18nT(LEVELS[lv].label))) return;
      safe(() => workspace.reset(lv));
      toast(i18nF('{level} layout restored. Your level is still {current}.', { level: i18nT(LEVELS[lv].label), current: i18nT(LEVELS[levelNow()].label) }));
    });
  }
  paintLevelChrome();
}

/* ---- learning -----------------------------------------------------------------
   learn.js never touches storage; the store's learn section is handed to it here. */
function wireLearn() {
  learnConfigure({
    seen: () => store.learn.seen,
    onSeen: (id) => { safe(() => store.markSeen(id)); },
    level: () => levelNow(),
  });
  const b = $('btnLearn');
  if (b) b.addEventListener('click', () => openLessons());
  // Warm the glossary so the first '?' popover is instant and the palette can
  // search terms on its first opening.
  const warm = () => safe(() => loadGlossary().then((m) => { glossaryForPalette = m; }));
  setTimeout(warm, 1500);
  window.addEventListener('carino:langchange', warm);
}

/* The first-run tour points at the real controls. Steps whose target is hidden
   (the rail on a phone, the API meter in demo mode) are skipped by startTour. */
function startAppTour() {
  closeModal();
  if (drawerIsOpen()) closeDrawer();
  const steps = [
    { title: i18nT('Welcome to Carino Stocks'), body: i18nT('A one-minute tour of the screen. Stocks shows prices, charts and your own portfolio — it never trades and gives no advice. You can replay this from Learn.') },
    { target: '#modeChip', title: i18nT('Where prices come from'), body: i18nT('DEMO means bundled sample data. With your own free API key it shows the provider, and whether prices are live or delayed.') },
    { target: '#railList', title: i18nT('Your watchlist'), body: i18nT('The symbols you follow. Click one to show it in the chart and other linked widgets; double-click for full details.') },
    { target: '#railSearch', title: i18nT('Add a symbol'), body: i18nT('Type a ticker such as AAPL, a crypto like BTC, or a currency pair like EURUSD.') },
    { target: '.wk-tabs', title: i18nT('Tabs and widgets'), body: i18nT('Each tab holds widgets you can move, resize, add or remove. Nothing you do here can be lost from the data.') },
    { target: '#sessChip', title: i18nT('Is the market open?'), body: i18nT('Pre-market, open, after hours or closed, from this device’s clock and the exchange calendar.') },
    { target: '#btnAlerts', title: i18nT('Alerts'), body: i18nT('Get a notification when a price crosses a level you choose. Alerts only run while a Stocks tab is open.') },
    { target: '#btnHoldings', title: i18nT('Your portfolio'), body: i18nT('Record what you own to see its value and gains. Entered by hand or imported from a broker CSV; never connected to an account.') },
    { target: '#btnLearn', title: i18nT('Learn as you go'), body: i18nT('Short lessons and a glossary. Every “?” next to a term opens its explanation.') },
    { target: '#btnLevel', title: i18nT('Your experience level'), body: i18nT('Beginner keeps things simple. Switch to Standard or Pro any time for more charts, alerts and tools.') },
  ];
  startTour(steps, {
    onEnd: () => { store.learn.tourDone = true; safe(() => store.saveLearn()); },
  });
}

/* ---- command palette + shortcuts ------------------------------------------------ */
let palette = null;
function paletteCommands() {
  const C = [];
  const add = (group, label, run, extra = {}) => C.push({ group, label, run, ...extra });
  const lv = levelNow();
  // Watchlist first: the most common thing to jump to.
  for (const sym of sortedWatchlist()) {
    const p = store.profiles[sym];
    add('Watchlist', sym + (p && p.name ? ' — ' + p.name : ''), () => goSymbol(sym), { keywords: 'go symbol' });
  }
  const tabs = safe(() => workspace.tabs(), []) || [];
  tabs.forEach((t, i) => add('Tabs', i18nT('Switch to tab') + ': ' + i18nT(t.name), () => workspace.setActiveTab(t.id), { hint: i < 9 ? String(i + 1) : '' }));
  add('Open', i18nT('Alert rules'), () => openAlerts(state.selection || store.watchlist[0] || ''), { hint: 'A' });
  add('Open', i18nT('Transactions'), () => ledgerUI && ledgerUI.open(), { hint: 'T' });
  add('Open', i18nT('Add a transaction'), () => ledgerUI && ledgerUI.openTxn(null), { keywords: 'buy sell dividend holding' });
  add('Open', i18nT('Import a broker CSV'), () => ledgerUI && ledgerUI.openImport(), { keywords: 'csv import broker' });
  add('Open', i18nT('Settings'), () => openSettings(), { hint: ',' });
  add('Open', i18nT('Data providers and API usage'), () => openSettings('dataSection'), { keywords: 'quota limits keys provider' });
  add('Open', i18nT('Detached displays'), () => openSettings('displaysSection'), { keywords: 'popout window monitor' });
  add('Learn', i18nT('Lessons'), () => openLessons(), { hint: 'L' });
  add('Learn', i18nT('Glossary'), () => openGlossary(), { hint: 'G' });
  add('Learn', i18nT('Take the guided tour'), () => startAppTour());
  add('Learn', i18nT('Keyboard shortcuts'), () => palette && palette.openShortcuts(), { hint: '?' });
  add('Actions', i18nT(store.settings.privacy ? 'Show amounts' : 'Blur amounts (privacy)'), () => { setPrivacy(!store.settings.privacy); publishState(); }, { hint: 'P' });
  add('Actions', i18nT(scheduler && scheduler.isPaused() ? 'Resume auto-refresh' : 'Pause auto-refresh'), () => $('btnPause').click(), { hint: '⇧P' });
  add('Actions', i18nT('Refresh quotes now'), () => scheduler && scheduler.now(), { hint: 'R' });
  add('Actions', i18nT('Add a symbol to the watchlist'), () => $('btnAdd').click());
  add('Actions', i18nT('Export my data'), () => doExport(), { keywords: 'backup json' });
  for (const id of LEVEL_ORDER) {
    if (id !== lv) add('Level', i18nF('Switch to {level} level', { level: i18nT(LEVELS[id].label) }), () => setLevel(id), { keywords: 'experience beginner standard pro' });
  }
  for (const id of LEVEL_ORDER) {
    add('Level', i18nF('Reset layout to the {level} template', { level: i18nT(LEVELS[id].label) }), () => {
      if (confirm(i18nT('Discard your tabs and widgets and restore the default workspace?'))) safe(() => workspace.reset(id));
    }, { keywords: 'layout template workspace' });
  }
  for (const w of WIDGETS) {
    if (!w || !w.id) continue;
    add('Add widget', i18nT('Add widget') + ': ' + i18nT(w.label || w.id), () => workspace.addWidget(w.id), { keywords: i18nT(w.desc || ''), searchOnly: true });
  }
  // Glossary terms are searchable but not listed until something is typed.
  const g = glossaryForPalette;
  if (g) for (const t of Object.values(g)) add('Glossary', i18nT('Explain') + ': ' + t.term, () => openGlossary(t.id), { keywords: t.termEn + ' ' + t.id, searchOnly: true });
  return C;
}
let glossaryForPalette = null;

function goSymbol(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return;
  selectSymbol(s);
  openDrawer(s);
}

function wirePalette() {
  palette = initPalette({
    commands: () => paletteCommands(),
    goSymbol,
    searchSymbols: (q) => market.search(q),
    actions: {
      search: () => {
        if (safe(() => matchMedia('(max-width: 900px)').matches, false)) setRailOpen(true);
        $('railSearch').focus();
      },
      alerts: () => openAlerts(state.selection || store.watchlist[0] || ''),
      ledger: () => ledgerUI && ledgerUI.open(),
      lessons: () => openLessons(),
      glossary: () => openGlossary(),
      settings: () => openSettings(),
      details: () => { const s = state.selection || store.watchlist[0]; if (s) openDrawer(s); },
      tab: (e) => { const t = (safe(() => workspace.tabs(), []) || [])[Number(e.key) - 1]; if (t) workspace.setActiveTab(t.id); },
      widget: () => safe(() => workspace.openPicker()),
      privacy: () => { setPrivacy(!store.settings.privacy); publishState(); },
      refresh: () => { if (scheduler) { scheduler.now(); toast(i18nT('Refreshing quotes…')); } },
      pause: () => $('btnPause').click(),
    },
  });
  const b = $('btnPalette');
  if (b) b.addEventListener('click', () => palette.open());
  const k = $('btnKeys');
  if (k) k.addEventListener('click', () => palette.openShortcuts());
}

/* ---- data & providers panel ------------------------------------------------------
   What each provider can supply, how fresh it is, how much of its free tier this
   browser has used, and the last thing that went wrong — in one table, because
   "why is this number old?" is the question a monitoring tool must answer. */
const PROVIDER_CAPS = {
  finnhub: { quotes: true, candles: false, fundamentals: true, news: true, events: true,
    quality: 'Near real-time US stock quotes on the free plan. No historical candles on the free plan, so charts route to another provider.' },
  twelvedata: { quotes: true, candles: true, fundamentals: true, news: false, events: false,
    quality: 'Real-time for US equities where licensed, otherwise delayed. Also covers FX and crypto. Each symbol in a batch costs one credit.' },
  polygon: { quotes: true, candles: true, fundamentals: true, news: true, events: true,
    quality: 'Free plan: delayed and end-of-day data, 5 calls a minute. No 52-week figures or beta.' },
  alpaca: { quotes: true, candles: true, fundamentals: false, news: true, events: false,
    quality: 'Free feed is the IEX exchange only — about 2% of US volume — so prices can differ from the consolidated tape.' },
  alphavantage: { quotes: true, candles: true, fundamentals: true, news: true, events: true,
    quality: 'Mostly end-of-day on the free plan, and only 25 calls a day: best for fundamentals and history, not live watching.' },
  coingecko: { quotes: true, candles: true, fundamentals: true, news: false, events: false,
    quality: 'Crypto only, no key needed. Prices refresh every one to two minutes; history is limited to 365 days.' },
  demo: { quotes: true, candles: true, fundamentals: true, news: true, events: true,
    quality: 'Synthetic sample data bundled with the app. Never real prices — for trying the tool only.' },
};
const ERR_LABEL = {
  authError: 'Key rejected', rateLimited: 'Rate limited', network: 'Unreachable', timeout: 'Timed out',
  premium: 'Needs a paid plan', notCached: 'Not cached', error: 'Error',
};

function renderProviderPanel() {
  const host = $('provTable');
  if (!host) return;
  const rows = safe(() => market.limits(), []) || [];
  const pro = levelAllows(levelNow(), 'providerDiagnostics');
  host.textContent = '';
  const tbl = el('table', 'prov-tbl');
  const cap = el('caption', 'sr-only', i18nT('Data providers: what each one supplies and how much of its free tier is used'));
  const head = el('tr');
  for (const h of ['Provider', 'Status', 'Supplies', 'This minute', 'Today']) { const th = el('th', null, i18nT(h)); th.scope = 'col'; head.append(th); }
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  const meter = (used, max) => {
    const box = el('div', 'prov-meter');
    if (!max) { box.append(el('span', 'prov-n', used ? String(used) : '—')); return box; }
    const pct = Math.min(100, (used / max) * 100);
    const bar = el('div', 'progress'); const fill = el('div', 'progress-bar' + (pct >= 80 ? ' hot' : ''));
    fill.style.width = pct.toFixed(0) + '%'; bar.append(fill);
    bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(max)); bar.setAttribute('aria-valuenow', String(used));
    box.append(bar, el('span', 'prov-n', used + ' / ' + max));
    return box;
  };
  for (const r of rows) {
    const caps = PROVIDER_CAPS[r.id] || {};
    const tr = el('tr');
    const name = el('th', 'prov-name'); name.scope = 'row';
    name.append(el('strong', null, PROVIDER_LABELS[r.id] || r.label || r.id));
    if (caps.quality) name.append(el('span', 'prov-q', i18nT(caps.quality)));
    if (r.note) name.append(el('span', 'prov-q', i18nT('Free tier') + ': ' + i18nT(r.note)));
    const err = r.lastError;
    let status, cls;
    if (err) { status = i18nT(ERR_LABEL[err.kind] || 'Error') + ' · ' + fmtTime(err.at); cls = err.kind === 'authError' ? 'bad' : 'warn'; }
    else if (r.needsKey && !r.available) { status = i18nT('No key'); cls = 'off'; }
    else if (r.usedHour || r.usedDay) { status = i18nT('OK'); cls = 'ok'; }
    else { status = r.id === 'demo' ? i18nT('Built in') : i18nT('Ready'); cls = 'idle'; }
    const st = el('td'); st.append(el('span', 'prov-st ' + cls, status));
    if (pro && err && err.message) st.append(el('code', 'prov-raw', err.message));
    if (pro && r.queued) st.append(el('span', 'prov-q', r.queued + ' ' + i18nT('queued')));
    if (pro && r.cooldownUntil > Date.now()) st.append(el('span', 'prov-q', i18nT('cooling down') + ' ' + Math.ceil((r.cooldownUntil - Date.now()) / 1000) + 's'));
    const sup = el('td', 'prov-caps');
    for (const [k, lbl] of [['quotes', 'Quotes'], ['candles', 'Charts'], ['fundamentals', 'Fundamentals'], ['news', 'News'], ['events', 'Events']]) {
      sup.append(el('span', 'prov-cap' + (caps[k] ? ' on' : ''), (caps[k] ? '✓ ' : '✕ ') + i18nT(lbl)));
    }
    const m1 = el('td'); m1.append(meter(r.usedMin || 0, r.perMin));
    const m2 = el('td'); m2.append(meter(r.usedDay || 0, r.perDay));
    tr.append(name, st, sup, m1, m2);
    tbody.append(tr);
  }
  tbl.append(cap, thead, tbody);
  const wrap = el('div', 'prov-wrap'); wrap.append(tbl);
  host.append(wrap);
}
let provTimer = 0;
function startProviderPanel() {
  renderProviderPanel();
  clearInterval(provTimer);
  // Live while Settings is open, so a burst of calls is visible as it happens.
  provTimer = setInterval(() => { if ($('settingsModal').hidden || $('modalScrim').hidden) { clearInterval(provTimer); return; } renderProviderPanel(); }, 2000);
}

/* ---- alerts modal ----------------------------------------------------------
   Built from the ALERT_TYPES registry in alerts-ui.js. openAlerts(sym, prefill)
   keeps its signature: prefill {type, op, value} comes from a chart's "Alert at
   this price" and from the calculator's stop and target buttons. */
function openAlerts(sym, prefill) { if (alertsUI) alertsUI.open(sym, prefill); }
function renderRuleList() { if (alertsUI) alertsUI.renderRules(); }
function renderAlertLog() { if (alertsUI) alertsUI.renderLog(); }

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
  if (state.fetchError) { chip.textContent = i18nT('ERROR'); chip.classList.remove('live'); chip.title = state.fetchError; return; }
  const m = market.modeLabel();
  chip.textContent = m.text; chip.classList.toggle('live', m.live);
  chip.title = i18nT('Data source') + (leaderless ? ' · ' + i18nT('refreshing independently: no window holds the shared lock') : '');
}
/* i18n.js re-applies the static markup, the attribute table and the three
   boot-filled ids, but everything this file and the widgets build from JS keeps
   whatever locale it was created in. i18n.js registered its own listener first
   (deferred classic script, ahead of this module), so t() already resolves to
   the new language by the time this handler runs. Deliberately not refreshAll():
   a language switch must not trigger a provider poll. */
function wireLangSwitch() {
  window.addEventListener('carino:langchange', () => {
    safe(() => workspace.relabel());
    renderRail();
    safe(() => alertsUI && alertsUI.relabel());
    updateModeChip();
    renderMarketStrip();
    renderSession();
    paintLevelChrome();
    if (!$('settingsModal').hidden) renderProviderPanel();
    if (drawerSym) renderDrawer();
    if (ledgerUI && ledgerUI.isOpen()) ledgerUI.render();
  });
}

function refreshAll() {
  renderRail(); refreshWidgets(); updateModeChip(); renderMarketStrip(); renderSession(); refreshDrawer();
  if (ledgerUI && ledgerUI.isOpen()) ledgerUI.render();
  publishState();
  scheduler && scheduler.now();
}

/* ---- formatters -------------------------------------------------------------
   Numbers are formatted in format.js, which this file imports rather than
   reimplements. Only the FX decision lives here, because it is the one part that
   needs app state: whether a symbol is a ratio rather than an amount of money is
   a question about the routed market, and format.js is deliberately stateless.
   Bytes stay local — the storage note is the only caller in the app. */
const fxOpts = (sym) => ({ fx: safe(() => marketForSymbol(sym, state.quotes[sym]) === 'FX', false) });

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' bytes';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
