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

const info = await page.evaluate(() => {
  const out = {};
  // things with x-show / x-data / @click referencing our alpine vars
  const grab = (sel) => Array.from(document.querySelectorAll(sel)).slice(0,6).map(e => (e.outerHTML||'').slice(0,160));
  out.xshow_lijstOpen = grab('[x-show*="lijstOpen"]');
  out.xshow_focus = grab('[x-show*="focus"]');
  out.focus_toggle = grab('[\\@click*="focus"], [x-on\\:click*="focus"], [\\:class*="focus"], input[type=checkbox]');
  out.selects = Array.from(document.querySelectorAll('select')).map(s => ({ name: s.getAttribute('name')||s.getAttribute('x-model')||'', opts: Array.from(s.options).map(o=>o.text.trim()) }));
  // buttons that look like section entries
  const btns = Array.from(document.querySelectorAll('button')).filter(b => /te doen van|opmerking|van \d/i.test(b.textContent||''));
  out.sectionish_btns = btns.slice(0,5).map(b => ({ txt: (b.textContent||'').replace(/\s+/g,' ').trim().slice(0,60), cls: (b.className||'').slice(0,80) }));
  // "Secties" header / collapse toggle text
  const heads = Array.from(document.querySelectorAll('button,h2,h3,summary,div')).filter(e => /^\s*Secties\b/.test(e.textContent||'') && (e.textContent||'').length < 40);
  out.secties_header = heads.slice(0,4).map(e => ({ tag: e.tagName, txt:(e.textContent||'').replace(/\s+/g,' ').trim().slice(0,40), attrs: e.getAttributeNames().join(',') }));
  // In context toggle text present?
  out.incontext_present = /In context|Focus op passage|passage/i.test(document.body.innerHTML);
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
