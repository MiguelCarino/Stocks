/* widgets-learn.js — the education widgets: glossary, learn (tips + lessons)
   and notes.

   Same contract as every other widget (widgets.js): build once in create(),
   patch in update(), never fetch market data, never write storage. The glossary
   and lessons are static files under data/ that learn.js loads and caches, so
   they work the same in a detached window. Notes persist through the widget's
   own saved state (ctx.onWidgetState) and nothing else; a popout, which has no
   such hook, shows them read-only rather than pretending an edit was kept.

   Nothing here is advice. The tips explain what is on the screen, never what to
   do about it. */

import { mountGlossary, mountLessons, loadGlossary, helpIcon, openGlossary, levelPicker, LEVELS, normalizeLevel } from './learn.js';

// UI-string translation via the site dictionary (i18n.js); identity when absent.
const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
const setText = (n, t) => { const v = t == null ? '' : String(t); if (n.textContent !== v) n.textContent = v; };

/* =============================================================================
   GLOSSARY — the searchable term list, in a widget
   ============================================================================= */
function createGlossary(host, ctx) {
  const root = el('div', 'wg-learn wg-gloss');
  host.appendChild(root);
  const g = mountGlossary(root, { compact: true, initial: safe(() => ctx.widgetState.term, null) });
  return {
    kind: 'glossary',
    update() { /* static content; learn.js re-renders it on a language switch */ },
    setSymbol() {},
    destroy() { safe(() => g.destroy()); host.textContent = ''; },
  };
}

/* =============================================================================
   LEARN — "What am I looking at?" tips, a term of the day, the lessons
   ============================================================================= */

// Each tip explains one thing on the screen, with the glossary entry behind it.
const TIPS = [
  { learn: 'last-price', text: 'The big number is the latest price your data provider reported. It can be delayed: the chip at the top says DEMO, DELAYED or LIVE.' },
  { learn: 'prev-close', text: 'Green and red show the change since the previous close. Up or down today says nothing about whether to buy or sell.' },
  { learn: 'day-range', text: 'The thin bar on each card shows where the price sits between today’s low (left) and high (right).' },
  { learn: 'watchlist', text: 'Click a symbol to show it in every linked widget. Double-click it for the full details: chart, key numbers and news.' },
  { learn: 'candlestick', text: 'On a candle chart each candle is one period. The thick body spans open to close; the thin wicks reach the high and low.' },
  { learn: 'price-alert', text: 'Alerts watch prices for you, but only while a Stocks tab is open in this browser.' },
  { learn: 'delayed-data', text: 'Free data plans are often delayed by minutes. Never treat a price here as the price you would trade at.' },
  { learn: null, text: 'Nothing here is investment advice. Stocks cannot place trades, move money or see your brokerage account.' },
];

// Same term all day, a different one tomorrow: a nudge, not a feed.
function termOfTheDay(map) {
  const ids = Object.keys(map).filter((id) => map[id].level === 'beginner').sort();
  if (!ids.length) return null;
  const d = new Date();
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return map[ids[day % ids.length]];
}

