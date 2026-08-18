/**
 * Real-environment browser check against the deployed Vercel preview.
 *
 * This is not the local e2e harness: it drives a real Chromium against the
 * live URL to capture, with evidence, exactly what a private-beta visitor sees
 * today. It records screenshots and the HTTP status of the server-action POST
 * so the deployment report rests on observed behaviour, not inference.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL ?? 'https://pokemon-app-w-three.vercel.app';
const OUT = process.env.E2E_OUT ?? '/tmp/claude-0/e2e';
mkdirSync(OUT, { recursive: true });

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PW;

const results = [];
const note = (k, v) => { results.push([k, v]); console.log(`  ${k}: ${v}`); };

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
}

// The pre-installed Chromium build may not match this package's expected
// revision, so point launch at the real binary rather than letting Playwright
// look for its own download (this environment forbids `playwright install`).
const executablePath =
  process.env.PW_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// All container egress is via the HTTPS proxy; Chromium must use it too, or it
// hits ERR_CONNECTION_RESET trying to reach the internet directly.
const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const browser = await chromium.launch({
  executablePath,
  proxy: proxyServer ? { server: proxyServer } : undefined,
  // --no-sandbox: running as root. --disable-quic / no-HTTP3: the egress proxy
  // tunnels CONNECT over TCP only, and a QUIC/UDP attempt shows up as a reset.
  // The proxy CA is already in Chromium's NSS store, so TLS verifies normally.
  args: [
    '--no-sandbox',
    '--disable-quic',
    '--disable-features=UseDnsHttpsSvcb,AsyncDns',
  ],
});

// ---- Desktop viewport -----------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  console.log('== landing / (desktop) ==');
  const rLanding = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  note('GET / status', rLanding?.status());
  await shot(page, 'desktop-landing');

  console.log('== /partners (desktop) ==');
  const rPartners = await page.goto(`${BASE}/partners`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  note('GET /partners status', rPartners?.status());
  await shot(page, 'desktop-partners');

  console.log('== /signin (desktop) ==');
  const rSignin = await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  note('GET /signin status', rSignin?.status());
  const hasForm = await page.locator('form input[name="email"]').count();
  note('signin form rendered', hasForm > 0);
  await shot(page, 'desktop-signin');

  // Submit the real sign-in and capture the server-action POST status.
  if (email && password && hasForm > 0) {
    console.log('== submit sign-in (captures server-action POST) ==');
    let actionStatus = null;
    page.on('response', (resp) => {
      const req = resp.request();
      if (req.method() === 'POST' && resp.url().includes('/signin')) actionStatus = resp.status();
    });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
      page.click('button[type="submit"], button:has-text("Sign in")'),
    ]);
    await page.waitForTimeout(2500);
    note('sign-in action POST status', actionStatus);
    note('URL after submit', page.url());
    const errText = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    note('visible error after submit', errText ? errText.trim() : '(none)');
    await shot(page, 'desktop-after-signin');
  }

  // Payment UI check on rendered pages.
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  note('payment words on signin/landing', /stripe|checkout|\$\d+\s*\/\s*mo|upgrade to pro|add card|billing/i.test(bodyText));

  await ctx.close();
}

// ---- Mobile viewport (iPhone-ish) ----------------------------------------
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  console.log('== /signin (mobile 390px) ==');
  const r = await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  note('mobile GET /signin status', r?.status());
  // Horizontal overflow check — a private beta on a phone must not scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  note('mobile horizontal overflow px', overflow);
  await shot(page, 'mobile-signin');
  await ctx.close();
}

await browser.close();
console.log('\nARTIFACTS in', OUT);
