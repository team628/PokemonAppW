/**
 * The signature moment: finishing a set.
 *
 *   node tests/e2e/completion.mjs [baseUrl]
 *
 * Drives a fresh collector through an entire five-card set, one tap at a time,
 * and asserts three things that are easy to get wrong and impossible to notice
 * in a screenshot:
 *
 *   1. the moment fires on the tap that closes the set, not on a page load;
 *   2. the card it draws names the set, counts the cards and dates the day;
 *   3. it never fires again — not on reload, not on the dashboard, not after
 *      selling the last card and buying it back.
 *
 * It also runs the whole thing a second time with `prefers-reduced-motion`, to
 * confirm the celebration still happens and the confetti does not.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SET = 'fut20'; // the only five-card set in the catalog
const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const EXEC =
  process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});

async function run(reducedMotion) {
  const label = reducedMotion ? 'reduced motion' : 'default motion';
  console.log(`\n=== ${label} ===`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  const gotoOnce = page.goto.bind(page);
  page.goto = (url, opts) => gotoOnce(url, { waitUntil: 'domcontentloaded', ...opts });
  await page.route('**/*', (route) =>
    route.request().url().startsWith(BASE) ? route.continue() : route.abort(),
  );

  const moment = page.locator('div[role="dialog"][aria-label$="complete"]');

  try {
    // ------------------------------------------------------------- a collector
    await page.goto(`${BASE}/signup`);
    await page.fill('#displayName', 'Completionist');
    await page.fill('#email', `complete-${Date.now()}-${reducedMotion ? 'r' : 'd'}@example.com`);
    await page.fill('#password', 'password-1234');
    await page.click('button:has-text("Create account")');
    await page.waitForURL('**/onboarding', { timeout: 20000 }).catch(async (e) => {
      // This suite needs a collector who has never finished this set, so it
      // signs up. Say so plainly when the sign-up limiter is what stopped it —
      // the limiter working is not a failure of the thing under test.
      const text = await page.locator('main').innerText().catch(() => '');
      if (/Too many sign-ups|rate limit/i.test(text)) {
        throw new Error(
          'the sign-up rate limiter refused a new account — wait for the window ' +
            'to pass, or run against a database whose signup bucket is clear',
        );
      }
      throw e;
    });

    await page.fill('input[aria-label="Search sets"]', 'Futsal');
    await page.waitForTimeout(400);
    await page.click('li:has-text("Futsal") button >> nth=0');
    await page.click('button:has-text("Track 1 set")');
    await page.waitForURL(`${BASE}/app`, { timeout: 20000 });

    // ------------------------------------------------- tap through the set
    await page.goto(`${BASE}/app/sets/${SET}`);
    await page.waitForSelector('ul[aria-label$="cards"] li button');
    const slots = await page.locator('ul[aria-label$="cards"] li button[aria-pressed]').count();
    check('the set is small enough to finish in a test', slots >= 3, `${slots} printings`);

    for (let i = 0; i < slots; i++) {
      const next = page.locator('ul[aria-label$="cards"] li button[aria-pressed="false"]').first();
      if (!(await next.count())) break;
      await next.click();
      await page.waitForTimeout(700);
      // Every tap but the last must pass without interrupting.
      if (i < slots - 1) {
        const early = await moment.count();
        if (early > 0) {
          check(`no celebration before the set is finished (after ${i + 1} of ${slots})`, false);
          break;
        }
      }
    }
    check('nothing celebrates a partly finished set', !failures.length);

    // -------------------------------------------------------- the moment
    await moment.waitFor({ timeout: 8000 }).catch(() => {});
    check('the completion moment fires on the closing tap', (await moment.count()) === 1);

    const text = (await moment.innerText()).replace(/\s+/g, ' ');
    check('it says the set is complete', /SET COMPLETE/i.test(text), text.slice(0, 60));
    check('it names the set', /Futsal/i.test(text));
    check('it counts the cards', new RegExp(`\\b${slots}\\b`).test(text), `expected ${slots}`);
    check(
      'it dates the accomplishment',
      /on \w+ \d{1,2}, \d{4}/.test(text),
      text.match(/on \w+ \d{1,2}, \d{4}/)?.[0] ?? 'no date found',
    );
    check('it names the collector', /Completionist/.test(text));

    const confetti = await page.locator('.confetti-piece').count();
    if (reducedMotion) {
      check('no confetti is rendered under prefers-reduced-motion', confetti === 0, `${confetti}`);
    } else {
      check('confetti plays by default', confetti > 0, `${confetti} pieces`);
    }

    // ------------------------------------------------------- once, and once only
    await page.locator('div[role="dialog"] button:has-text("Done")').click();
    await page.waitForTimeout(600);
    check('it dismisses', (await moment.count()) === 0);

    await page.reload();
    await page.waitForTimeout(1200);
    check('reloading the finished set does not replay it', (await moment.count()) === 0);

    await page.goto(`${BASE}/app`);
    await page.waitForTimeout(1200);
    check('the dashboard does not replay it', (await moment.count()) === 0);

    // Sell the last card and buy it back: the set was already finished once.
    await page.goto(`${BASE}/app/sets/${SET}`);
    await page.waitForSelector('ul[aria-label$="cards"] li button[aria-pressed="true"]');
    await page.locator('ul[aria-label$="cards"] li button[aria-pressed="true"]').first().click();
    await page.waitForTimeout(900);
    await page.locator('ul[aria-label$="cards"] li button[aria-pressed="false"]').first().click();
    await page.waitForTimeout(1200);
    check('re-completing an already finished set does not replay it', (await moment.count()) === 0);
  } catch (err) {
    failures.push(`${label} threw: ${err.message}`);
    console.error(`\nERROR (${label})`, err);
  } finally {
    await context.close();
  }
}

await run(false);
await run(true);
await browser.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