function createLearn(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const level = () => normalizeLevel(safe(() => cur.level, null) || safe(() => cur.settings.level, null) || 'standard');
  const root = el('div', 'wg-learn');

  // Level row: only where the level can actually be changed (the main window).
  const lvRow = el('div', 'wg-learn-level');
  const lvLbl = el('span', 'rail-lbl', i18nT('Experience level'));
  let picker = null;
  if (typeof cur.setLevel === 'function') {
    picker = levelPicker(level(), (lv) => safe(() => cur.setLevel(lv)));
    lvRow.append(lvLbl, picker);
  }
  const lvNote = el('p', 'field-note', '');

  // Tips, open by default for beginners; the widget remembers a closed state.
  const tips = el('details', 'wg-learn-tips');
  const sum = el('summary', null, i18nT('What am I looking at?'));
  tips.append(sum);
  const ul = el('ul', 'wg-learn-tiplist');
  for (const t of TIPS) {
    const li = el('li');
    li.append(el('span', null, i18nT(t.text)));
    if (t.learn) li.append(helpIcon(t.learn));
    ul.append(li);
  }
  tips.append(ul);
  tips.open = typeof saved.tipsOpen === 'boolean' ? saved.tipsOpen : level() === 'beginner';
  tips.addEventListener('toggle', () => safe(() => cur.onWidgetState({ ...(cur.widgetState || {}), tipsOpen: tips.open })));

  // Term of the day.
  const tod = el('div', 'wg-learn-tod');
  const todHead = el('div', 'rail-lbl', i18nT('Term of the day'));
  const todTerm = el('button', 'learn-link wg-learn-todterm', '');
  todTerm.type = 'button';
  const todShort = el('p', 'learn-muted', '');
  tod.append(todHead, todTerm, todShort);
  let todId = null;
  todTerm.addEventListener('click', () => { if (todId) openGlossary(todId); });
  function paintTerm() {
    loadGlossary().then((map) => {
      const t = termOfTheDay(map || {});
      tod.hidden = !t;
      if (!t) return;
      todId = t.id;
      setText(todTerm, t.term);
      setText(todShort, t.short);
    });
  }

  // Actions: the tour lives in the main window only.
  const acts = el('div', 'wg-learn-acts');
  const tourBtn = el('button', 'cs-btn sm', '▶ ' + i18nT('Take the guided tour'));
  tourBtn.type = 'button';
  tourBtn.addEventListener('click', () => safe(() => cur.startTour()));
  const glossBtn = el('button', 'cs-btn sm', i18nT('Open the glossary'));
  glossBtn.type = 'button';
  glossBtn.addEventListener('click', () => openGlossary());
  acts.append(tourBtn, glossBtn);

  const lessons = el('div', 'wg-learn-lessons');
  root.append(lvRow, lvNote, tips, tod, acts, lessons);
  host.appendChild(root);
  const ls = mountLessons(lessons, {});
  paintTerm();

  let lastLv = '';
  function update(next) {
    if (next) cur = next;
    lvRow.hidden = !picker;
    tourBtn.hidden = typeof cur.startTour !== 'function';
    const lv = level();
    if (lv !== lastLv) {
      lastLv = lv;
      if (picker) picker.setLevel(lv);
      setText(lvNote, i18nT(LEVELS[lv].summary));
    }
  }
  update(cur);
  return {
    kind: 'learn',
    update,
    setSymbol() {},
    destroy() { safe(() => ls.destroy()); host.textContent = ''; },
  };
}

/* =============================================================================
   NOTES — free notes, or one note per symbol, in a small markdown subset
   ============================================================================= */

// The store caps one widget's saved state; this leaves headroom for the keys.
const NOTES_MAX = 12000;
const SAVE_MS = 600;

// Markdown-lite: # headings, - and 1. lists, - [ ] / - [x] checkboxes, > quotes,
// --- rules, **bold**, *italic*, `code`, [text](https://…) links and $TICKER
// mentions. Built as DOM nodes, never innerHTML, so a note cannot inject markup.
function renderInline(text, onSym) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<]+)|(\$([A-Z][A-Z0-9.\-]{0,11})\b)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) frag.append(el('strong', null, m[2]));
    else if (m[3]) frag.append(el('em', null, m[4]));
    else if (m[5]) frag.append(el('code', null, m[6]));
    else if (m[7] || m[10]) {
      const a = el('a', null, m[7] ? m[8] : m[10]);
      a.href = m[7] ? m[9] : m[10];
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      frag.append(a);
    } else if (m[11]) {
      const sym = m[12];
      const b = el('button', 'sym-link wg-notes-sym', '$' + sym);
      b.type = 'button';
      b.title = i18nT('Show this symbol in the linked widgets');
      b.addEventListener('click', () => onSym(sym));
      frag.append(b);
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

export function renderNotes(box, text, onSym = () => {}) {
  box.textContent = '';
  let list = null, listTag = '';
  const close = () => { list = null; listTag = ''; };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      close();
      const h = el('h' + (m[1].length + 3), 'wg-notes-h');
      h.append(renderInline(m[2], onSym)); box.append(h); continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { close(); box.append(el('hr')); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      close();
      const q = el('blockquote'); q.append(renderInline(m[1], onSym)); box.append(q); continue;
    }
    if ((m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) {
      if (listTag !== 'ul') { list = el('ul', 'wg-notes-check'); listTag = 'ul'; box.append(list); }
      const li = el('li', m[1] === ' ' ? '' : 'done');
      li.append(el('span', 'wg-notes-box', m[1] === ' ' ? '☐' : '☑'), renderInline(m[2], onSym));
      list.append(li); continue;
    }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (listTag !== 'ul') { list = el('ul'); listTag = 'ul'; box.append(list); }
      const li = el('li'); li.append(renderInline(m[1], onSym)); list.append(li); continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (listTag !== 'ol') { list = el('ol'); listTag = 'ol'; box.append(list); }
      const li = el('li'); li.append(renderInline(m[1], onSym)); list.append(li); continue;
    }
    close();
    const p = el('p'); p.append(renderInline(line, onSym)); box.append(p);
  }
}

