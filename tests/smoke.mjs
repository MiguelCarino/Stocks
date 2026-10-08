/* smoke.mjs — end-to-end smoke run of the whole app in Demo mode.
   Headless Chromium through the Playwright copy that ships with the Topo repo
   (this repo has no node_modules on purpose: no build, no npm runtime deps).

     node tests/smoke.mjs            # run, exit 1 on any failure
     SHOTS=/some/dir node tests/smoke.mjs   # also keep screenshots

   It serves the repo itself on a free port, so nothing else needs to be running.
   Any console error or uncaught page error anywhere fails the run: a smoke test
   that tolerates "just one" error stops catching the next one. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/carino/Github/Topo/tests/node_modules/playwright/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.csv': 'text/csv' };

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, path || 'index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const errors = [];      // console errors / page errors — always fatal
const failures = [];    // failed assertions
const log = (...a) => console.log(...a);
function check(cond, msg) { if (cond) log('  ok  ', msg); else { failures.push(msg); log('  FAIL', msg); } }
// Every way a widget slot can report that it did not work.
const FAIL_RE = /failed to load|Unknown widget|hit an error|could not be built/i;
const DEAD = '.wk-w-fail, .wg-blank';
async function deadWidgets(page) {
  return page.locator(DEAD).evaluateAll((ns) => ns.map((n) => (n.closest('.wk-w')?.dataset.kind || 'panel') + ': ' + n.textContent.trim().slice(0, 60)));
}
const wait = (p, ms) => p.waitForTimeout(ms);

// Third-party requests must never happen in demo mode; block them so a stray one
// shows up as an error instead of silently reaching the network.
async function newPage(ctx, tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  return page;
}
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()} ${m.location().url || ''}`); });
  // ERR_ABORTED is a fetch the app cancelled itself (AbortController, page close).
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url()) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) errors.push(`[${tag}] request failed: ${r.url()} ${r.failure()?.errorText || ''}`); });
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  page.on('dialog', (d) => d.accept());
}
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: join(SHOTS, 'smoke-' + name + '.png') }); }
async function noHScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

const browser = await chromium.launch();

/* ---- 1. fresh load + onboarding at each level -------------------------------- */
async function onboard(level, vp = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const page = await newPage(ctx, 'onboard-' + level);
  await page.goto(BASE + 'index.html');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.waitForSelector('#ackBtn', { state: 'visible' });
  await page.click('#ackBtn');
  await page.waitForSelector(`.ack-lv[data-level="${level}"]`, { state: 'visible' });
  await page.click(`.ack-lv[data-level="${level}"]`);
  await wait(page, 1500);
  // Beginners get the tour; leave it with Escape the way a person would.
  if (await page.locator('.lr-tour, .tour-card, [class*="tour"]').filter({ visible: true }).count()) {
    await page.keyboard.press('Escape'); await wait(page, 500);
  }
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_settings') || '{}'));
  check(s.ack === true, `${level}: ack stored`);
  check(s.level === level, `${level}: level stored (${s.level})`);
  check(!(await page.locator('#ackGate').isVisible()), `${level}: gate closed`);
  check((await page.locator('.wk-w').count()) > 0, `${level}: workspace has widgets`);
  await wait(page, 1500);
  const dead = await deadWidgets(page);
  check(dead.length === 0, `${level}: no failed widgets on default layout ${dead.join(' | ')}`);
  for (const tab of await page.locator('.wk-tab-btn').all()) {
    await tab.click(); await wait(page, 1500);
    const d = await deadWidgets(page);
    check(d.length === 0, `${level}: tab "${(await tab.textContent()).trim()}" has no failed widgets ${d.join(' | ')}`);
  }
  if (level === 'beginner') {
    const learn = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_learn') || '{}'));
    check(learn.tourDone === true, 'beginner: tour marked done after Escape');
  }
  check(await noHScroll(page), `${level}: no horizontal scroll at ${vp.width}px`);
  await shot(page, 'onboard-' + level + '-' + vp.width);
  return { ctx, page };
}

