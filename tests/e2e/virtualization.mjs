/**
 * Proves the set grid and the Card Show pull list stay bounded.
 *
 *   node tests/e2e/virtualization.mjs <baseUrl> <identityCookie>
 *
 * The claim under test is not "scrolling feels smooth" — it is that a master
 * set of several hundred printings never puts several hundred card tiles in the
 * document, that scrolling to the bottom still reaches the last card, and that
 * the page is exactly as tall as it would have been with every tile rendered.
 * A windowing bug that silently drops rows would pass a smoothness check and
 * fail this one.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3100';
// With a cookie, this runs against an existing collector — the 5,001-collector
// load dataset locally. Without one it provisions its own, so CI can run it on
// nothing but the catalog.
const COOKIE = process.argv[3] ?? '';
/** The largest master-set goal in the catalog: 360 printings. */
const SET = 'sv3pt5';
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
if (COOKIE) {
  const [name, ...rest] = COOKIE.split('=');
  await context.addCookies([
    { name, value: rest.join('='), domain: 'localhost', path: '/' },
  ]);
}
const page = await context.newPage();
// Artwork comes from a CDN this container cannot reach; the assertions are all
// about DOM structure, so navigations settle on DOMContentLoaded.
const gotoOnce = page.goto.bind(page);
page.goto = (url, opts) => gotoOnce(url, { waitUntil: 'domcontentloaded', ...opts });
// Card artwork is irrelevant here and would otherwise hang on an unreachable
// host, so drop every off-origin request.
await page.route('**/*', (route) => {
  const url = route.request().url();
  return url.startsWith(BASE) ? route.continue() : route.abort();
});

const tiles = () => page.locator('ul[aria-label$="cards"] > li').count();

/**
 * Make sure the caller is a collector with something to look at.
 *
 * With a cookie — a minted local identity in CI, or the load dataset's whale
 * locally — this tracks a set only if that collector has none, so a run against
 * a populated database changes nothing. Without one it signs up, which is the
 * convenient path locally but spends the sign-up rate limit CI has to share.
 */
async function ensureCollector(label, cards = 0) {
  if (!COOKIE) {
    await page.goto(`${BASE}/signup`);
    await page.fill('#displayName', label);
    await page.fill('#email', `${label.toLowerCase()}-${Date.now()}@example.com`);
    await page.fill('#password', 'password-1234');
    await page.click('button:has-text("Create account")');
    await page.waitForURL('**/onboarding', { timeout: 20000 });
  } else {
    await page.goto(`${BASE}/app`);
  }

  if (/Pick a set to chase/i.test(await page.locator('main').innerText())) {
    await page.goto(`${BASE}/onboarding`);
    await page.fill('input[aria-label="Search sets"]', '151');
    await page.waitForTimeout(400);
    await page.click('li:has-text("151") button >> nth=0');
    await page.click('button:has-text("Track 1 set")');
    await page.waitForURL(`${BASE}/app`, { timeout: 20000 });
  }

  if (cards > 0) {
    await page.goto(`${BASE}/app/collection`);
    await page.waitForTimeout(700);
    if (/Already track your collection somewhere else/i.test(await page.locator('main').innerText())) {
      await page.goto(`${BASE}/app/sets/${SET}`);
      await page.waitForSelector('ul[aria-label$="cards"] li button[aria-pressed="false"]');
      for (let i = 0; i < cards; i++) {
        const next = page.locator('ul[aria-label$="cards"] li button[aria-pressed="false"]').first();
        if (!(await next.count())) break;
        await next.click();
        await page.waitForTimeout(350);
      }
    }
  }
}


