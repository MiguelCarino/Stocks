/* peers.js — one mesh for every Stocks window: the main tab, duplicate tabs and
   every popout. Exactly one member is leader; only the leader is allowed to
   fetch quotes and evaluate alerts, and it publishes what it learns to the rest.

   Two concrete bugs justify the machinery. First, alert evaluation writes the
   `_latched` edge flag into stk_rules, so two open tabs each latch, each fire and
   each log the same alert — single-writer leadership removes the duplicate by
   construction. Second, the scheduler pauses on document.hidden, which means the
   instant the user turns to a popout on another monitor the main window stops
   polling and every panel silently freezes while still looking live; a visibility
   census lets polling continue while ANY window in the mesh is visible.

   Leadership is a Web Lock, not a heartbeat. The browser releases an exclusive
   lock when the holding window dies — crash, kill, close, navigate — so there is
   no beat to tune, no lease to expire and no split-brain window in which two
   windows both believe they lead.

   Two consequences of that choice are load-bearing and easy to lose. A popout
   never asks for the lock at all: it has no provider, no fetch and no alert
   pass, so a popout that won the election would be a leader that never leads
   and the whole app would stop polling for as long as the panel stayed open.
   And a lock is released when the page is frozen for the back/forward cache
   while the JS heap survives, so leadership is dropped on pagehide and asked
   for again on pageshow — a restored page that still believed it led would
   fetch and fire alerts alongside the window that legitimately leads now. */

const CHANNEL_NAME = 'stk';
const LOCK_NAME = 'stk-leader';
const FRAME_KEY = 'stk_lastframe';

const CENSUS_MS = 5000;        // own-state re-announce; visible windows are not timer-throttled
const VISIBLE_TTL = 20000;     // a peer must have re-announced this recently to count as visible
const PEER_TTL = 90000;        // presence only: hidden tabs get their timers clamped hard
const FRAME_WRITE_MS = 4000;   // localStorage is synchronous — never write it per tick
const LEADER_WAIT_MS = 300;    // bound how long init() waits for the lock to settle
const YIELD_COOLDOWN_MS = 30000; // floor between two attempts to hand leadership on

const hasBC = typeof BroadcastChannel === 'function';
const hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);

const winId = makeId();
const handlers = new Map();    // type -> Set<fn>
const seen = new Map();        // peer id -> { role, vis, at, seq, leader }

let channel = null;
let role = 'main';
let started = null;            // the init() promise, so init is idempotent
let leader = false;
let releaseLock = null;        // resolves the promise that holds the Web Lock
let pendingClaim = null;       // { token, ctl } while a request sits in the queue
let yieldedAt = 0;
let seq = 0;
let census = null;
let frame = null;              // last 'quotes' payload seen, whoever produced it
let frameWrittenAt = 0;
let frameWriteTimer = null;

function makeId() {
  try {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* insecure context or ancient engine */ }
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function visibility() {
  try { return document.visibilityState === 'visible' ? 'visible' : 'hidden'; }
  catch (e) { return 'hidden'; }
}

function post(type, payload) {
  if (!channel) return;
  // Visibility and leadership ride along on every message, so the census costs
  // no extra traffic and a window that joins after the election still learns
  // within one ping who leads.
  try { channel.postMessage({ v: 1, id: winId, seq: ++seq, ts: Date.now(), role, vis: visibility(), ldr: leader, type, payload }); }
  catch (e) { /* channel closed mid-teardown, or an unstructured-cloneable payload */ }
}

function emit(type, payload, meta) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload, meta); } catch (e) { /* one bad subscriber must not stop the others */ }
  }
}

function note(msg) {
  const rec = seen.get(msg.id) || { seq: -1, leader: false };
  rec.role = msg.role || 'main';
  rec.vis = msg.vis || 'hidden';
  rec.at = Date.now();
  rec.seq = msg.seq;
  if (typeof msg.ldr === 'boolean') rec.leader = msg.ldr;
  seen.set(msg.id, rec);
}

