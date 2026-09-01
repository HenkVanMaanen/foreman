import { chromium } from 'playwright';
const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const b = page.locator('button[name="mock_user"][value="admin"]'); if (await b.count()) await b.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(700);
const sb = page.locator('ul.cons-wb-scroll li button.cons-wb-rij'); const n = await sb.count();
for (let i=0;i<n;i++){const bb=sb.nth(i);const l=(await bb.innerText().catch(()=>''));if(/[1-9]\d* te doen/.test(l)){await bb.click().catch(()=>{});break;}}
await page.waitForTimeout(900);
// click "Opslaan en volgende"
const volgende = page.locator('button[name="volgende"], button:has-text("Opslaan en volgende")').first();
console.log('volgende button count:', await page.locator('button:has-text("Opslaan en volgende")').count());
await volgende.click().catch(e => console.log('click err', e.message));
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(1200);
const measure = await page.evaluate(() => {
  const d = document.querySelector('#wb-detail');
  const r = d ? d.getBoundingClientRect() : null;
  return { hash: location.hash, scrollY: Math.round(window.scrollY), detailTopInViewport: r ? Math.round(r.top) : null, vh: window.innerHeight };
});
console.log('AFTER_VOLGENDE:', JSON.stringify(measure));
// detailTopInViewport small/near-0 => scrolled to detail; large (~ full page height) => stayed at top
await page.screenshot({ path: '/home/dev/foreman/state/shots/werkbank-variant-e-5-after-volgende.png', fullPage: false });
await browser.close();
console.log('DONE');