log('# onboarding');
for (const lv of ['beginner', 'standard']) { const { ctx } = await onboard(lv); await ctx.close(); }
const { ctx, page } = await onboard('pro');

/* ---- 2. add a symbol --------------------------------------------------------- */
log('# watchlist');
await page.click('#btnAdd');
await page.fill('#addSearch', 'AMD');
await page.waitForSelector('#addAuto .ac-row', { state: 'visible' });
await page.locator('#addAuto .ac-row', { hasText: 'AMD' }).first().click();
await wait(page, 800);
const wl = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_watchlist') || '[]'));
check(wl.includes('AMD'), 'AMD added to watchlist');
check((await page.locator('#railList .rail-row[data-sym="AMD"]').count()) === 1, 'AMD row in rail');

/* ---- 3. drawer: every range, every chart type, RSI + MACD, a drawing --------- */
log('# drawer chart');
await page.locator('#railList .rail-row[data-sym="AMD"] .rr-info').click();
await page.waitForSelector('#drawer:not([hidden]) .cp-root', { timeout: 5000 });
await wait(page, 800);
const dr = page.locator('#drawer');
const ranges = await dr.locator('.cp-range').allTextContents();
check(ranges.length >= 8, `drawer offers ${ranges.length} ranges`);
for (let i = 0; i < ranges.length; i++) {
  await dr.locator('.cp-range').nth(i).click();
  await wait(page, 350);
  const failed = await dr.locator('.cp-chart').evaluate((n) => /could not be loaded/i.test(n.textContent || ''));
  check(!failed, `range ${ranges[i]} loads`);
}
await dr.locator('.cp-range', { hasText: /^1Y$/ }).click(); await wait(page, 400);
const typeSel = dr.locator('.cp-sel').nth(1);
const types = await typeSel.locator('option').evaluateAll((os) => os.map((o) => o.value));
check(types.length >= 6, `chart types offered: ${types.join(',')}`);
for (const t of types) { await typeSel.selectOption(t); await wait(page, 200); }
await typeSel.selectOption('candle');
await dr.locator('.cp-fx').click(); await wait(page, 200);
for (const id of ['rsi', 'macd']) {
  await dr.locator('.cp-add').selectOption(id); await wait(page, 300);
}
const indNames = await dr.locator('.cp-ind-name').allTextContents();
check(indNames.some((n) => /RSI|Relative Strength/.test(n)) && indNames.some((n) => /MACD/.test(n)), `indicators on chart: ${indNames.join(', ')}`);
await dr.locator('.cp-pop .icon-mini').first().click().catch(() => {});
await shot(page, 'drawer');

// Horizontal line: pick the tool, click in the middle of the price pane.
await dr.locator('.cp-tool[data-tool="hline"]').click();
const box = await dr.locator('.cp-chart canvas').first().boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
await wait(page, 500);
const drawings = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_drawings') || '{}'));
check((drawings.AMD || []).length === 1, `drawing saved for AMD (${(drawings.AMD || []).map((d) => d.type)})`);
await page.reload(); await wait(page, 1500);
await page.locator('#railList .rail-row[data-sym="AMD"] .rr-info').click();
await page.waitForSelector('#drawer:not([hidden]) .cp-root');
await wait(page, 800);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_drawings') || '{}'));
check((after.AMD || []).length === 1, 'drawing survives reload');
const indAfter = await page.evaluate(() => (JSON.parse(localStorage.getItem('stk_settings')).chartDefaults || {}).indicators || []);
check(indAfter.length >= 2, `chart default indicators remembered (${indAfter.map((x) => x.id)})`);
await page.keyboard.press('Escape'); await wait(page, 400);
check(!(await page.locator('#drawer').isVisible()), 'Escape closes drawer');

