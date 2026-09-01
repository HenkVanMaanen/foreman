import { chromium } from 'playwright';

const file = 'file:///home/dev/consultatie-wt/3col-sketch/spike/werkbank-variant-b.html';
const out = '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL' });
await page.goto(file);

// 1. lijst UITGEKLAPT bovenaan, nog geen sectie gekozen, voortgangsbalk ingeklapt
await page.screenshot({ path: `${out}/werkbank-variant-b-1-lijst.png` });

// 2. sectie gekozen -> lijst klapt dicht tot de smalle regel; opmerking 3 van 7 open,
//    'in context' op "hele sectie"
await page.click('.sec[data-sec="5"]');
await page.click('#op-volgende');
await page.click('#op-volgende');
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/werkbank-variant-b-2-detail.png` });

// 3. zelfde scherm, 'in context' op "alleen de passage" + de vaste keuzelijsten met
//    hun extra velden zichtbaar (Niet meer van toepassing + verwijzing, Afgehandeld + datum)
await page.click('#ctx-passage');
await page.selectOption('#bb-oordeel', 'Niet meer van toepassing');
await page.selectOption('#bb-status', 'Afgehandeld');
await page.selectOption('#bb-vervallen-door', '5');
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/werkbank-variant-b-3-passage.png` });

await browser.close();
console.log('ok');
