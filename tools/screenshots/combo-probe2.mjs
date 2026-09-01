import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => console.log('PAGE', m.type(), m.text()));
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded' });
await page.click('button[name="mock_user"][value="admin"]');
await page.waitForLoadState('networkidle').catch(() => {});
await page.goto(BASE + '/beheer/werkbank/voorbeeld?sel=9cd3385d-4869-5c2d-8cca-279d00e1b4dd', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const oordeel = page.locator('#wb-oordeel');
await oordeel.selectOption('achterhaald');
await oordeel.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(700);

// Read Alpine state on the combobox root
function state() {
  return page.evaluate(() => {
    const el = document.querySelector('[x-data^="ingehaaldCombobox"]');
    if (!el || !el._x_dataStack) return { err: 'no alpine stack' };
    const d = el._x_dataStack[0];
    return { query: d.query, open: d.open, optionsLen: d.options.length, filteredLen: d.filtered.length };
  });
}
console.log('initial state:', JSON.stringify(await state()));
const combo = page.locator('#wb-ingehaald');
await combo.click();
await page.waitForTimeout(300);
console.log('after click:', JSON.stringify(await state()));
await combo.pressSequentially('Kad', { delay: 120 });
await page.waitForTimeout(500);
console.log('after type Kad:', JSON.stringify(await state()));
const domOpts = await page.locator('#wb-ingehaald-list [role="option"]').count();
const listVisible = await page.locator('#wb-ingehaald-list').isVisible().catch(()=>false);
console.log('DOM options under #wb-ingehaald-list:', domOpts, 'listVisible:', listVisible);
await browser.close();
console.log('DONE2');