/* ---- 4. every widget kind from the picker ------------------------------------ */
log('# widget picker');
// A scratch tab so the layout under test is not the default one.
const kinds = await page.evaluate(async () => (await import('./js/widgets.js')).WIDGETS.map((w) => w.id || w.kind));
check(kinds.length >= 20, `${kinds.length} widget kinds registered`);
for (const kind of kinds) {
  await page.click('.wk-add');
  const more = page.locator('.wk-pick-more');
  if (await more.count()) await more.click();
  const entry = page.locator(`.wk-pick[data-kind="${kind}"]`);
  if (!(await entry.count())) { check(false, `picker lists ${kind}`); await page.keyboard.press('Escape'); continue; }
  const before = await page.locator(`.wk-w[data-kind="${kind}"]`).count();
  await entry.first().click();
  await wait(page, 600);
  const n = await page.locator(`.wk-w[data-kind="${kind}"]`).count();
  const w = page.locator(`.wk-w[data-kind="${kind}"]`).last();
  const txt = n > before ? await w.innerText() : '';
  check(n > before && !FAIL_RE.test(txt), `widget ${kind} mounts`);
}
await wait(page, 2500);
const deadAll = await deadWidgets(page);
check(deadAll.length === 0, 'no failed widgets after adding every kind ' + deadAll.join(' | '));
await shot(page, 'all-widgets');

/* ---- 4b. every kind popped out (read-only ctx, cache-only data) ---------------- */
log('# widget popouts');
// Every widget kind in a window of its own (the scratch tab holds one of each).
const popKinds = await page.locator('.wk-w').evaluateAll((ws) => [...new Set(ws.map((w) => w.dataset.kind))]);
for (const kind of popKinds) {
  const btn = page.locator(`.wk-w[data-kind="${kind}"] .wk-w-pop`).first();
  if (!(await btn.count())) continue;
  await btn.scrollIntoViewIfNeeded();
  const pop = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }), btn.click()]).then(([p]) => p).catch(() => null);
  if (!pop) { check(false, `popout opens for ${kind}`); continue; }
  watch(pop, 'popout-' + kind);
  await pop.waitForLoadState('load'); await wait(pop, 1800);
  const dead = await deadWidgets(pop);
  const body = await pop.locator('body').innerText();
  check(!dead.length && !FAIL_RE.test(body), `popout of ${kind} renders ${dead.join(' | ')}`);
  await pop.close();
}

/* ---- 5. alerts: price, technical, portfolio ---------------------------------- */
log('# alerts');
async function addRule(sym, type, value, op) {
  await page.click('#btnAlerts'); await wait(page, 300);
  await page.selectOption('#ruleSym', sym); await page.locator('#ruleSym').dispatchEvent('change');
  await page.selectOption('#ruleType', type); await page.locator('#ruleType').dispatchEvent('change');
  if (op) await page.selectOption('#ruleOp', op);
  if (value != null && await page.locator('#ruleVal').isEditable()) await page.fill('#ruleVal', String(value));
  await wait(page, 300);
  await page.click('#ruleAdd'); await wait(page, 300);
  const err = (await page.locator('#ruleErr').textContent() || '').trim();
  await page.click('#alertsModal .modal-x'); await wait(page, 200);
  return err;
}
const r0 = (await page.evaluate(() => JSON.parse(localStorage.getItem('stk_rules') || '[]'))).length;
check(!(await addRule('AMD', 'price', 999, 'above')), 'price alert form accepts');
check(!(await addRule('AMD', 'rsi', 70, 'above')), 'RSI alert form accepts');
check(!(await addRule('@PORTFOLIO', 'portfolioValue', 1000, 'below')), 'portfolio alert form accepts');
// A rule that is already true must actually fire and reach the log.
await page.click('#btnAlerts'); await wait(page, 300);
await page.selectOption('#ruleSym', 'AMD'); await page.locator('#ruleSym').dispatchEvent('change');
await page.selectOption('#ruleType', 'price'); await page.locator('#ruleType').dispatchEvent('change');
await page.selectOption('#ruleOp', 'above'); await page.fill('#ruleVal', '1');
await page.evaluate(() => { const d = document.getElementById('ruleMore'); if (d && 'open' in d) d.open = true; });
await page.selectOption('#ruleSess', 'any');
await page.click('#ruleAdd'); await wait(page, 200);
await page.click('#alertsModal .modal-x');
let fired = false;
for (let i = 0; i < 25 && !fired; i++) {
  await wait(page, 2000);
  fired = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_alertlog') || '[]').some((e) => /AMD/.test(JSON.stringify(e))));
}
check(fired, 'an already-true AMD price rule fires and is logged');
const rules = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_rules') || '[]'));
check(rules.length === r0 + 4, `4 rules stored (${rules.map((r) => r.symbol + ':' + r.type).join(', ')})`);

