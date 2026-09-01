// Variant E static-sketch shots (file://). Two columns, each with an overview on
// top and its detail below: section overview + section text left, feedback
// overview + chosen feedback/behandelformulier right. Native (enlarged) disclosure
// triangles. Shots go to the foreman-notes state/shots dir.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/home/dev/foreman/notes/state/shots';
const URL = 'file:///home/dev/consultatie-wt/3col-sketch/spike/werkbank-variant-e.html';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();

// ---- desktop -------------------------------------------------------------
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(URL);

// shot 1: overview — pick the VE001 section so both overviews are populated and
// the enlarged native triangles are visible; no comment chosen yet.
await p.click('.sec[data-sec="5"]');
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/werkbank-variant-e-1-overzicht.png`, fullPage: true });
console.log('shot 1 (overzicht) saved');

// shot 2: detail — choose a comment: left text shows the lit passage, right the
// feedback + behandelformulier.
await p.click('.oprij[data-op="0"]');
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/werkbank-variant-e-2-detail.png`, fullPage: true });
console.log('shot 2 (detail) saved');

// ---- narrow (stacked) ----------------------------------------------------
const pn = await b.newPage({ viewport: { width: 420, height: 900 } });
await pn.goto(URL);
await pn.click('.sec[data-sec="5"]');
await pn.waitForTimeout(150);
await pn.click('.oprij[data-op="0"]');
await pn.waitForTimeout(200);
await pn.screenshot({ path: `${OUT}/werkbank-variant-e-3-smal.png`, fullPage: true });
console.log('shot 3 (smal) saved');

await b.close();
console.log('VARIANT E SHOTS DONE ->', OUT);
