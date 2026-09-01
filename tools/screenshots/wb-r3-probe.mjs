import { chromium } from 'playwright';
const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const adminBtn = page.locator('button[name="mock_user"][value="admin"]');
if (await adminBtn.count()) await adminBtn.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);

// status facet option labels
const facet = await page.evaluate(() => {
  // find the status filter facet: labels/links containing status choices
  const txt = [];
  document.querySelectorAll('a,label,option,li').forEach(el => {
    const t = (el.innerText||'').trim();
    if (/Nog te doen|Concept|Geparkeerd|Afgehandeld|behandeling/i.test(t) && t.length < 60) txt.push(t.replace(/\s+/g,' '));
  });
  return [...new Set(txt)];
});
console.log('FACET_LABELS:', JSON.stringify(facet));

// click first section
const sectionBtns = page.locator('ul.cons-wb-scroll li button.cons-wb-rij');
const n = await sectionBtns.count();
for (let i=0;i<n;i++){const b=sectionBtns.nth(i);const l=(await b.innerText().catch(()=>''));if(/[1-9]\d* te doen/.test(l)){await b.click().catch(()=>{});break;}}
await page.waitForTimeout(900);

const post = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  // detail card region
  const detail = document.querySelector('#wb-detail');
  const detailText = detail ? detail.innerText.replace(/\s+/g,' ').slice(0,400) : '(no #wb-detail)';
  return {
    opmerkingCaption: (html.match(/>Opmerking</g) || []).length,
    wijzigingsvoorstelCaption: (html.match(/Wijzigingsvoorstel/g) || []).length,
    detailHasOpmerking: /Opmerking/.test(detailText),
    detailSnippet: detailText,
  };
});
console.log('POST_CLICK:', JSON.stringify(post, null, 1));
await browser.close();
console.log('DONE');
