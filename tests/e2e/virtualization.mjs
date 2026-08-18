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
const COOKIE = process.argv[3] ?? '';
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

try {
  // ------------------------------------------------------------- the set grid
  console.log('\nset grid — a large master set');
  await page.goto(`${BASE}/app/sets/sv3pt5?mode=master`);
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
