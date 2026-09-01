// Variant D live-preview shots against the deployed beheerder-workspace preview.
// OIDC mock-admin login on the LIVE host, open the werkbank, select a reactie,
// capture the two-column detail band (section text left, comment + form right).
import { chromium } from 'playwright';

const BASE = process.env.WB_BASE || 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const SLUG = process.env.WB_SLUG || 'voorbeeld';
const OUT = process.env.WB_OUT || '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();

// --- OIDC mock-admin login (follows redirect to the mock IDP host) ---
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(500);
const adminBtn = page.locator('button[name="mock_user"][value="admin"]');
if (await adminBtn.count()) {
  await adminBtn.first().click();
} else {
  console.log('WARN: admin mock button not found; page url =', page.url());
  console.log('BODY SNIPPET:', (await page.content()).slice(0, 400));
}
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});

// --- open the werkbank ---
await page.goto(BASE + `/beheer/werkbank/${SLUG}`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);
console.log('werkbank url:', page.url());
const status = await page.locator('p[role="status"]').first().innerText().catch(() => '(none)');
console.log('COUNT:', JSON.stringify(status.replace(/\s+/g, ' ').trim()));

// shot 1: overview / list
await page.screenshot({ path: `${OUT}/werkbank-variant-d-live-1-lijst.png`, fullPage: false });
console.log('shot 1 (lijst) saved');

// --- variant D: pick a section from the (Alpine) list to open the detail band ---
// The section list is the `lijstOpen` block; each section is a left-aligned
// <button> whose @click sets `sectie` and collapses the list, revealing the
// two-column band (section text left, opmerking + form right). Pick a section
// that has open opmerkingen so the band + Behandeling form are populated.
const sectionBtns = page.locator('div[x-show="lijstOpen"] ul li button.text-left');
const n = await sectionBtns.count();
console.log('section buttons found:', n);
let clicked = false;
for (let i = 0; i < n; i++) {
  const btn = sectionBtns.nth(i);
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  // prefer a section still "... te doen van ..." (has open opmerkingen)
  if (/te doen van/.test(label)) {
    await btn.click().catch(() => {});
    clicked = true;
    console.log('clicked section:', JSON.stringify(label));
    break;
  }
}
if (!clicked && n) {
  await sectionBtns.first().click().catch(() => {});
  clicked = true;
  console.log('clicked first section (fallback)');
}
if (!clicked) console.log('WARN: no section button found to click');
await page.waitForTimeout(900); // Alpine x-show toggle, no navigation
console.log('after-select url:', page.url());

// shot 2: the two-column detail band (section text left, comment + form right)
await page.locator('.cons-wb-band').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => console.log('WARN: cons-wb-band not visible'));
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/werkbank-variant-d-live-2-detail.png`, fullPage: false });
console.log('shot 2 (detail) saved');

// full-page detail for the record
await page.screenshot({ path: `${OUT}/werkbank-variant-d-live-3-detail-full.png`, fullPage: true });
console.log('shot 3 (detail full) saved');

// shot 4: narrow viewport -> stacking
await page.setViewportSize({ width: 720, height: 1100 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/werkbank-variant-d-live-4-narrow.png`, fullPage: true });
console.log('shot 4 (narrow/stacked) saved');

await browser.close();
console.log('VARIANT D LIVE SHOTS DONE');