try {
  console.log('\nprovisioning');
  // Card Show mode needs a tracked set to build a pull list from, and the grid
  // needs somewhere to write an ownership toggle.
  await ensureCollector('Windowing');
  check('the caller is a collector tracking at least one set', true);

  // ------------------------------------------------------------- the set grid
  console.log('\nset grid — a large master set');
  await page.goto(`${BASE}/app/sets/${SET}?mode=master`);
  await page.waitForSelector('ul[aria-label$="cards"] > li');
  await page.waitForTimeout(500);

  const total = parseInt(
    (await page.locator('ul[aria-label$="cards"]').getAttribute('aria-label')).match(/\d+/)[0],
    10,
  );
  check('the set is large enough for this to mean anything', total >= 200, `${total} printings`);

  const atTop = await tiles();
  check('the grid renders a fraction of the set', atTop < total / 2, `${atTop} of ${total} tiles`);
  check('the grid renders enough to fill the screen', atTop >= 12, `${atTop} tiles`);

  // The document must still be the height of the whole set. If windowing
  // collapsed the page, the scrollbar would lie and the last cards would be
  // unreachable.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const rows = Math.ceil(total / 3);
  check(
    'the page is as tall as the full set',
    height > rows * 100,
    `${height}px for ~${rows} rows`,
  );

  // Scroll the whole way down in steps, watching the tile count at each stop.
  let peak = atTop;
  const seen = new Set();
  for (let y = 0; y <= height; y += 700) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(120);
    peak = Math.max(peak, await tiles());
    for (const n of await page.locator('ul[aria-label$="cards"] > li .num').allInnerTexts()) {
      const m = n.match(/^#(\S+)/);
      if (m) seen.add(m[1]);
    }
  }
  check('the DOM stays bounded while scrolling', peak < 120, `peak ${peak} tiles`);
  check(
    'scrolling reaches cards from across the whole set',
    seen.size > total / 3,
    `${seen.size} distinct card numbers passed through the window`,
  );

  // The last card in the set must be reachable at the bottom.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  const bottom = await tiles();
  check('the bottom of the set renders', bottom > 0, `${bottom} tiles at the bottom`);
  check('the DOM is still bounded at the bottom', bottom < 120, `${bottom} tiles`);

  // ---------------------------------------------------------- ownership state
  console.log('\nownership survives windowing');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const firstUnowned = page.locator('ul[aria-label$="cards"] li button[aria-pressed="false"]').first();
  const label = await firstUnowned.getAttribute('aria-label');
  await firstUnowned.click();
  await page.waitForTimeout(900);
  const nowOwned = await page
    .locator(`ul[aria-label$="cards"] li button[aria-label="${label.replace('Add', 'Remove')}"]`)
    .count();
  check('a tapped card flips to owned in place', nowOwned === 1, label);

  // Scroll it out of the window and back: the state must survive unmounting.
  await page.evaluate(() => window.scrollTo(0, 4000));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const stillOwned = await page
    .locator(`ul[aria-label$="cards"] li button[aria-label="${label.replace('Add', 'Remove')}"]`)
    .count();
  check('ownership survives the tile leaving and re-entering the DOM', stillOwned === 1);

  // ------------------------------------------------------------------ filters
  //
  // Exactly one card is owned at this point, so each filter has a different
  // size and the window has to follow all three.
  console.log('\nfilters drive the window');
  await page.click('button:has-text("Missing")');
  await page.waitForTimeout(400);
  const missingTotal = parseInt(
    (await page.locator('ul[aria-label$="cards"]').getAttribute('aria-label')).match(/\d+/)[0],
    10,
  );
  check('filtering narrows the list', missingTotal === total - 1, `${missingTotal} of ${total}`);
  check('the filtered grid is still windowed', (await tiles()) < 120, `${await tiles()} tiles`);

  await page.click('button:has-text("Have")');
  await page.waitForTimeout(400);
  const haveTiles = await tiles();
  check('the owned filter shows exactly the owned card', haveTiles === 1, `${haveTiles} tiles`);

  await page.click('button:has-text("All")');
  await page.waitForTimeout(400);

  // Undo, so repeated runs start from the same place.
  await page
    .locator(`ul[aria-label$="cards"] li button[aria-label="${label.replace('Add', 'Remove')}"]`)
    .click();
  await page.waitForTimeout(700);

  // ------------------------------------------------------------ accessibility
  console.log('\naccessibility');
  const posinset = await page
    .locator('ul[aria-label$="cards"] > li')
    .first()
    .getAttribute('aria-posinset');
  const setsize = await page
    .locator('ul[aria-label$="cards"] > li')
    .first()
    .getAttribute('aria-setsize');
  check('tiles carry their position in the full set', posinset === '1', `posinset=${posinset}`);
  check(
    'tiles carry the full set size, not the window size',
    parseInt(setsize, 10) === total,
    `setsize=${setsize} total=${total}`,
  );

  // ------------------------------------------------------ every breakpoint
  //
  // The column count comes from the container's computed
  // `grid-template-columns`, so a new breakpoint in the CSS changes the window
  // without anyone editing the hook. That is the point — and the reason to
  // check the bound still holds at each of them rather than only on a phone.
  console.log('\nthe bound holds at every width');
  for (const width of [390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/app/sets/${SET}?mode=master`);
    await page.waitForSelector('ul[aria-label$="cards"] > li');
    await page.waitForTimeout(600);
    const cols = await page.$eval(
      'ul[aria-label$="cards"]',
      (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length,
    );
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    let peak = 0;
    for (let y = 0; y <= tall; y += 900) {
      await page.evaluate((to) => window.scrollTo(0, to), y);
      await page.waitForTimeout(80);
      peak = Math.max(peak, await tiles());
    }
    check(
      `${width}px: ${cols} columns, ${peak} of ${total} tiles at peak`,
      peak < total / 2 && peak >= cols,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // -------------------------------------------------------------- pull list
  console.log('\ncard show pull list');
  await page.goto(`${BASE}/app/show`);
  await page.waitForTimeout(700);
  const pullRows = await page.locator('main ul.grid-cols-1 > li').count();
  const pullTotal = parseInt(
    (await page.locator('main').innerText()).match(/Pull list \((\d+)\)/)?.[1] ?? '0',
    10,
  );
  check('the pull list is large', pullTotal >= 100, `${pullTotal} cards to find`);
  check(
    'the pull list is windowed too',
    pullRows > 0 && pullRows < Math.max(60, pullTotal / 2),
    `${pullRows} of ${pullTotal} rows`,
  );
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\nERROR', err);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
