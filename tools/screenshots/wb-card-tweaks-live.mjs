// Werkbank card-tweaks (d2b2a1e) — live shots against the deployed preview.
// Verifies: (1) detail card has NO section/e-mail badge (naam/functie·org/Soort/
// Prioriteit + date·status only); (2) the Voortgang + Secties disclosure chevrons
// render identically (both ▸ when collapsed) — the group-open: purge check.
import { chromium } from 'playwright';

const BASE = 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';
const SLUG = 'voorbeeld';
const OUT = '/home/dev/foreman/state/shots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();

await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(400);
const adminBtn = page.locator('button[name="mock_user"][value="admin"]');
if (await adminBtn.count()) await adminBtn.first().click();
await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});

await page.goto(BASE + `/beheer/werkbank/${SLUG}`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(800);
console.log('werkbank url:', page.url());

// shot 1: top of page — both chevrons collapsed (Voortgang + Secties).
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
// read the rendered chevron glyphs to prove parity (not just visual)
const chevrons = await page.evaluate(() => {
  const out = {};
  const summary = document.querySelector('details.group summary span[aria-hidden]');
  if (summary) out.voortgang = (summary.innerText || '').trim();
  // Secties header chevron: span with x-text lijstOpen ? ▾ : ▸
  const secHdr = Array.from(document.querySelectorAll('span[aria-hidden]')).map(s => (s.innerText||'').trim()).filter(Boolean);
  out.allChevronSpans = secHdr;
  return out;
});
console.log('chevron glyphs:', JSON.stringify(chevrons));
await page.screenshot({ path: `${OUT}/wb-tweaks-1-chevrons.png`, fullPage: false });
console.log('shot 1 (chevrons) saved');

// open a section that still has open opmerkingen
const sectionBtns = page.locator('#wb-sectielijst ul li button');
const n = await sectionBtns.count();
let clicked = false;
for (let i = 0; i < n; i++) {
  const btn = sectionBtns.nth(i);
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (/te doen van/.test(label)) { await btn.click().catch(() => {}); clicked = true; console.log('clicked section:', JSON.stringify(label)); break; }
}
if (!clicked && n) { await sectionBtns.first().click().catch(() => {}); console.log('clicked first section (fallback)'); }
await page.waitForTimeout(900);

// shot 2: tight crop of the detail card — should show naam + functie·org + Soort/
// Prioriteit badges + date·status, and NO "Afsprakenstelsel…" section badge / e-mail.
const card = page.locator('article.cons-werkbank-detailcard:visible').first();
if (await card.count()) {
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await card.screenshot({ path: `${OUT}/wb-tweaks-2-card.png` });
  const txt = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  console.log('shot 2 (card) saved; card text:', JSON.stringify(txt));
} else console.log('WARN: detail card not found');

await browser.close();
console.log('DONE');