function onMessage(ev) {
  const msg = ev && ev.data;
  if (!msg || msg.v !== 1 || !msg.id || msg.id === winId || typeof msg.type !== 'string') return;

  const prev = seen.get(msg.id);
  // Sequence numbers are per-window and reset only with a new window id, so a
  // stale frame overtaking a fresh one is discarded rather than painted.
  if (prev && typeof msg.seq === 'number' && msg.seq <= prev.seq && msg.type !== 'bye') return;
  note(msg);

  if (msg.type === 'bye') { seen.delete(msg.id); }
  else if (msg.type === 'hello') { post('ping', null); } // answer newcomers; 'ping' never answers back
  else if (msg.type === 'quotes' && msg.payload) { frame = msg.payload; persistFrame(); }

  // `vis` is the SENDER's visibility. A subscriber that knows the publisher is
  // in the background also knows its timers are clamped, which is the honest
  // explanation for a frame that arrives a minute late instead of every 15s.
  emit(msg.type, msg.payload, { from: msg.id, seq: msg.seq, ts: msg.ts, role: msg.role, vis: msg.vis, type: msg.type });
}

/* The frame cache exists so a cold popout paints prices instead of dashes before
   the leader's next tick. It is a convenience, never a source of truth, and a
   failed write (quota, private mode) is not worth reporting. */
function writeFrame() {
  frameWriteTimer = null;
  frameWrittenAt = Date.now();
  try { localStorage.setItem(FRAME_KEY, JSON.stringify({ ts: frameWrittenAt, by: winId, frame })); }
  catch (e) { /* quota or storage disabled */ }
}

function persistFrame() {
  if (frameWriteTimer) return;
  const due = FRAME_WRITE_MS - (Date.now() - frameWrittenAt);
  if (due <= 0) writeFrame();
  else frameWriteTimer = setTimeout(writeFrame, due);
}

