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
const volgende = page.locator('button[name="volgende"]').first();
await volgende.click().catch(e => console.log('click err', e.message));
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
// Sample the detail top over time to watch it drift after load
for (const t of [0, 150, 400, 800, 1500]) {
  await page.waitForTimeout(t === 0 ? 0 : (t - (t===150?0:t===400?150:t===800?400:800)));
}
await page.waitForTimeout(1500);
const m = await page.evaluate(() => {
  const rect = (sel) => { const e = document.querySelector(sel); if(!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top+window.scrollY), h: Math.round(r.height), vpTop: Math.round(r.top) }; };
  const grid = document.querySelector('.cons-wb-grid');
  const kids = grid ? [...grid.children].map((c,i)=>{const r=c.getBoundingClientRect(); return {i, top: Math.round(r.top+window.scrollY), h: Math.round(r.height)};}) : [];
  return { scrollY: Math.round(window.scrollY), hash: location.hash,
    detail: rect('#wb-detail'), kids };
});
console.log('DIAGNOSE:', JSON.stringify(m, null, 1));
await browser.close();
