// Probe: admin-login, open the werkbank, dump the count + all facet option
// values/labels so the video script can assert the REAL numbers.
import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/auth/oidc/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.click('button[name="mock_user"][value="admin"]');
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.goto(BASE + '/beheer/werkbank/voorbeeld', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const countText = await page.locator('p[role="status"]').first().innerText().catch(() => '(none)');
console.log('COUNT:', JSON.stringify(countText.replace(/\s+/g, ' ').trim()));

for (const [name, id] of [['soort','#wb-soort'],['prioriteit','#wb-prio'],['status','#wb-status'],['org','#wb-org']]) {
  const opts = await page.locator(`${id} option`).evaluateAll(os => os.map(o => ({ value: o.value, label: o.textContent.trim() })));
  console.log(`FACET ${name} (${id}):`, JSON.stringify(opts));
}

// helper: hit a query-param URL and read the count (GET form => URL-drivable)
async function countFor(qs) {
  await page.goto(BASE + '/beheer/werkbank/voorbeeld?' + qs, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  const t = await page.locator('p[role="status"]').first().innerText().catch(() => '');
  const m = t.replace(/\s+/g,' ').match(/(\d+)\s+van\s+(\d+)/);
  return m ? `${m[1]}/${m[2]}` : t.trim();
}
for (const qs of ['q=Digikoppeling','q=herstelperiode','q=bewaartermijn','status=nog_te_doen','prioriteit=hoog']) {
  console.log(`QUERY ${qs} ->`, await countFor(qs));
}
await browser.close();
console.log('PROBE DONE');
