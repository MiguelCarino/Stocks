/* alerts-ui.js — the Alert rules dialog.

   The form is generated from the ALERT_TYPES registry rather than written by
   hand: each condition brings its own parameters (an SMA period, a Bollinger
   width), the comparisons that make sense for it, its unit and its glossary
   entry. The type list follows the experience level, so a beginner sees price,
   day change and new 52-week highs, and a pro sees MACD crosses and ATR moves;
   a rule of a higher level that already exists keeps working and stays
   editable.

   Before a rule is saved, the dialog measures it once against the live quote
   (and cached daily bars, for technical conditions) and says what the number is
   right now and whether the rule would fire on this poll. A rule that cannot be
   measured yet says so instead of looking armed and silent.

   Alerts notify. They never place or suggest an order. */

import { ALERT_TYPES, ALERT_GROUPS, OP_LABEL, PORTFOLIO_SYMBOL, paramsFor, describeRule, formatMetric, typesForLevel, liveSeries, isCrossOp } from './alerttypes.js';
import { helpIcon, learnIdFor, levelAllows } from './learn.js';
import { normalizeSessions, mintId } from './store.js';
import { fmtTime, fmtNum, fmtPrice } from './format.js';
import { csvCell } from './folio.js';

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fb = null) => { try { return fn(); } catch (e) { return fb; } };
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

const SESSION_SCOPES = { regular: ['open'], extended: ['pre', 'open', 'post'], any: [] };
const SCOPE_LABEL = { regular: 'Regular hours', extended: 'Extended hours', any: 'Any session' };
const SCOPE_TIP = {
  regular: 'Only while regular hours are open.',
  extended: 'Pre-market, regular hours and after hours.',
  any: 'Every session, including while the market is closed.',
};
const DISARM_LABEL = { fired: 'Fired once — switched off', expired: 'Expired', unsupported: 'Not supported by this version' };

export function scopeOf(rule) {
  const s = rule && rule.sessions;
  if (!Array.isArray(s) || !s.length) return 'any';
  return s.length === 1 && s[0] === 'open' ? 'regular' : 'extended';
}

/* deps: {store, openModal(id, after), toast, quotes(), sessionFor(sym), marketFor(sym),
   routeQuote(sym), extHours: {pid: bool|null}, providerLabels, level(), heldSymbols(),
   dailyFor(sym), ensureBars(sym) -> Promise, fundFor(sym), ensureFund(sym),
   portfolioTotals(), onChange(), downloadFile(name, mime, text), fxOpts(sym)} */
