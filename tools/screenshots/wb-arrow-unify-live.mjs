// Werkbank arrow-unify (7af0a65) — live shots against the deployed preview.
// Verifies all THREE disclosure collapsibles render the SAME custom ▸/▾ chevron
// (no native browser triangle): Voortgang, Secties header, and the detail-view
// "Alle opmerkingen op deze sectie" <details> (the one that was the odd-one-out).
import { chromium } from 'playwright';

const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const SLUG = 'voorbeeld';
const OUT = '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();

await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const adminBtn = page.locator('button[name="mock_user"][value="admin"]');
if (await adminBtn.count()) await adminBtn.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});

await page.goto(BASE + `/beheer/werkbank/${SLUG}`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);
console.log('werkbank url:', page.url());

// open a section with open opmerkingen so the detail view renders
const sectionBtns = page.locator('#wb-sectielijst ul li button');
const n = await sectionBtns.count();
let clicked = false;
for (let i = 0; i < n; i++) {
  const btn = sectionBtns.nth(i);
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (/te doen van/.test(label)) { await btn.click().catch(() => {}); clicked = true; console.log('clicked section:', JSON.stringify(label)); break; }
}
if (!clicked && n) { await sectionBtns.first().click().catch(() => {}); console.log('clicked first section (fallback)'); }
await page.waitForTimeout(900);

// find + expand the "Alle opmerkingen op deze sectie" <details>
const details = page.locator('details:has(summary:has-text("Alle opmerkingen op deze sectie"))').first();
if (await details.count()) {
  await details.locator('summary').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await details.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
}

// read every rendered custom chevron glyph on the page to prove parity
const chevrons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('summary span[aria-hidden] span, span[aria-hidden]'))
    .map(s => (s.innerText || '').trim())
    .filter(g => g === '▸' || g === '▾'); // ▸ ▾
});
console.log('custom chevron glyphs found:', JSON.stringify(chevrons));

// confirm the "Alle opmerkingen" summary has a custom chevron and no native marker
const alleOpm = await page.evaluate(() => {
  const det = Array.from(document.querySelectorAll('details'))
    .find(d => /Alle opmerkingen op deze sectie/.test(d.querySelector('summary')?.innerText || ''));
  if (!det) return { found: false };
  const sum = det.querySelector('summary');
  const marker = getComputedStyle(sum, '::-webkit-details-marker').display;
  const chev = sum.querySelector('span[aria-hidden]')?.innerText?.trim() || null;
  return { found: true, open: det.open, group: det.className.includes('group'), listNone: sum.className.includes('list-none'), chevron: chev };
});
console.log('alle-opmerkingen details:', JSON.stringify(alleOpm));

// shot: the detail view with the "Alle opmerkingen" details expanded, showing its chevron next to Secties/Voortgang
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/wb-arrow-unify-1-detail.png`, fullPage: false });
console.log('shot 1 (detail view, top) saved');

// tight shot of the alle-opmerkingen details itself
const detEl = page.locator('details:has(summary:has-text("Alle opmerkingen op deze sectie"))').first();
if (await detEl.count()) {
  await detEl.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await detEl.screenshot({ path: `${OUT}/wb-arrow-unify-2-alleopm.png` });
  console.log('shot 2 (alle-opmerkingen details) saved');
}

await browser.close();
console.log('DONE');
