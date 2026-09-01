// SEED video walkthrough of the consultatie beheerder werkbank — proves the new
// richer seed data makes Zoeken (search) + the left-rail filters actually work.
// Records a .webm (recordVideo) while narrating-by-motion, and smoke-asserts the
// REAL counts observed in the UI. Driven LOCALLY against http://localhost:8080
// (booted by scripts/vid-serve.sh with testdata/data pre-seeded).
//
// Based on tools/screenshots/video-walk.mjs (same check()/helper patterns).
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:8080';
const RAW = '/home/dev/foreman/state/video-raw-seed';
fs.mkdirSync(RAW, { recursive: true });
const SLUG = 'voorbeeld';
const WB = BASE + '/beheer/werkbank/' + SLUG;

const asserts = [];
function check(name, cond, detail = '') {
  asserts.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const W = 1440, H = 900;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: W, height: H },
  recordVideo: { dir: RAW, size: { width: W, height: H } },
});
const page = await ctx.newPage();

const wait = (ms) => page.waitForTimeout(ms);
async function settleMouse(x = W / 2, y = H / 2) { await page.mouse.move(x, y, { steps: 12 }); }
async function moveToEl(loc) {
  try { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox();
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 }); } catch {}
}
async function scrollTour(ys = [300, 700, 1200, 700, 0]) {
  for (const y of ys) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'smooth' }), y);
    await wait(650);
  }
}
async function shownCount() {
  const t = await page.locator('p[role="status"]').first().innerText().catch(() => '');
  const clean = t.replace(/\s+/g, ' ').trim();
  const m = clean.match(/(\d+)\s+van\s+(\d+)/);
  return { shown: m ? +m[1] : null, total: m ? +m[2] : null, text: clean };
}
function toepassen() {
  return page.locator('button[type="submit"]').filter({ hasText: 'Toepassen' }).first();
}
async function resetWerkbank() {
  await page.goto(WB, { waitUntil: 'networkidle' });
  await wait(700);
}

const observed = { searches: [], filters: [] };