/* ---- 6. ledger: buy, sell, dividend → realized P/L --------------------------- */
log('# ledger');
async function txn(type, fields) {
  await page.click('#ledAdd'); await wait(page, 200);
  await page.selectOption('#txType', type); await page.locator('#txType').dispatchEvent('change');
  for (const [id, v] of Object.entries(fields)) { await page.fill(id, String(v)); await page.locator(id).dispatchEvent('change'); }
  await page.click('#txSave'); await wait(page, 300);
  const open = await page.locator('#txnModal').isVisible();
  if (open) { log('    txn error:', await page.locator('#txErr').textContent()); await page.click('#txnModal .modal-x'); }
  return !open;
}
await page.click('#btnHoldings'); await wait(page, 300);
check(await txn('buy', { '#txSym': 'AMD', '#txDate': '2025-01-10', '#txQty': 10, '#txPrice': 100 }), 'buy saved');
check(await txn('sell', { '#txSym': 'AMD', '#txDate': '2025-06-10', '#txQty': 4, '#txPrice': 150 }), 'sell saved');
check(await txn('dividend', { '#txSym': 'AMD', '#txDate': '2025-07-01', '#txAmount': 5 }), 'dividend saved');
const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_ledger') || '[]'));
check(ledger.filter((t) => t.symbol === 'AMD').length === 3, 'three AMD transactions stored');

