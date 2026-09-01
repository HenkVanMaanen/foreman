// Screenshots van de statische 3-koloms werkbank-schets.
import { chromium } from 'playwright';

const file = 'file:///home/dev/consultatie-wt/3col-sketch/spike/werkbank-3col.html';
const out = '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(file);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/werkbank-3col-1-overzicht.png` });

// Voortgangsbalk uitklappen + 2 reacties aanvinken.
await page.click('#voortgang > summary');
const boxes = await page.$$('.r-chk');
await boxes[0].check();
await boxes[1].check();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/werkbank-3col-2-voortgang-bulk.png` });

await browser.close();
console.log('ok');