function createNotes(host, ctx) {
  let cur = ctx || {};
  const saved = cur.widgetState || {};
  const st = {
    scope: saved.scope === 'symbol' ? 'symbol' : 'free',
    view: saved.view === 'edit' ? 'edit' : 'read',
    free: typeof saved.free === 'string' ? saved.free : '',
    bySym: saved.bySym && typeof saved.bySym === 'object' && !Array.isArray(saved.bySym) ? { ...saved.bySym } : {},
  };
  const canSave = () => typeof cur.onWidgetState === 'function';
  const subject = () => (typeof cur.selection === 'string' && cur.selection) || null;

  const root = el('div', 'wg-notes');
  const bar = el('div', 'wg-bar');
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', i18nT('Notes scope'));
  const bFree = el('button', 'cs-btn seg-btn sm', i18nT('General'));
  const bSym = el('button', 'cs-btn seg-btn sm', i18nT('This symbol'));
  bFree.type = bSym.type = 'button';
  seg.append(bFree, bSym);
  const symLbl = el('span', 'wg-notes-symlbl', '');
  const spacer = el('span', 'spacer');
  const toggle = el('button', 'cs-btn sm', '');
  toggle.type = 'button';
  bar.append(seg, symLbl, spacer, toggle);

  const area = el('textarea', 'input wg-notes-area');
  area.setAttribute('aria-label', i18nT('Notes'));
  area.spellcheck = true;
  area.maxLength = NOTES_MAX;
  const view = el('div', 'wg-notes-view');
  view.tabIndex = 0;
  const foot = el('p', 'field-note wg-notes-foot', '');
  root.append(bar, area, view, foot);
  host.appendChild(root);

  let saveTimer = 0;
  function persist() {
    if (!canSave()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Empty per-symbol notes are dropped so the saved state only holds text.
      const bySym = {};
      for (const [k, v] of Object.entries(st.bySym)) if (v && v.trim()) bySym[k] = v;
      st.bySym = bySym;
      safe(() => cur.onWidgetState({ scope: st.scope, view: st.view, free: st.free, bySym }));
    }, SAVE_MS);
  }
  const textNow = () => (st.scope === 'free' ? st.free : (subject() ? st.bySym[subject()] || '' : ''));
  // Leave room for the other notes in the same saved state.
  const budgetLeft = () => {
    const used = st.free.length + Object.values(st.bySym).reduce((a, v) => a + (v ? v.length : 0), 0);
    return NOTES_MAX - used;
  };

  area.addEventListener('input', () => {
    const before = textNow();
    const room = budgetLeft() + before.length;
    if (area.value.length > room) area.value = area.value.slice(0, room);
    if (st.scope === 'free') st.free = area.value;
    else if (subject()) st.bySym[subject()] = area.value;
    paintFoot();
    persist();
  });
  // Ctrl/Cmd+Enter or Escape leaves the editor for the formatted view.
  area.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      st.view = 'read'; persist(); paint(true); view.focus();
    }
  });
  bFree.addEventListener('click', () => { st.scope = 'free'; persist(); paint(true); });
  bSym.addEventListener('click', () => { st.scope = 'symbol'; persist(); paint(true); });
  toggle.addEventListener('click', () => {
    st.view = st.view === 'edit' ? 'read' : 'edit'; persist(); paint(true);
    if (st.view === 'edit') area.focus();
  });
  view.addEventListener('dblclick', () => { if (canSave()) { st.view = 'edit'; persist(); paint(true); area.focus(); } });

  function paintFoot() {
    const left = budgetLeft();
    if (!canSave()) setText(foot, i18nT('Read-only here. Edit notes in the main window.'));
    else if (left < 1500) setText(foot, left + ' ' + i18nT('characters left in this widget.'));
    else setText(foot, st.view === 'edit'
      ? i18nT('Markdown-lite: # heading, - list, - [ ] to-do, **bold**, *italic*, [link](https://…), $TICKER. Ctrl+Enter to finish.')
      : i18nT('Saved in this browser with your layout. Double-click to edit.'));
  }

  let lastKey = '';
  function paint(force) {
    const sym = subject();
    const editable = canSave() && (st.scope === 'free' || !!sym);
    const editing = editable && st.view === 'edit';
    const key = [st.scope, st.view, sym, editable, textNow()].join('|');
    bFree.classList.toggle('active', st.scope === 'free'); bFree.setAttribute('aria-pressed', st.scope === 'free' ? 'true' : 'false');
    bSym.classList.toggle('active', st.scope === 'symbol'); bSym.setAttribute('aria-pressed', st.scope === 'symbol' ? 'true' : 'false');
    setText(symLbl, st.scope === 'symbol' ? (sym || '') : '');
    toggle.hidden = !editable;
    setText(toggle, editing ? i18nT('Done') : '✎ ' + i18nT('Edit'));
    if (!force && key === lastKey) return;
    lastKey = key;
    area.hidden = !editing;
    view.hidden = editing;
    // Never overwrite what the user is typing with the value it just produced.
    if (editing && document.activeElement !== area) area.value = textNow();
    if (!editing) {
      const txt = textNow();
      if (st.scope === 'symbol' && !sym) { view.textContent = ''; view.append(el('p', 'empty-cell', i18nT('Select a symbol to keep notes about it.'))); }
      else if (!txt.trim()) {
        view.textContent = '';
        view.append(el('p', 'empty-cell', i18nT(canSave() ? 'No notes yet. Click Edit to write one: a plan, a reminder, why you are watching this.' : 'No notes yet.')));
      } else renderNotes(view, txt, (s) => safe(() => cur.onSelect(s)));
    }
    paintFoot();
  }

  function update(next) {
    if (next) cur = next;
    paint(false);
  }
  update(cur);
  return {
    kind: 'notes',
    update,
    setSymbol() {},
    destroy() {
      // A pending edit is written now rather than lost with the widget.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; safe(() => cur.onWidgetState({ scope: st.scope, view: st.view, free: st.free, bySym: st.bySym })); }
      host.textContent = '';
    },
  };
}

export const LEARN_WIDGETS = [
  { id: 'learn', label: 'Learn', desc: 'What am I looking at? Tips, a term of the day and short guided lessons.', needsSymbol: false, minW: 3, minH: 3, defaultW: 4, defaultH: 6, create: createLearn },
  { id: 'glossary', label: 'Glossary', desc: 'Plain-language explanations of every market term used here.', needsSymbol: false, minW: 3, minH: 3, defaultW: 4, defaultH: 6, create: createGlossary },
  { id: 'notes', label: 'Notes', desc: 'Your own notes, general or one per symbol. Stays in this browser.', needsSymbol: false, minW: 3, minH: 2, defaultW: 4, defaultH: 4, create: createNotes },
];
