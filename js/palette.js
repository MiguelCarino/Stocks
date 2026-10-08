/* palette.js — the command palette (Ctrl/Cmd+K), the single-key shortcuts and
   the "?" cheat sheet.

   The palette is a list of things the app can already do, reachable by typing:
   go to a symbol, add a widget, switch tab, open a dialog, change the level. It
   owns no behaviour of its own — app.js hands it the command list (rebuilt on
   every open, so it always reflects the current tabs, level and watchlist) and
   the functions to run. Nothing here trades, and nothing here can: the palette
   reaches only commands the UI already exposes.

   Shortcuts are single keys and are ignored while the user is typing in a field,
   while a dialog is open, or with Ctrl/Alt/Meta held (other than the palette's
   own chord), so they never steal a keystroke meant for something else. */

const i18nT = (s) => (window.CarinoI18n ? window.CarinoI18n.t(s) : s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

// The shortcut table is data so the cheat sheet and the handler cannot disagree.
// `keys` is what the sheet prints; `match(e)` decides; `run` names the action.
export const SHORTCUTS = [
  { group: 'General', keys: ['Ctrl', 'K'], mac: ['⌘', 'K'], label: 'Open the command palette', run: 'palette',
    match: (e) => (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K') },
  { group: 'General', keys: ['?'], label: 'Show keyboard shortcuts', run: 'shortcuts', match: (e) => e.key === '?' },
  { group: 'General', keys: ['/'], label: 'Search or add a symbol', run: 'search', match: (e) => e.key === '/' },
  { group: 'General', keys: ['Esc'], label: 'Close the open dialog, drawer or menu', run: null, match: () => false },
  { group: 'Open', keys: ['A'], label: 'Alert rules', run: 'alerts', match: (e) => e.key === 'a' },
  { group: 'Open', keys: ['T'], label: 'Transactions', run: 'ledger', match: (e) => e.key === 't' },
  { group: 'Open', keys: ['L'], label: 'Lessons', run: 'lessons', match: (e) => e.key === 'l' },
  { group: 'Open', keys: ['G'], label: 'Glossary', run: 'glossary', match: (e) => e.key === 'g' },
  { group: 'Open', keys: [','], label: 'Settings', run: 'settings', match: (e) => e.key === ',' },
  { group: 'Open', keys: ['I'], label: 'Details for the selected symbol', run: 'details', match: (e) => e.key === 'i' },
  { group: 'Workspace', keys: ['1', '…', '9'], label: 'Switch to tab 1–9', run: 'tab', match: (e) => /^[1-9]$/.test(e.key) },
  { group: 'Workspace', keys: ['N'], label: 'Add a widget', run: 'widget', match: (e) => e.key === 'n' },
  { group: 'Workspace', keys: ['P'], label: 'Blur or show amounts (privacy)', run: 'privacy', match: (e) => e.key === 'p' },
  { group: 'Workspace', keys: ['R'], label: 'Refresh quotes now', run: 'refresh', match: (e) => e.key === 'r' },
  { group: 'Workspace', keys: ['Shift', 'P'], label: 'Pause or resume auto-refresh', run: 'pause', match: (e) => e.key === 'P' },
  { group: 'Chart (when focused)', keys: ['+', '-'], or: true, label: 'Zoom in and out', run: null, match: () => false },
  { group: 'Chart (when focused)', keys: ['Left', 'Right'], or: true, label: 'Pan through time', run: null, match: () => false },
  { group: 'Chart (when focused)', keys: ['Home', 'End'], or: true, label: 'Jump to the start or the latest bar', run: null, match: () => false },
];

function typingIn(target) {
  const t = target && target.closest ? target : null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  return !!t.closest('input, textarea, select, [contenteditable="true"]');
}

// A dialog, modal, tour or drawer is in charge of the keyboard while it is open.
function overlayOpen() {
  if (document.querySelector('dialog[open]')) return true;
  if (document.querySelector('.learn-tour')) return true;
  const scrim = document.getElementById('modalScrim');
  if (scrim && !scrim.hidden) return true;
  const gate = document.getElementById('ackGate');
  if (gate && !gate.hidden) return true;
  return false;
}

/* initPalette({ commands: () => Command[], actions: {name: fn}, searchSymbols(q) -> Promise<[{symbol, description}]> })
   Command = { id, label, group, hint?, keywords?, run() }. */
export function initPalette(opts = {}) {
  let dlg = null, input = null, list = null, items = [], hi = 0, token = 0, symTimer = 0;
  let sheet = null;

  function build() {
    if (dlg && dlg.isConnected) return;
    dlg = el('dialog', 'cmdk');
    dlg.setAttribute('aria-label', i18nT('Command palette'));
    const box = el('div', 'cmdk-box');
    input = el('input', 'input cmdk-q');
    input.type = 'text';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'cmdkList');
    input.setAttribute('aria-autocomplete', 'list');
    input.autocomplete = 'off';
    input.spellcheck = false;
    list = el('ul', 'cmdk-list');
    list.id = 'cmdkList';
    list.setAttribute('role', 'listbox');
    const foot = el('div', 'cmdk-foot');
    foot.append(el('span', null, '↑↓ ' + i18nT('to choose')), el('span', null, '↵ ' + i18nT('to run')), el('span', null, 'Esc ' + i18nT('to close')));
    box.append(input, list, foot);
    dlg.append(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('close', () => { clearTimeout(symTimer); token++; });
    input.addEventListener('input', () => { hi = 0; paint(); querySymbols(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runAt(hi); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.body.append(dlg);
  }

  let base = [];      // the static commands for this opening
  let symCmds = [];   // symbol matches from the provider search

  function score(c, q) {
    if (!q) return 1;
    const label = fold(c.label);
    const hay = fold(c.label + ' ' + (c.group || '') + ' ' + (c.keywords || ''));
    if (label.startsWith(q)) return 4;
    // A word of the label ("Explain: RSI", "Add widget: Chart") or a keyword
    // (an English term name, an id) starting with the query is a strong match.
    if (label.split(/[\s:—(),/]+/).some((w) => w && w.startsWith(q))) return 3;
    if (fold(c.keywords || '').split(/\s+/).some((w) => w && w.startsWith(q))) return 3;
    if (hay.includes(q)) return 2;
    // Every query word somewhere in the haystack.
    const words = q.split(/\s+/).filter(Boolean);
    return words.length > 1 && words.every((w) => hay.includes(w)) ? 1 : 0;
  }

  function current() {
    const q = fold(input.value.trim());
    const ranked = base.filter((c) => q || !c.searchOnly).map((c) => ({ c, s: score(c, q) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).map((x) => x.c);
    // A strong command match (the label starts with the query) outranks the
    // "Go to TICKER" guess; otherwise a ticker-looking query goes to symbols first.
    const strong = ranked.filter((c) => score(c, q) >= 3);
    const rest = ranked.filter((c) => score(c, q) < 3);
    const out = q ? [...strong, ...symCmds, ...rest] : ranked;
    return out.slice(0, 60);
  }

  function paint() {
    items = current();
    if (hi >= items.length) hi = Math.max(0, items.length - 1);
    list.textContent = '';
    let lastGroup = null;
    items.forEach((c, i) => {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        const g = el('li', 'cmdk-group', i18nT(c.group || ''));
        g.setAttribute('role', 'presentation');
        list.append(g);
      }
      const li = el('li', 'cmdk-item' + (i === hi ? ' active' : ''));
      li.id = 'cmdk-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === hi ? 'true' : 'false');
      li.append(el('span', 'cmdk-label', c.label));
      if (c.hint) li.append(el('kbd', 'cmdk-hint', c.hint));
      li.addEventListener('mousemove', () => { if (hi !== i) { hi = i; mark(); } });
      li.addEventListener('click', () => runAt(i));
      list.append(li);
    });
    if (!items.length) list.append(el('li', 'cmdk-empty', i18nT('No matching commands. Type a ticker to go to a symbol.')));
    mark();
  }

  function mark() {
    list.querySelectorAll('.cmdk-item').forEach((li, i) => {
      const on = i === hi;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', items.length ? 'cmdk-' + hi : '');
  }

  function move(d) {
    if (!items.length) return;
    hi = (hi + d + items.length) % items.length;
    mark();
  }

  function runAt(i) {
    const c = items[i];
    if (!c) return;
    close();
    // After the dialog has closed, so a command that opens another dialog or
    // moves focus is not fighting the palette for it.
    setTimeout(() => safe(() => c.run()), 0);
  }

  // A typed ticker always offers "Go to", even before (or without) a search hit.
  function querySymbols() {
    clearTimeout(symTimer);
    const raw = input.value.trim();
    const typed = raw.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
    symCmds = [];
    if (typed && typed.length <= 12 && /^[A-Z0-9.\-]+$/.test(raw.toUpperCase()) && typeof opts.goSymbol === 'function') {
      symCmds.push({ id: 'sym:' + typed, group: 'Symbols', label: i18nT('Go to') + ' ' + typed, run: () => opts.goSymbol(typed) });
    }
    paint();
    if (!raw || typeof opts.searchSymbols !== 'function') return;
    const my = ++token;
    symTimer = setTimeout(async () => {
      const res = await Promise.resolve(safe(() => opts.searchSymbols(raw), [])).catch(() => []);
      if (my !== token || !dlg.open) return;
      const seen = new Set(symCmds.map((c) => c.id));
      for (const r of (res || []).slice(0, 5)) {
        const sym = String(r.symbol || '').toUpperCase();
        if (!sym || seen.has('sym:' + sym)) continue;
        seen.add('sym:' + sym);
        symCmds.push({ id: 'sym:' + sym, group: 'Symbols', label: i18nT('Go to') + ' ' + sym + (r.description ? ' — ' + r.description : ''), run: () => opts.goSymbol(sym) });
      }
      paint();
    }, 220);
  }

  function open(prefill) {
    build();
    base = safe(() => opts.commands(), []) || [];
    symCmds = [];
    input.placeholder = i18nT('Type a command or a ticker…');
    input.value = prefill || '';
    hi = 0;
    paint();
    if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    input.focus();
    if (prefill) querySymbols();
  }

  function close() { if (dlg && dlg.open) dlg.close(); }

  /* ---- cheat sheet ------------------------------------------------------------ */
  function openShortcuts() {
    if (sheet && sheet.isConnected) sheet.remove();
    sheet = el('dialog', 'learn-dlg kbd-sheet');
    sheet.setAttribute('aria-labelledby', 'kbdTitle');
    const head = el('div', 'modal-head');
    const title = el('div', 'modal-title', i18nT('Keyboard shortcuts'));
    title.id = 'kbdTitle';
    const x = el('button', 'modal-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', i18nT('Close'));
    x.addEventListener('click', () => sheet.close());
    head.append(title, x);
    const body = el('div', 'kbd-body');
    const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
    for (const g of groups) {
      const sec = el('section', 'kbd-sec');
      sec.append(el('h3', 'kbd-h', i18nT(g)));
      const tbl = el('table', 'kbd-tbl');
      for (const s of SHORTCUTS.filter((x) => x.group === g)) {
        const tr = el('tr');
        const keys = el('td', 'kbd-keys');
        (isMac() && s.mac ? s.mac : s.keys).forEach((k, i, arr) => {
          // '1 … 9' is a range, 'Home / End' alternatives, 'Ctrl + K' a chord.
          if (i) keys.append(document.createTextNode(k === '…' || arr[i - 1] === '…' ? ' ' : s.or ? ' / ' : ' + '));
          keys.append(k === '…' ? document.createTextNode('…') : el('kbd', null, k));
        });
        tr.append(keys, el('td', null, i18nT(s.label)));
        tbl.append(tr);
      }
      sec.append(tbl);
      body.append(sec);
    }
    body.append(el('p', 'field-note', i18nT('Single-key shortcuts are ignored while you are typing in a field or a dialog is open.')));
    sheet.append(head, body);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
    sheet.addEventListener('close', () => sheet.remove());
    document.body.append(sheet);
    try { sheet.showModal(); } catch (e) { sheet.setAttribute('open', ''); }
    x.focus();
  }

  /* ---- global keys ------------------------------------------------------------ */
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const chord = SHORTCUTS[0];
    if (chord.match(e)) {
      // The palette chord works from anywhere, including a text field, because
      // that is where a keyboard user already is. It toggles.
      e.preventDefault();
      if (dlg && dlg.open) close(); else if (!overlayOpen()) open();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typingIn(e.target) || overlayOpen()) return;
    const hit = SHORTCUTS.find((s) => s.run && s !== chord && s.match(e));
    if (!hit) return;
    const act = opts.actions && opts.actions[hit.run];
    if (hit.run === 'palette') { e.preventDefault(); open(); return; }
    if (hit.run === 'shortcuts') { e.preventDefault(); openShortcuts(); return; }
    if (typeof act !== 'function') return;
    e.preventDefault();
    safe(() => act(e));
  });

  return { open, close, openShortcuts, isOpen: () => !!(dlg && dlg.open) };
}
