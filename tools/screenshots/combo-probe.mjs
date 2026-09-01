import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded' });
await page.click('button[name="mock_user"][value="admin"]');
await page.waitForLoadState('networkidle').catch(() => {});
await page.goto(BASE + '/beheer/werkbank/voorbeeld?sel=9cd3385d-4869-5c2d-8cca-279d00e1b4dd', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
// read the x-data attribute JSON
const xdata = await page.locator('[x-data^="ingehaaldCombobox"]').first().getAttribute('x-data').catch(() => null);
if (xdata) {
  const json = xdata.replace(/^ingehaaldCombobox\(/, '').replace(/\)$/, '');
  try {
    const arr = JSON.parse(json);
    console.log('CANDIDATES:', arr.length);
    for (const o of arr.slice(0, 8)) console.log('  -', JSON.stringify(o.label || o));
    const kad = arr.filter(o => JSON.stringify(o).toLowerCase().includes('kad'));
    console.log('match "kad":', kad.length, kad.slice(0,3).map(o=>o.label));
  } catch (e) { console.log('raw x-data (first 600):', json.slice(0, 600)); }
} else console.log('no ingehaaldCombobox x-data found');

// now actually drive it
const oordeel = page.locator('#wb-oordeel');
await oordeel.selectOption('achterhaald');
await oordeel.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(600);
const combo = page.locator('#wb-ingehaald');
await combo.click(); await combo.fill('');
await page.waitForTimeout(300);
for (const q of ['Kad', 'a', 'e']) {
  await combo.fill(q);
  await combo.dispatchEvent('input');
  await page.waitForTimeout(500);
  const n = await page.locator('[role="listbox"] [role="option"]').count();
  console.log(`query ${JSON.stringify(q)} -> ${n} options`);
}
await browser.close();
console.log('COMBO PROBE DONE');