function readFrame() {
  try {
    const raw = localStorage.getItem(FRAME_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && rec.frame ? rec.frame : null;
  } catch (e) { return null; }
}

/* A popout returns here without asking for anything: no lock, no fail-open, no
   leadership under any condition. It is a pure receiver, so a popout holding the
   election result would mean nobody fetches at all — and app.js's watchdog
   cannot see that, because the lock genuinely is held. */
function claimLeadership() {
  if (role === 'popout') return Promise.resolve();
  if (leader || pendingClaim) return Promise.resolve();
  if (!hasLocks) { leader = true; return Promise.resolve(); }

  const token = {};
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  pendingClaim = { token, ctl };

  return new Promise((granted) => {
    // Any failure to even ask for the lock is treated as "no coordination
    // available" and fails open: a window that never leads never polls. A claim
    // this window abandoned on purpose is not a failure and must not fail open.
    const failOpen = () => {
      if (!pendingClaim || pendingClaim.token !== token) return;
      pendingClaim = null;
      leader = true;
      peers.degraded = true;
      granted();
    };
    const opts = { mode: 'exclusive' };
    if (ctl) opts.signal = ctl.signal;
    try {
      navigator.locks.request(LOCK_NAME, opts, () => new Promise((release) => {
        pendingClaim = null;
        leader = true;
        releaseLock = release;   // held until this window goes away or yields
        granted();
        post('state', { leader: true });
      })).catch(failOpen);
    } catch (e) { failOpen(); }
  });
}

function releaseLeadership() {
  leader = false;
  const release = releaseLock;
  releaseLock = null;
  if (release) { try { release(); } catch (e) { /* already settled */ } }
}

/* A queued request from a page the browser has frozen is worse than no request:
   the lock is granted to a callback that will never run, and every live window
   waits behind it. Withdrawing the claim before the freeze keeps the queue
   grantable. */
function abortClaim() {
  const claim = pendingClaim;
  pendingClaim = null;
  if (claim && claim.ctl) { try { claim.ctl.abort(); } catch (e) { /* already settled */ } }
}

function visibleMainPeer() {
  const now = Date.now();
  for (const rec of seen.values()) {
    if (rec.role === 'main' && rec.vis === 'visible' && now - rec.at < VISIBLE_TTL) return true;
  }
  return false;
}

/* The census keeps a hidden leader polling for the sake of a visible popout, but
   it cannot keep that leader's clock: the timer chain lives in the window that
   holds the lock, and a browser clamps a hidden window's timers to roughly one
   run per minute however short the configured interval is. So when a hidden
   leader can see a visible ORDINARY window, it steps aside — the lock is
   re-requested in the same breath, which means an actually-waiting window is
   granted it and a mesh where nobody was waiting hands it straight back. A
   visible popout is not a candidate: it would never fetch. */
function reviewLeadership() {
  if (role !== 'main' || !hasLocks) return;
  if (visibility() === 'visible') { claimLeadership(); return; }
  if (!leader || !releaseLock || !visibleMainPeer()) return;
  if (Date.now() - yieldedAt < YIELD_COOLDOWN_MS) return;
  yieldedAt = Date.now();
  releaseLeadership();
  post('state', { leader: false });
  claimLeadership();
}

function startCensus() {
  if (census) return;
  census = setInterval(() => {
    for (const [id, rec] of seen) if (Date.now() - rec.at > PEER_TTL) seen.delete(id);
    post('ping', null);
    reviewLeadership();
  }, CENSUS_MS);
}

function teardown() {
  if (frameWriteTimer) { clearTimeout(frameWriteTimer); writeFrame(); }
  post('bye', null);
  clearInterval(census);
  census = null;
  // Both halves matter on a bfcache freeze: the heap survives, so a page that
  // kept `leader` true would come back believing it leads a mesh that has since
  // elected someone else, and both would fetch and fire the same alerts.
  releaseLeadership();
  abortClaim();
  try { if (channel) channel.close(); } catch (e) { /* already closed */ }
  channel = null;
}

// Only ever reached with a bfcache restore: the page was torn down on pagehide
// but never unloaded, so the mesh has to be re-entered from a live heap.
function restore() {
  openChannel();
  startCensus();
  seen.clear();
  post('hello', { role });
  claimLeadership();
}

function openChannel() {
  if (channel || !hasBC) return;
  try { channel = new BroadcastChannel(CHANNEL_NAME); channel.onmessage = onMessage; }
  catch (e) { channel = null; peers.degraded = true; }
}

export const peers = {
  id: winId,
  // True when this window cannot coordinate at all and is deliberately acting as
  // if it were the only one open: leadership is assumed, alerts may double-fire
  // across tabs exactly as they did before. Honest, not silent.
  degraded: !hasLocks || !hasBC,

  async init(r) {
    if (started) return started;
    role = r === 'popout' ? 'popout' : 'main';
    frame = readFrame();
    // A popout is never a candidate, so a missing Lock API costs it nothing.
    if (role === 'popout') peers.degraded = !hasBC;

    openChannel();

    try {
      addEventListener('visibilitychange', () => { post('ping', null); reviewLeadership(); });
      addEventListener('pagehide', teardown);
      addEventListener('beforeunload', teardown);
      addEventListener('pageshow', (e) => { if (e && e.persisted) restore(); });
    } catch (e) { /* no window events: still usable, just less tidy on exit */ }

    startCensus();

    post('hello', { role });

    // Resolve once leadership is decided, so the first scheduler tick is not
    // skipped by a solo window that simply had not been granted the lock yet.
    // A popout has nothing to decide and must not sit out the wait.
    started = role === 'popout'
      ? Promise.resolve()
      : Promise.race([claimLeadership(), new Promise((r2) => setTimeout(r2, LEADER_WAIT_MS))]);
    await started;
    return started;
  },

  isLeader() { return leader; },

  // Whether anyone in the mesh — this window or an announced peer — currently
  // claims leadership. app.js diagnoses a stranded lock with navigator.locks
  // .query(), which reports a holder that has been frozen or bfcached as very
  // much alive; a peer that has stopped announcing itself has not.
  leaderKnown() {
    if (leader) return true;
    const now = Date.now();
    for (const rec of seen.values()) if (rec.leader && now - rec.at < PEER_TTL) return true;
    return false;
  },

  anyVisible() {
    if (visibility() === 'visible') return true;
    const now = Date.now();
    for (const rec of seen.values()) if (rec.vis === 'visible' && now - rec.at < VISIBLE_TTL) return true;
    return false;
  },

  count() {
    const now = Date.now();
    let n = 1;
    for (const rec of seen.values()) if (now - rec.at < PEER_TTL) n++;
    return n;
  },

  broadcast(type, payload) {
    // Quote frames are the leader's output. A popout that echoed one back would
    // turn every tick into an N-way storm, so the mesh refuses to carry it.
    if (type === 'quotes') {
      if (role === 'popout') return;
      if (payload) { frame = payload; persistFrame(); }
    }
    post(type, payload);
  },

  on(type, handler) {
    if (typeof handler !== 'function') return;
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
  },

  off(type, handler) {
    const set = handlers.get(type);
    if (set) set.delete(handler);
  },

  lastFrame() { return frame; },
};
