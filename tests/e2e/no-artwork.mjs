/**
 * Every screen, with no card artwork at all.
 *
 *   node tests/e2e/no-artwork.mjs <baseUrl> <identityCookie>
 *
 * A convention hall with four thousand people on one cell tower is the normal
 * operating condition for Card Show mode, not an edge case. This run fails
 * every request to the image CDN and then asserts the things that actually go
 * wrong when art is missing: placeholders that repeat a number the caption
 * already shows, variant chips landing on top of the card's name, boxes that
 * collapse, and layout that shifts when the failures arrive.
 *
 * It deliberately asserts nothing about artwork itself. There is no fake image
 * anywhere in here — the point is that the product is usable when the real ones
 * do not arrive.
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
  await context.addCookies([{ name, value: rest.join('='), domain: 'localhost', path: '/' }]);
}
const page = await context.newPage();
const gotoOnce = page.goto.bind(page);
page.goto = (url, opts) => gotoOnce(url, { waitUntil: 'domcontentloaded', ...opts });

// Nothing off-origin resolves. That is the whole premise of the run.
let imageAttempts = 0;
await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  if (route.request().resourceType() === 'image') imageAttempts++;
  return route.abort();
});

/** Every art slot's box, so a collapsed or mis-proportioned one is visible. */
const artBoxes = () =>
  page.$$eval('.card-art', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );

try {
  for (const path of [
    '/app',
    '/app/sets/sv3pt5?mode=master',
    '/app/binder',
    '/app/show',
    '/app/collection',
    '/app/trade',
    '/partners',
  ]) {
    console.log(`\n${path}`);
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(900);

    const boxes = await artBoxes();
    if (boxes.length === 0) {
      check(`${path} has card slots to check`, false, 'no .card-art found');
      continue;
    }

    // Every slot keeps its shape. A collapsed box is what produces the jumping
    // grid people complain about.
    const collapsed = boxes.filter((b) => b.w < 8 || b.h < 8).length;
    check(`${path}: no card slot collapses`, collapsed === 0, `${collapsed} of ${boxes.length}`);

    const ratios = boxes.map((b) => b.h / b.w);
    const offRatio = ratios.filter((r) => Math.abs(r - 342 / 245) > 0.06).length;
    check(
      `${path}: every slot keeps the card aspect ratio`,
      offRatio === 0,
      `${offRatio} of ${boxes.length} off`,
    );

    // Nothing drawn over a placeholder may sit on top of anything else drawn
    // over it. This is the variant-chip-over-the-card-name bug, expressed as
    // geometry rather than as a screenshot. The search starts from the whole
    // tile, not from the art box, because chips are often siblings of the
    // artwork rather than children of it — which is exactly how the overlap got
    // in.
    const overlaps = await page.$$eval('.card-art', (els) => {
      const hits = [];
      for (const el of els) {
        const box = el.getBoundingClientRect();
        const root = el.closest('li, a, button') ?? el.parentElement ?? el;
        const over = [...root.querySelectorAll('span')]
          .map((s) => ({ text: s.textContent?.trim() ?? '', r: s.getBoundingClientRect() }))
          .filter(
            ({ r }) =>
              r.width > 0 &&
              r.height > 0 &&
              Math.min(r.right, box.right) - Math.max(r.left, box.left) > 1 &&
              Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 1,
          );
        for (let i = 0; i < over.length; i++) {
          for (let j = i + 1; j < over.length; j++) {
            const a = over[i].r;
            const b = over[j].r;
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 1 && y > 1) hits.push(`"${over[i].text}" / "${over[j].text}"`);
          }
        }
      }
      return hits;
    });
    check(
      `${path}: nothing overlaps a placeholder`,
      overlaps.length === 0,
      overlaps.slice(0, 3).join(', '),
    );

    // The failures must not move the page. Measure, wait past any late error
    // event, measure again.
    const before = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.documentElement.scrollHeight);
    check(`${path}: no layout shift once the failures land`, before === after, `${before} → ${after}`);
  }

  // ------------------------------------------------- the binder, specifically
  console.log('\nbinder pockets');
  await page.goto(`${BASE}/app/binder`);
  await page.waitForTimeout(900);
  const dupes = await page.$$eval('main a:has(.pocket)', (links) =>
    links.filter((a) => {
      const text = a.innerText.replace(/\s+/g, ' ').trim();
      const numbers = text.match(/#\S+/g) ?? [];
      return numbers.length > 1 && new Set(numbers).size < numbers.length;
    }).length,
  );
  check('a pocket never prints its card number twice', dupes === 0, `${dupes} pockets`);

  const named = await page.$$eval('main a:has(.pocket) .card-art', (els) =>
    els.filter((e) => e.innerText.trim().length > 0).length,
  );
  check(
    'a filled pocket with no artwork still names its card',
    named > 0,
    `${named} pockets name the card`,
  );

  // ------------------------------------------------------- card show is usable
  console.log('\ncard show with no artwork');
  await page.goto(`${BASE}/app/show`);
  await page.waitForTimeout(900);
  const rows = await page.locator('main ul.grid-cols-1 > li').count();
  check('the pull list still builds', rows > 0, `${rows} rows`);
  const foundIt = await page.locator('button:has-text("FOUND IT")').count();
  check('every row is still actionable', foundIt >= rows, `${foundIt} FOUND IT buttons`);

  check('the run actually blocked artwork', imageAttempts > 0, `${imageAttempts} image requests failed`);
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