try {
  // ---- login (admin via mock-idp) ----
  await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.click('button[name="mock_user"][value="admin"]');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await wait(1000);

  // ---- 1. land on the werkbank; show "31 van 31 reacties" + variety ----
  await page.goto(WB, { waitUntil: 'networkidle' });
  await wait(1400);
  const landing = await shownCount();
  check('werkbank loads with 31 van 31 reacties', landing.shown === 31 && landing.total === 31, landing.text);
  const railRows = await page.locator('li.cons-werkbank-row').count();
  check('reacties rail shows 31 rows', railRows === 31, `rows=${railRows}`);
  await settleMouse();
  await wait(600);
  // scroll the list so the variety of orgs / prioriteit / soort / status badges is visible
  await scrollTour([400, 900, 1500, 2200, 1200, 0]);

  // ---- 2. ZOEKEN (search) ----
  async function doSearch(q, expect) {
    const box = page.locator('#wb-q');
    await moveToEl(box); await box.click(); await box.fill(''); await wait(300);
    for (const ch of q) { await box.type(ch, { delay: 0 }); await wait(90); }
    await wait(600);
    const btn = toepassen();
    await moveToEl(btn); await wait(400); await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await wait(1200);
    const c = await shownCount();
    observed.searches.push({ q, expect, shown: c.shown, total: c.total });
    check(`Zoeken "${q}" -> ${expect}`, c.shown === expect, `observed ${c.shown}/${c.total} :: ${c.text}`);
    await wait(1100); // pause so the narrowed list is readable
  }
  await doSearch('Digikoppeling', 1);
  await doSearch('herstelperiode', 2);
  await doSearch('bewaartermijn', 1);
  // clear the search back to 31
  {
    const box = page.locator('#wb-q');
    await moveToEl(box); await box.click(); await box.fill(''); await wait(400);
    const btn = toepassen(); await moveToEl(btn); await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await wait(1100);
    const c = await shownCount();
    check('clearing Zoeken restores 31', c.shown === 31, `observed ${c.shown}/${c.total}`);
  }

  // ---- 3. FILTERS: exercise EACH facet one at a time, reset between ----
  async function doFilter(selId, name, value, expect) {
    await resetWerkbank();
    const sel = page.locator(selId);
    await moveToEl(sel); await wait(500);
    await sel.selectOption(value);
    await wait(700);
    const btn = toepassen();
    await moveToEl(btn); await wait(400); await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await wait(1200);
    const c = await shownCount();
    observed.filters.push({ facet: name, value, expect, shown: c.shown, total: c.total });
    check(`Filter ${name}=${value} -> ${expect}`, c.shown === expect, `observed ${c.shown}/${c.total} :: ${c.text}`);
    await wait(1100); // pause ~1s so the result is readable
  }
  // Status
  await doFilter('#wb-status', 'status', 'nog_te_doen', 12);
  await doFilter('#wb-status', 'status', 'in_behandeling', 9);
  await doFilter('#wb-status', 'status', 'afgehandeld', 10);
  // Prioriteit
  await doFilter('#wb-prio', 'prioriteit', 'hoog', 8);
  // Soort
  await doFilter('#wb-soort', 'soort', 'redactioneel', 6);
  await doFilter('#wb-soort', 'soort', 'inhoudelijk', 16);
  // Organisatie
  await doFilter('#wb-org', 'org', 'Kadaster', 2);

  // ---- 4. open ONE reactie -> editor: Oordeel select + Achterhaald combobox reveal ----
  await resetWerkbank();
  const firstReactie = page.locator('a.cons-werkbank-open').first();
  check('reactie link exists in rail', await firstReactie.count() >= 1);
  const reactieTitle = (await firstReactie.innerText().catch(() => '')).slice(0, 80);
  await moveToEl(firstReactie); await wait(800);
  await firstReactie.click();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await wait(1400);
  const selId = new URL(page.url()).searchParams.get('sel') || '';
  const editorForm = page.locator('form').filter({ has: page.locator('#wb-oordeel') }).first();
  const oordeel = editorForm.locator('#wb-oordeel');
  check('editor opens (#wb-oordeel present)', await oordeel.count() >= 1, `sel=${selId}`);
  await moveToEl(oordeel); await wait(900);

  // set Oordeel = Achterhaald -> the "Ingehaald door" combobox should reveal
  await oordeel.selectOption('achterhaald');
  await oordeel.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await wait(1400);
  const combo = page.locator('#wb-ingehaald');
  const comboVisible = await combo.isVisible().catch(() => false);
  check('Achterhaald reveals the Ingehaald-door combobox', comboVisible, `visible=${comboVisible}`);
  const hidden = page.locator('input[type="hidden"][name="ingehaald_door"]');
  check('hidden ingehaald_door field present', await hidden.count() >= 1);

  // type a few letters, show the name-vs-UUID combobox
  let visVal = '', hiddenVal = '', optionTexts = [];
  if (comboVisible) {
    await moveToEl(combo); await combo.click(); await combo.fill(''); await wait(400);
    for (const ch of 'Kad') { await combo.type(ch, { delay: 0 }); await wait(300); }
    await wait(1000);
    optionTexts = await page.locator('[role="listbox"] [role="option"]').allTextContents().catch(() => []);
    check('typing "Kad" yields >=1 name suggestion', optionTexts.length >= 1, `${optionTexts.length} options`);
    const firstOpt = page.locator('[role="listbox"] [role="option"]').first();
    if (await firstOpt.count()) {
      await moveToEl(firstOpt); await wait(700); await firstOpt.click(); await wait(1200);
      visVal = await combo.inputValue().catch(() => '');
      hiddenVal = await hidden.inputValue().catch(() => '');
      check('combobox visible value is a human NAME (not a UUID)', visVal.length > 0 && !UUID_RE.test(visVal), `visible="${visVal}"`);
      check('combobox hidden ingehaald_door is a UUID', UUID_RE.test(hiddenVal), `hidden="${hiddenVal}"`);
    }
  }
  console.log('COMBOBOX PROOF -> visible(name)=%j hidden(uuid)=%j suggestions=%j', visVal, hiddenVal, optionTexts);
  await wait(1400);
  // NOTE: read-only tour — deliberately NOT submitting/saving.

  // ---- 5. /doc/voorbeeld renders the real FDS content, no drift notice ----
  await page.goto(BASE + '/doc/' + SLUG, { waitUntil: 'networkidle' });
  await wait(1400);
  const docBody = await page.locator('body').innerText().catch(() => '');
  const hasTitle = /federatief datastelsel/i.test(docBody);
  const hasAfspraak = /afspra/i.test(docBody);
  const drift = /verouderd|drift|niet meer actueel|gewijzigd sinds/i.test(docBody);
  check('/doc/voorbeeld renders real FDS content (title)', hasTitle, `len=${docBody.length}`);
  check('/doc/voorbeeld shows an afspraak/afspraken', hasAfspraak);
  check('/doc/voorbeeld shows NO drift/verouderd notice', !drift);
  await scrollTour([300, 800, 1400, 800, 0]);
  await wait(1200);

  fs.writeFileSync(RAW + '/observed.json', JSON.stringify({
    landing, railRows, observed, reactie: { selId, reactieTitle },
    combobox: { visibleName: visVal, hiddenUuid: hiddenVal, suggestions: optionTexts },
  }, null, 2));
} catch (e) {
  console.error('WALK ERROR:', (e && e.stack) || e);
  asserts.push({ name: 'walk completed without exception', pass: false, detail: String((e && e.message) || e) });
} finally {
  const video = page.video();
  await ctx.close(); // flush .webm
  const vpath = video ? await video.path().catch(() => null) : null;
  await browser.close();
  const failed = asserts.filter((a) => !a.pass);
  console.log('\n===== ASSERTION SUMMARY =====');
  for (const a of asserts) console.log(`[${a.pass ? 'PASS' : 'FAIL'}] ${a.name}${a.detail ? ' :: ' + a.detail : ''}`);
  console.log(`\nTOTAL: ${asserts.length}  PASS: ${asserts.length - failed.length}  FAIL: ${failed.length}`);
  console.log('VIDEO_PATH=' + (vpath || '(unknown)'));
  fs.writeFileSync(RAW + '/asserts.json', JSON.stringify({ asserts, videoPath: vpath, observed }, null, 2));
  console.log('DONE');
}