export function initAlertsUI(deps) {
  const { store } = deps;
  let editingId = null;
  let logFilter = '', logRange = '', ruleFilter = '';
  let barsAsked = new Set();

  /* ---- form ------------------------------------------------------------------ */
  function open(sym, prefill) {
    deps.openModal('alertsModal', () => {
      editingId = null;
      fillSymbols(sym);
      fillTypes(prefill && prefill.type ? prefill.type : 'price');
      $('ruleSess').value = 'regular';
      $('ruleRepeat').value = 'rearm';
      $('ruleExpires').value = '';
      $('ruleNote').value = '';
      $('ruleMore').open = false;
      syncType();
      if (prefill && fin(Number(prefill.value))) {
        const v = Number(prefill.value);
        const q = (deps.quotes() || {})[sym];
        const last = q && q.price;
        $('ruleOp').value = prefill.op || (fin(last) && v < last ? 'below' : 'above');
        $('ruleVal').value = String(Number(v.toPrecision(8)));
        setTimeout(() => safe(() => $('ruleVal').focus({ preventScroll: true })), 30);
      }
      paintFormMode();
      updatePreview();
      renderRules();
      renderLog();
    });
  }

  function fillSymbols(sym) {
    const sel = $('ruleSym');
    const prev = sym || sel.value;
    sel.textContent = '';
    const syms = [...new Set([...(store.watchlist || []), ...deps.heldSymbols(), ...store.rules.map((r) => r.symbol), sym]
      .filter((s) => s && s !== PORTFOLIO_SYMBOL))];
    for (const s of syms) { const o = el('option', null, s); o.value = s; sel.appendChild(o); }
    if (levelAllows(deps.level(), 'alerts.portfolio')) {
      const o = el('option', null, i18nT('Portfolio (all holdings)')); o.value = PORTFOLIO_SYMBOL; sel.appendChild(o);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  // The level decides what is offered; an existing rule's own type is always kept.
  function fillTypes(selected, keepType) {
    const sel = $('ruleType');
    const isPort = $('ruleSym').value === PORTFOLIO_SYMBOL;
    const allowed = new Set(typesForLevel(deps.level()));
    if (keepType) allowed.add(keepType);
    sel.textContent = '';
    for (const g of ALERT_GROUPS) {
      const ids = Object.values(ALERT_TYPES).filter((d) => d.group === g && allowed.has(d.id) && (d.needs === 'portfolio') === isPort);
      if (!ids.length) continue;
      const og = document.createElement('optgroup');
      og.label = i18nT(g);
      for (const d of ids) { const o = el('option', null, i18nT(d.label)); o.value = d.id; og.appendChild(o); }
      sel.appendChild(og);
    }
    if (selected && [...sel.options].some((o) => o.value === selected)) sel.value = selected;
    else if (sel.options.length) sel.value = sel.options[0].value;
  }

  function currentDef() { return ALERT_TYPES[$('ruleType').value] || null; }

  function syncType(keep) {
    const def = currentDef();
    const help = $('ruleTypeHelp');
    help.textContent = '';
    if (!def) return;
    const gid = learnIdFor('alerts', def.id) || def.learn;
    if (gid) { const h = safe(() => helpIcon(gid)); if (h) help.appendChild(h); }
    // Parameters.
    const box = $('ruleParams');
    const prevParams = keep || {};
    box.textContent = '';
    box.hidden = !def.params.length;
    for (const p of def.params) {
      const f = el('label', 'field al-param');
      f.appendChild(el('span', null, i18nT(p.label)));
      const inp = el('input', 'input');
      inp.type = 'number'; inp.step = 'any';
      if (p.min != null) inp.min = String(p.min);
      if (p.max != null) inp.max = String(p.max);
      inp.value = String(prevParams[p.key] != null ? prevParams[p.key] : p.def);
      inp.dataset.key = p.key;
      inp.addEventListener('input', updatePreview);
      f.appendChild(inp);
      box.appendChild(f);
    }
    // Comparisons.
    const op = $('ruleOp');
    const was = op.value;
    op.textContent = '';
    for (const o of def.ops) { const opt = el('option', null, i18nT(OP_LABEL[o] || o)); opt.value = o; op.appendChild(opt); }
    if (def.ops.includes(was)) op.value = was;
    // Value and its unit.
    const fixed = def.fixedValue != null;
    $('ruleVal').closest('.field').hidden = fixed;
    op.closest('.field').hidden = fixed && def.ops.length === 1;
    const sym = $('ruleSym').value;
    const q = (deps.quotes() || {})[sym];
    $('ruleUnit').textContent = def.unit === 'pct' ? '%' : def.unit === 'x' ? '×' : def.unit === 'price' ? ((q && q.currency) || '') : '';
    const valLbl = def.unit === 'price' ? 'Price' : def.id === 'rsi' ? 'RSI level (0–100)' : def.unit === 'pct' ? 'Percent' : def.unit === 'x' ? 'Multiple' : 'Value';
    $('ruleValLbl').dataset.i18nKey = valLbl;
    $('ruleValLbl').textContent = i18nT(valLbl);
    if (!keep && !fixed) {
      const m = measure(draftRule());
      const def0 = def.defValue != null ? def.defValue : fin(m.value) ? Number(m.value.toPrecision(6)) : '';
      $('ruleVal').value = def0 === '' ? '' : String(def0);
    }
    updateSessionNote();
    updatePreview();
  }

  function readParams() {
    const def = currentDef();
    const out = {};
    if (!def) return out;
    for (const inp of $('ruleParams').querySelectorAll('input[data-key]')) {
      const p = def.params.find((x) => x.key === inp.dataset.key);
      let v = Number(inp.value);
      if (!fin(v)) v = p ? p.def : 0;
      if (p && p.min != null) v = Math.max(p.min, v);
      if (p && p.max != null) v = Math.min(p.max, v);
      out[inp.dataset.key] = v;
    }
    return out;
  }

  function draftRule() {
    const def = currentDef();
    const v = def && def.fixedValue != null ? def.fixedValue : parseFloat(String($('ruleVal').value).replace(',', '.'));
    return { id: editingId || 'draft', symbol: $('ruleSym').value, type: $('ruleType').value, op: $('ruleOp').value, value: v, params: readParams() };
  }

  /* The engine's own measurement, run once on a copy of the rule. */
  function measure(rule) {
    const def = ALERT_TYPES[rule.type];
    if (!def) return { value: null, why: 'unknown' };
    const port = def.needs === 'portfolio';
    const q = port ? null : (deps.quotes() || {})[rule.symbol];
    if (!port && !q) return { value: null, why: 'quote' };
    let series = null;
    if (def.needs === 'bars') {
      const bars = safe(() => deps.dailyFor(rule.symbol));
      if (!Array.isArray(bars) || !bars.length) {
        if (!barsAsked.has(rule.symbol)) {
          barsAsked.add(rule.symbol);
          Promise.resolve(safe(() => deps.ensureBars(rule.symbol))).then(() => { if (!$('alertsModal').hidden) updatePreview(); }).catch(() => {});
        }
        if (!def.fundamentals) return { value: null, why: 'bars' };
      } else series = liveSeries(bars, q, Date.now());
    }
    let fundamentals = null;
    if (def.fundamentals) {
      fundamentals = safe(() => deps.fundFor(rule.symbol));
      if (!fundamentals) safe(() => deps.ensureFund(rule.symbol));
    }
    const copy = { ...rule };
    let value = null;
    try {
      value = def.metric({ rule: copy, quote: q, now: Date.now(), touch() {}, params: paramsFor(copy), series,
        fundamentals: fundamentals && typeof fundamentals === 'object' ? fundamentals : null,
        portfolio: port ? safe(() => deps.portfolioTotals()) : null });
    } catch (e) { value = null; }
    return { value: fin(value) ? value : null, why: fin(value) ? null : (def.needs === 'bars' ? 'bars' : port ? 'portfolio' : 'data') };
  }

  function updatePreview() {
    const box = $('rulePreview');
    const def = currentDef();
    box.textContent = '';
    box.className = 'al-preview';
    if (!def || !$('ruleSym').value) return;
    const rule = draftRule();
    const m = measure(rule);
    if (m.value == null) {
      box.textContent = i18nT(m.why === 'quote' ? 'No quote for this symbol yet — the rule is measured once one arrives.'
        : m.why === 'bars' ? 'Loading daily prices to measure this condition…'
          : m.why === 'portfolio' ? 'Record holdings in Transactions for portfolio alerts to measure anything.'
            : 'This condition cannot be measured from the data available right now.');
      return;
    }
    const now = formatMetric(rule, m.value);
    box.appendChild(el('span', null, i18nT('Right now') + ': '));
    box.appendChild(el('strong', 'num', now));
    const value = Number(rule.value);
    if (fin(value)) {
      const up = rule.op === 'above' || rule.op === 'crossAbove';
      const cond = up ? m.value >= value : m.value <= value;
      let verdict, cls;
      if (isCrossOp(rule.op)) {
        verdict = cond ? i18nT('already past the line — it fires on the next cross, after it comes back') : i18nT('waiting for the cross');
        cls = 'wait';
      } else { verdict = cond ? i18nT('would fire now') : i18nT('would not fire now'); cls = cond ? 'hot' : 'wait'; }
      box.append(el('span', null, ' — '), el('span', 'al-verdict ' + cls, verdict));
      box.classList.add(cls);
    }
    const p = describeRule({ ...rule, value: fin(value) ? value : 0 });
    box.title = p;
  }

  // A scope the routed provider cannot observe is a rule that can never fire, so
  // the option is withdrawn and the reason stated rather than silently offered.
  function updateSessionNote() {
    const sym = $('ruleSym').value;
    const sel = $('ruleSess');
    const note = $('ruleSessNote');
    const extOpt = sel.querySelector('option[value="extended"]');
    extOpt.disabled = false;
    if (!sym) { note.textContent = i18nT('Add a symbol to the watchlist first.'); return; }
    if (sym === PORTFOLIO_SYMBOL) {
      sel.value = 'any'; sel.disabled = true;
      note.textContent = i18nT('Portfolio rules are checked on every poll, whichever markets are open.');
      return;
    }
    sel.disabled = false;
    const mkt = safe(() => deps.marketFor(sym), 'US_EQUITY');
    if (mkt !== 'US_EQUITY') {
      extOpt.disabled = true;
      if (sel.value === 'extended') sel.value = 'any';
      note.textContent = mkt === 'CRYPTO'
        ? sym + ' ' + i18nT('trades continuously — there is no pre- or post-market session to scope to.')
        : sym + ' ' + i18nT('is an FX pair — one continuous session from Sunday 17:00 to Friday 17:00 ET, so extended hours do not apply.');
      return;
    }
    const pid = safe(() => deps.routeQuote(sym), 'demo') || 'demo';
    const ext = deps.extHours[pid];
    const label = deps.providerLabels[pid] || pid;
    extOpt.disabled = ext === false;
    if (ext === false && sel.value === 'extended') sel.value = 'regular';
    note.textContent = ext === false
      ? label + ' ' + i18nT('reports regular-session prices only, so an extended-hours rule could never fire. Change provider to scope one.')
      : ext === null
        ? label + ' ' + i18nT('does not document whether its free quote endpoint includes pre- and post-market trades, so an extended-hours rule may never fire.')
        : label + ' ' + i18nT('reports extended-hours trades. Rules are still only checked while a tab is open.');
  }

  function paintFormMode() {
    const editing = !!editingId;
    $('ruleAdd').textContent = i18nT(editing ? 'Save changes' : 'Add alert');
    $('ruleCancel').hidden = !editing;
    $('ruleForm').classList.toggle('editing', editing);
    $('ruleErr').hidden = true;
  }

  function saveFromForm() {
    const err = (m) => { $('ruleErr').hidden = false; $('ruleErr').textContent = i18nT(m); };
    const def = currentDef();
    const symbol = $('ruleSym').value;
    if (!symbol) return err('Pick a symbol.');
    if (!def) return err('Pick a condition.');
    const rule = draftRule();
    if (!fin(Number(rule.value))) return err('Enter a valid threshold.');
    if (def.id === 'rsi' && (rule.value < 0 || rule.value > 100)) return err('RSI runs from 0 to 100.');
    const scope = SESSION_SCOPES[$('ruleSess').value] ? $('ruleSess').value : 'regular';
    const expires = $('ruleExpires').value;
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    if (expires && expires < todayStr) return err('The expiry date is in the past.');
    const patch = {
      symbol, type: def.id, op: rule.op, value: Number(rule.value),
      sessions: symbol === PORTFOLIO_SYMBOL ? [] : normalizeSessions(SESSION_SCOPES[scope].slice()),
      repeat: $('ruleRepeat').value === 'once' ? 'once' : 'rearm',
      expires: expires || null,
    };
    if (def.params.length) patch.params = rule.params; else patch.params = undefined;
    const note = $('ruleNote').value.trim();
    patch.note = note ? note.slice(0, 200) : undefined;
    if (editingId) {
      store.updateRule(editingId, { ...patch, armed: true });
      const r = store.rules.find((x) => x.id === editingId);
      if (r) { if (!patch.params) delete r.params; if (!patch.note) delete r.note; delete r.unsupported; delete r.disarmedBy; store.saveRules(); }
      deps.toast(i18nT('Alert updated') + ': ' + describeRule(r || patch));
    } else {
      const r = store.addRule({ id: mintId('r'), ...patch, armed: true });
      if (!patch.params) delete r.params;
      if (!patch.note) delete r.note;
      store.saveRules();
      deps.toast(i18nT('Alert added') + ': ' + describeRule(r));
    }
    if (def.needs === 'bars') safe(() => deps.ensureBars(symbol));
    editingId = null;
    paintFormMode();
    renderRules();
    deps.onChange();
  }

  function edit(r) {
    editingId = r.id;
    fillSymbols(r.symbol);
    $('ruleSym').value = r.symbol;
    fillTypes(r.type, r.type);
    syncType(paramsFor(r));
    $('ruleOp').value = r.op;
    $('ruleVal').value = String(r.value);
    $('ruleSess').value = scopeOf(r);
    $('ruleRepeat').value = r.repeat === 'once' ? 'once' : 'rearm';
    $('ruleExpires').value = r.expires || '';
    $('ruleNote').value = r.note || '';
    $('ruleMore').open = !!(r.expires || r.note || r.repeat === 'once' || scopeOf(r) !== 'regular');
    paintFormMode();
    updateSessionNote();
    updatePreview();
    safe(() => $('ruleForm').scrollIntoView({ block: 'nearest' }));
  }

  function duplicate(r) {
    const copy = { ...r, id: mintId('r'), armed: true, created: Date.now() };
    for (const k of Object.keys(copy)) if (k.charAt(0) === '_') delete copy[k];
    delete copy.cooldownUntil; delete copy.disarmedBy; delete copy.unsupported;
    store.addRule(copy);
    renderRules();
    deps.onChange();
  }

  /* ---- rule list ------------------------------------------------------------------ */
  function renderRules() {
    const list = $('ruleList');
    list.textContent = '';
    const all = store.rules.filter((r) => !ruleFilter || (ruleFilter === 'armed' ? r.armed : !r.armed));
    if (!store.rules.length) { list.appendChild(el('p', 'field-note', i18nT('No alert rules yet.'))); return; }
    if (!all.length) { list.appendChild(el('p', 'field-note', i18nT('No rules match this filter.'))); return; }
    const groups = new Map();
    for (const r of all) { if (!groups.has(r.symbol)) groups.set(r.symbol, []); groups.get(r.symbol).push(r); }
    for (const [sym, rules] of groups) {
      const g = el('div', 'rule-group');
      const head = el('div', 'rule-ghead');
      head.append(el('span', 'rr-sym', sym === PORTFOLIO_SYMBOL ? i18nT('Portfolio') : sym));
      const q = (deps.quotes() || {})[sym];
      if (q && fin(q.price)) head.append(el('span', 'field-note amount', fmtPrice(q.price, q.currency, safe(() => deps.fxOpts(sym), {}))));
      head.append(el('span', 'field-note', rules.filter((r) => r.armed).length + '/' + rules.length + ' ' + i18nT('armed')));
      g.appendChild(head);
      for (const r of rules) g.appendChild(ruleRow(r));
      list.appendChild(g);
    }
  }

  function ruleRow(r) {
    const row = el('div', 'rule-row' + (r.armed ? '' : ' off') + (r.id === editingId ? ' editing' : ''));
    const sw = el('button', 'switch' + (r.armed ? ' on' : ''));
    sw.type = 'button';
    sw.title = i18nT(r.armed ? 'Armed — click to switch off' : 'Off — click to arm');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', r.armed ? 'true' : 'false');
    sw.disabled = !!r.unsupported;
    sw.addEventListener('click', () => { store.updateRule(r.id, { armed: !r.armed }); renderRules(); deps.onChange(); });
    row.appendChild(sw);
    const main = el('div', 'rule-main');
    main.appendChild(el('span', 'rule-cond', describeRule(r)));
    const meta = el('div', 'rule-meta');
    if (r.symbol !== PORTFOLIO_SYMBOL) {
      const scope = scopeOf(r);
      const chip = el('span', 'tag scope ' + scope, i18nT(SCOPE_LABEL[scope]));
      chip.title = i18nT(SCOPE_TIP[scope]);
      meta.appendChild(chip);
    }
    if (r.repeat === 'once') meta.appendChild(el('span', 'tag', i18nT('once')));
    if (r.expires) meta.appendChild(el('span', 'tag', i18nT('until') + ' ' + r.expires));
    if (!r.armed && r.disarmedBy) meta.appendChild(el('span', 'tag ' + (r.disarmedBy === 'unsupported' ? 'stale' : 'closed'), i18nT(DISARM_LABEL[r.disarmedBy] || r.disarmedBy)));
    if (fin(r._prev)) {
      const v = el('span', 'field-note', i18nT('now') + ' ' + formatMetric(r, r._prev));
      v.title = i18nT('The value this rule measured on the last poll.');
      meta.appendChild(v);
    } else if (r.armed && ALERT_TYPES[r.type] && ALERT_TYPES[r.type].needs === 'bars' && !safe(() => deps.dailyFor(r.symbol))) {
      meta.appendChild(el('span', 'field-note', i18nT('waiting for daily prices')));
    }
    if (r.note) { const nn = el('span', 'field-note rule-note', '“' + r.note + '”'); nn.title = r.note; meta.appendChild(nn); }
    main.appendChild(meta);
    row.appendChild(main);
    const acts = el('span', 'rule-acts');
    const mk = (txt, tip, fn) => { const b = el('button', 'icon-mini', txt); b.type = 'button'; b.title = i18nT(tip); b.setAttribute('aria-label', i18nT(tip)); b.addEventListener('click', fn); acts.appendChild(b); };
    if (!r.unsupported) mk('✎', 'Edit rule', () => edit(r));
    mk('⧉', 'Duplicate rule', () => duplicate(r));
    mk('✕', 'Delete rule', () => {
      if (!confirm(i18nT('Delete this alert rule?') + '\n' + describeRule(r))) return;
      store.removeRule(r.id);
      if (editingId === r.id) { editingId = null; paintFormMode(); }
      renderRules(); deps.onChange();
    });
    row.appendChild(acts);
    return row;
  }

  /* ---- log ----------------------------------------------------------------------- */
  /* The log records what was true when a rule fired: session, price and change at
     that instant. It deliberately does NOT record what the price did afterwards —
     a "you should have acted" column would turn a monitoring tool into a
     scorecard for decisions this app does not make. */
  function logRows() {
    const all = Array.isArray(store.alertlog) ? store.alertlog : [];
    const since = logRange ? Date.now() - Number(logRange) * 86400000 : 0;
    return all.filter((a) => (!logFilter || a.symbol === logFilter) && (!since || (a.ts || 0) >= since));
  }

  function renderLog() {
    const log = $('alertLog'); log.textContent = '';
    const all = Array.isArray(store.alertlog) ? store.alertlog : [];
    const filter = $('logFilter');
    const syms = [...new Set(all.map((a) => a.symbol).filter(Boolean))].sort();
    filter.textContent = '';
    const opt = el('option', null, i18nT('All symbols')); opt.value = ''; filter.appendChild(opt);
    for (const s of syms) { const o = el('option', null, s === PORTFOLIO_SYMBOL ? i18nT('Portfolio') : s); o.value = s; filter.appendChild(o); }
    filter.value = syms.includes(logFilter) ? logFilter : '';
    logFilter = filter.value;
    $('logRange').value = logRange;

    const rows = logRows().slice(-50).reverse();
    if (!rows.length) {
      log.appendChild(el('p', 'field-note', i18nT(all.length ? 'Nothing logged for this filter.' : 'Nothing has triggered yet.')));
      return;
    }
    for (const a of rows) {
      const r = el('div', 'log-row');
      const d = new Date(a.ts);
      const sameDay = new Date().toDateString() === d.toDateString();
      r.append(el('span', 'log-time', (sameDay ? '' : d.toISOString().slice(5, 10) + ' ') + fmtTime(a.ts)));
      if (a.sessionLabel || a.session) {
        const st = el('span', 'tag sess' + (a.approx ? ' approx' : ''), a.sessionLabel || a.session);
        st.title = i18nT(a.approx ? 'Market session when the rule fired — the calendar could not confirm this date.' : 'Market session when the rule fired.');
        r.append(st);
      }
      const t = el('span', 'log-text', a.text);
      t.title = a.text || '';
      r.append(t);
      if (a.quote && a.quote.price != null) {
        const snap = el('span', 'log-snap amount', fmtPrice(a.quote.price, a.quote.currency, safe(() => deps.fxOpts(a.symbol), {}))
          + (a.quote.changePct != null ? ' (' + fmtNum(a.quote.changePct) + '%)' : ''));
        snap.title = i18nT('Quote at the moment the rule fired') + (a.quote.source ? ' · ' + a.quote.source : '');
        r.append(snap);
      }
      log.appendChild(r);
    }
  }

  function exportLog() {
    const rows = [['time', 'symbol', 'type', 'session', 'session_approx', 'scope', 'text', 'price', 'currency', 'change', 'change_pct', 'source']];
    for (const a of logRows()) {
      const q = a.quote || {};
      rows.push([new Date(a.ts).toISOString(), a.symbol || '', a.type || '', a.sessionLabel || a.session || '', a.approx ? 'yes' : '',
        a.scope || '', a.text || '', q.price ?? '', q.currency || '', q.change ?? '', q.changePct ?? '', q.source || '']);
    }
    deps.downloadFile('carino-stocks-alerts-' + Math.floor(Date.now() / 1000) + '.csv', 'text/csv', rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
  }

  /* ---- wiring --------------------------------------------------------------------- */
  $('ruleAdd').addEventListener('click', saveFromForm);
  $('ruleCancel').addEventListener('click', () => { editingId = null; paintFormMode(); renderRules(); });
  $('ruleSym').addEventListener('change', () => { const t = $('ruleType').value; fillTypes(t); syncType(); });
  $('ruleType').addEventListener('change', () => syncType());
  $('ruleOp').addEventListener('change', updatePreview);
  $('ruleVal').addEventListener('input', updatePreview);
  $('ruleVal').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveFromForm(); } });
  $('ruleFilter').addEventListener('change', (e) => { ruleFilter = e.target.value; renderRules(); });
  $('logFilter').addEventListener('change', (e) => { logFilter = e.target.value; renderLog(); });
  $('logRange').addEventListener('change', (e) => { logRange = e.target.value; renderLog(); });
  $('btnLogCsv').addEventListener('click', exportLog);
  $('btnLogClear').addEventListener('click', () => {
    if (!store.alertlog.length || !confirm(i18nT('Clear the whole alert log? Rules are not affected.'))) return;
    store.alertlog = [];
    store.saveAlertlog();
    renderLog();
    deps.onChange();
  });

  return {
    open,
    renderRules: () => { if (!$('alertsModal').hidden) renderRules(); },
    renderLog: () => { if (!$('alertsModal').hidden) renderLog(); },
    refreshPreview: () => { if (!$('alertsModal').hidden) updatePreview(); },
    relabel: () => { if ($('alertsModal').hidden) return; const t = $('ruleType').value; fillTypes(t, t); syncType(readParams()); renderRules(); renderLog(); },
  };
}
