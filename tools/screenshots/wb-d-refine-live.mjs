// Variant D refinements — live shots against the deployed beheerder-workspace preview.
// Captures: list, detail (collapsible Secties header + two-column band), focus/zoom ON,
// the Behandeling form (fixed oordeel/status lists), and narrow/stacked.
import { chromium } from 'playwright';

const BASE = process.env.WB_BASE || 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const SLUG = process.env.WB_SLUG || 'voorbeeld';
const OUT = process.env.WB_OUT || '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();

await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const adminBtn = page.locator('button[name="mock_user"][value="admin"]');
if (await adminBtn.count()) await adminBtn.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});

await page.goto(BASE + `/beheer/werkbank/${SLUG}`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);
console.log('werkbank url:', page.url());

// shot 1: overview / list (edge padding visible on the wide layout)
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/wb-d-ref-1-lijst.png`, fullPage: false });
console.log('shot 1 (lijst) saved');

// pick a section that still has open opmerkingen
const sectionBtns = page.locator('#wb-sectielijst ul li button');
const n = await sectionBtns.count();
console.log('section buttons found:', n);
let clicked = false;
for (let i = 0; i < n; i++) {
  const btn = sectionBtns.nth(i);
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (/te doen van/.test(label)) { await btn.click().catch(() => {}); clicked = true; console.log('clicked section:', JSON.stringify(label)); break; }
}
if (!clicked && n) { await sectionBtns.first().click().catch(() => {}); clicked = true; console.log('clicked first section (fallback)'); }
await page.waitForTimeout(900);

// shot 2: two-column detail band + the persistent collapsible Secties header
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/wb-d-ref-2-detail.png`, fullPage: false });
console.log('shot 2 (detail) saved');

// shot 3: 'In context' focus toggle ON -> left column zooms to just the passage
const focusToggle = page.locator('input[x-model="focus"]:visible').first();
if (await focusToggle.count()) {
  await focusToggle.check().catch(() => {});
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/wb-d-ref-3-focus.png`, fullPage: false });
  console.log('shot 3 (focus on) saved');
  await focusToggle.uncheck().catch(() => {});
  await page.waitForTimeout(400);
} else console.log('WARN: focus toggle not found');

// shot 4: the Behandeling form (fixed oordeel + status selects) — scroll to it
const oordeel = page.locator('select[name="oordeel"]:visible').first();
if (await oordeel.count()) {
  await oordeel.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/wb-d-ref-4-behandeling.png`, fullPage: false });
  console.log('shot 4 (behandeling form) saved');
} else console.log('WARN: oordeel select not visible');

// shot 5: narrow viewport -> stacking
await page.setViewportSize({ width: 720, height: 1100 });
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/wb-d-ref-5-narrow.png`, fullPage: true });
console.log('shot 5 (narrow) saved');

await browser.close();
console.log('DONE');
