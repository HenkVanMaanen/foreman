import { chromium } from 'playwright';
const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const b = page.locator('button[name="mock_user"][value="admin"]'); if (await b.count()) await b.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});

// Poll for the new x-init settle marker to be deployed (bounded).
let deployed = false;
for (let i = 0; i < 40; i++) { // up to ~40 * 15s = 10 min
  await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle', timeout: 45000 });
  const html = await page.content();
  if (html.includes('requestAnimationFrame(settle)')) { deployed = true; console.log('DEPLOYED after', i, 'polls'); break; }
  console.log('poll', i, 'not yet deployed, waiting 15s...');
  await page.waitForTimeout(15000);
}
if (!deployed) { console.log('NOT_DEPLOYED_TIMEOUT'); await browser.close(); process.exit(2); }

await page.waitForTimeout(700);
const sb = page.locator('ul.cons-wb-scroll li button.cons-wb-rij'); const n = await sb.count();
for (let i=0;i<n;i++){const bb=sb.nth(i);const l=(await bb.innerText().catch(()=>''));if(/[1-9]\d* te doen/.test(l)){await bb.click().catch(()=>{});break;}}
await page.waitForTimeout(900);
const volgende = page.locator('button[name="volgende"]').first();
await volgende.click().catch(e => console.log('click err', e.message));
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(1800);
const m = await page.evaluate(() => {
  const d = document.querySelector('#wb-detail');
  const r = d ? d.getBoundingClientRect() : null;
  const grid = document.querySelector('.cons-wb-grid');
  const kids = grid ? [...grid.children].map((c,i)=>{const rr=c.getBoundingClientRect(); return {i, docTop: Math.round(rr.top+window.scrollY), h: Math.round(rr.height)};}) : [];
  return { hash: location.hash, scrollY: Math.round(window.scrollY), detailVpTop: r ? Math.round(r.top) : null, detailDocTop: r ? Math.round(r.top+window.scrollY) : null, vh: window.innerHeight, kids };
});
console.log('AFTER_VOLGENDE_FIXED:', JSON.stringify(m));
await page.screenshot({ path: '/home/dev/foreman/state/shots/werkbank-volgende-scroll-fixed.png', fullPage: false });
await browser.close();
console.log('DONE');
