import { chromium } from 'playwright';
const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const OUT = '/home/dev/foreman/state/shots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const b = page.locator('button[name="mock_user"][value="admin"]'); if (await b.count()) await b.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(700);
// pick a section with open items
const sb = page.locator('ul.cons-wb-scroll li button.cons-wb-rij'); const n = await sb.count();
for (let i=0;i<n;i++){const bb=sb.nth(i);const l=(await bb.innerText().catch(()=>''));if(/[1-9]\d* te doen/.test(l)){await bb.click().catch(()=>{});break;}}
await page.waitForTimeout(900);
// scroll the detail card (#wb-detail) into view so both captions show
await page.evaluate(() => { const d = document.querySelector('#wb-detail'); if (d) d.scrollIntoView({block:'center'}); });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/werkbank-variant-e-4-captions.png`, fullPage: false });
console.log('caption shot saved');
await browser.close();
console.log('DONE');