// CSV import through the wizard.
await page.click('#ledImport'); await wait(page, 200);
await page.setInputFiles('#impFile', join(ROOT, 'tests/fixtures/schwab.csv'));
await wait(page, 700);
const summary = (await page.locator('#impSummary').textContent()) || '';
check(/\d/.test(summary), `import summary: ${summary.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
await page.click('#impGo'); await wait(page, 500);
const ledger2 = await page.evaluate(() => JSON.parse(localStorage.getItem('stk_ledger') || '[]'));
check(ledger2.length > ledger.length, `import added ${ledger2.length - ledger.length} transactions`);
if (await page.locator('#ledgerModal').isVisible()) await page.click('#ledgerModal .modal-x');
await wait(page, 300);

// Realized P/L on the portfolio widget: (150 − 100) × 4 = +200 before fees.
await page.click('#viewPort'); await wait(page, 2000);
const pw = page.locator('.wk-w[data-kind="portfolio"]').first();
check(await pw.count() > 0, 'portfolio widget on the Portfolio tab');
const fullBtn = pw.locator('.seg-btn', { hasText: /^Full$/ });
if (await fullBtn.count()) { await fullBtn.click(); await wait(page, 500); }
const ptext = await pw.innerText();
const amdRow = await pw.locator('tbody tr').evaluateAll((trs) => (trs.find((tr) => (tr.cells[0]?.textContent || '').trim().startsWith('AMD'))?.innerText) || '');
check(/\+\$?200\.00/.test(amdRow), `portfolio AMD row shows realized +200 (${amdRow.replace(/\s+/g, ' ')})`);
await wait(page, 2000);
const deadP = await deadWidgets(page);
check(deadP.length === 0, 'portfolio tab has no failed widgets ' + deadP.join(' | '));
await shot(page, 'portfolio');

/* ---- 7. popout --------------------------------------------------------------- */
log('# popout');
const popBtn = pw.locator('.wk-w-pop');
if (await popBtn.count()) {
  const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }), popBtn.click()]);
  watch(pop, 'popout');
  await pop.waitForLoadState('load'); await wait(pop, 2500);
  const t = await pop.locator('body').innerText();
  check(!FAIL_RE.test(t) && t.length > 20 && !(await pop.locator(DEAD).count()), 'portfolio popout renders');
  await shot(pop, 'popout');
  await pop.close();
} else check(false, 'portfolio widget has a pop-out button');
for (const panel of ['board', 'ticker', 'strip']) {
  const p = await newPage(ctx, 'popout-' + panel);
  await p.goto(BASE + 'popout.html?panel=' + panel); await wait(p, 1500);
  check(!FAIL_RE.test(await p.locator('body').innerText()) && !(await p.locator(DEAD).count()), `popout panel ${panel} renders`);
  await p.close();
}

/* ---- 8. languages ------------------------------------------------------------ */
log('# languages');
// A sample of keys that sit in static markup and in JS-built UI.
const SAMPLE = ['Settings', 'Alerts', 'Watchlist', 'Transactions', 'Indicators', 'Realized'];
for (const lang of ['es', 'pt-BR', 'ja', 'ru']) {
  await page.goto(BASE + 'index.html?lang=' + encodeURIComponent(lang)); await wait(page, 1800);
  const res = await page.evaluate((keys) => keys.map((k) => [k, window.CarinoI18n.t(k)]), SAMPLE);
  const raw = res.filter(([k, v]) => k === v).map(([k]) => k);
  check(raw.length === 0, `${lang}: sample keys translated${raw.length ? ' (raw: ' + raw.join(', ') + ')' : ''}`);
  const btn = (await page.locator('#btnSettings').getAttribute('title') || '').trim();
  check(btn && btn !== 'Settings', `${lang}: settings button title reads "${btn}"`);
  const disc = (await page.locator('#pageDisclaimer').textContent() || '').trim();
  check(!disc.startsWith('Not investment advice'), `${lang}: disclaimer translated`);
  await shot(page, 'lang-' + lang);
}
await page.goto(BASE + 'index.html?lang=en'); await wait(page, 1000);

/* ---- 9. phone width ---------------------------------------------------------- */
log('# phone');
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', storageState: await ctx.storageState(), hasTouch: true, isMobile: true });
await phone.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
const pp = await newPage(phone, 'phone');
await pp.goto(BASE + 'index.html'); await wait(pp, 2000);
for (const tab of ['#viewWatch', '#viewPort']) {
  await pp.evaluate((s) => document.querySelector(s).click(), tab); await wait(pp, 1500);
  check(await noHScroll(pp), `390px ${tab}: no horizontal scroll`);
}
for (const m of ['#btnAlerts', '#btnHoldings', '#btnSettings']) {
  await pp.evaluate((s) => document.querySelector(s).click(), m); await wait(pp, 400);
  check(await noHScroll(pp), `390px ${m} dialog: no horizontal scroll`);
  await pp.keyboard.press('Escape'); await wait(pp, 200);
}
await pp.evaluate(() => document.querySelector('#railList .rail-row[data-sym="AMD"] .rr-info')?.click());
await wait(pp, 1200);
check(await noHScroll(pp), '390px drawer: no horizontal scroll');
await shot(pp, 'phone-drawer');
await phone.close();

await ctx.close();
await browser.close();
server.close();

log('');
if (errors.length) { log(`${errors.length} console/page error(s):`); for (const e of errors) log('  ' + e); }
if (failures.length) { log(`${failures.length} failed check(s):`); for (const f of failures) log('  ' + f); }
if (errors.length || failures.length) process.exit(1);
log('smoke: all checks passed');
