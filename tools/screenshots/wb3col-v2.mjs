import { chromium } from 'playwright';

const file = 'file:///home/dev/consultatie-wt/3col-sketch/spike/werkbank-3col.html';
const out = '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(file);

// 1. voortgangsbalk INGEKLAPT, niets aangevinkt
await page.screenshot({ path: `${out}/werkbank-3col-v2-1-overzicht.png` });

// 2. voortgangsbalk UITGEKLAPT + 2 reacties aangevinkt -> bulk-actiebalk zichtbaar
await page.click('#voortgang > summary');
const boxes = await page.$$('.r-chk');
await boxes[0].check();
await boxes[1].check();
// check() scrollt de kolom mee; terug naar boven zodat de aangevinkte kaarten in beeld staan
await page.evaluate(() => { document.getElementById('reacties').scrollTop = 0; });
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/werkbank-3col-v2-2-voortgang-bulk.png` });

await browser.close();
console.log('ok');
