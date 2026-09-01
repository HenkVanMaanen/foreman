import { chromium } from 'playwright';
const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const b = page.locator('button[name="mock_user"][value="admin"]');
if (await b.count()) await b.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(()=>{});
await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);

const cards = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('p[id^="wb-d-"]').forEach(p => {
    const heading = (p.textContent || '').replace(/\s+/g,' ').trim();
    let sub = '';
    const next = p.nextElementSibling;
    if (next && next.tagName === 'P') sub = (next.textContent||'').replace(/\s+/g,' ').trim();
    out.push({ heading, sub });
  });
  return out;
});
const withSubtitle = cards.filter(c => c.sub.includes('·'));
console.log('TOTAL_CARDS=' + cards.length + ' WITH_NAME_SUBTITLE=' + withSubtitle.length);
console.log(JSON.stringify(cards.slice(0, 8), null, 2));
await browser.close();
