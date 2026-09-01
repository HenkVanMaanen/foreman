import { chromium } from 'playwright';
const OUT = '/home/dev/foreman/state/shots/';
const URL = 'file:///home/dev/consultatie-wt/3col-sketch/spike/werkbank-variant-c.html';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });

await p.goto(URL);
await p.screenshot({ path: OUT + 'werkbank-variant-c-1-lijst.png', fullPage: true });

await p.click('.sec[data-sec="5"]');
await p.screenshot({ path: OUT + 'werkbank-variant-c-2-detail.png', fullPage: true });

await p.click('#ctx > summary');
await p.click('#ctx-passage');
await p.screenshot({ path: OUT + 'werkbank-variant-c-3-passage.png', fullPage: true });

await b.close();
