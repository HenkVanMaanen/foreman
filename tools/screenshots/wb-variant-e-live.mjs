// Variant E (2x2 grid werkbank) — live shots against the deployed beheerder-workspace preview.
// LEFT: sectie-overzicht (top) + sectietekst (bottom); RIGHT: feedback-overzicht (top) +
// chosen feedback + behandelformulier (bottom). Fixed-height scrollable overviews, native
// enlarged <details> triangles. Also verifies variant-E markers are live on the page.
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

// verify variant-E markers are live (pod rolled out)
const markers = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  return {
    grid: (html.match(/cons-wb-grid/g) || []).length,
    scroll: (html.match(/cons-wb-scroll/g) || []).length,
    vouw: (html.match(/cons-vouw/g) || []).length,
    sectieOverzicht: html.includes('Sectie-overzicht'),
    feedbackOverzicht: html.includes('Feedback-overzicht'),
    oldChrome: html.includes('Samen beantwoorden'),
    wbDetailAnchor: html.includes('id="wb-detail"'),
    localTime: html.includes('localTime'),
    overigeReacties: html.includes('Overige reacties'),
    // round-3 markers
    opmerkingCaption: (html.match(/>Opmerking</g) || []).length,
    inBehandelingAnywhere: html.includes('In behandeling') || html.includes('in behandeling'),
  };
});
console.log('MARKERS:', JSON.stringify(markers));

// shot 1: overview — both overviews visible before a section is picked
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/werkbank-variant-e-1-overzicht.png`, fullPage: false });
console.log('shot 1 (overzicht) saved');

// pick the first section that has open opmerkingen ("te doen")
const sectionBtns = page.locator('ul.cons-wb-scroll li button.cons-wb-rij');
const n = await sectionBtns.count();
console.log('section buttons found:', n);
let clicked = false;
for (let i = 0; i < n; i++) {
  const btn = sectionBtns.nth(i);
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (/[1-9]\d* te doen/.test(label)) { await btn.click().catch(() => {}); clicked = true; console.log('clicked section:', JSON.stringify(label)); break; }
}
if (!clicked && n) { await sectionBtns.first().click().catch(() => {}); clicked = true; console.log('clicked first section (fallback)'); }
await page.waitForTimeout(900);

// shot 2: detail — 2x2 grid with section text (left-bottom) + feedback + behandelform (right-bottom)
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/werkbank-variant-e-2-detail.png`, fullPage: false });
console.log('shot 2 (detail) saved');

// shot 3: narrow viewport -> stacking in reading order
await page.setViewportSize({ width: 720, height: 1200 });
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/werkbank-variant-e-3-smal.png`, fullPage: true });
console.log('shot 3 (smal) saved');

await browser.close();
console.log('DONE');
