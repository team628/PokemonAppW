/**
 * End-to-end check of the core collector loop against a running server.
 *
 * Drives a real browser through the paths a collector actually takes:
 * sign up, track a set, log cards from the set grid, run Card Show mode, and
 * confirm that the NEED figure on screen moves and that HAVE + NEED still
 * reconciles to COMPLETE afterwards.
 *
 *   node tests/e2e/flow.mjs [baseUrl]
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';

// This container ships a Chromium at a fixed path; CI installs its own through
// Playwright. Prefer an explicit override, fall back to the preinstalled binary
// when it is actually there, and otherwise let Playwright resolve its own.
const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const EXEC =
  process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

let passed = 0;
const failures = [];
/** Checks that cannot run here, reported as blocked rather than silently skipped. */
const blocked = [];

// Whether the deployment under test is backed by a real Supabase Auth project.
// Some checks are only meaningful there; the rest run either way.
const supabaseAuth = !!process.env.NEXT_PUBLIC_SUPABASE_URL;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const dollars = (text) => {
  const m = text.replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]{2})?)/);
  return m ? parseFloat(m[1]) : null;
};

const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-sized

// Every assertion in this suite is about DOM content, never about artwork.
// Waiting on the load event would make the run hostage to the image CDN, so
// navigations settle on DOMContentLoaded instead.
const gotoOnce = page.goto.bind(page);
page.goto = (url, opts) => gotoOnce(url, { waitUntil: 'domcontentloaded', ...opts });

try {
  const email = `e2e-${Date.now()}@example.com`;

  // ---------------------------------------------------------------- sign up
  console.log('\nsign up');
  await page.goto(`${BASE}/signup`);
  await page.fill('#displayName', 'E2E Collector');
  await page.fill('#email', email);
  await page.fill('#password', 'password-1234');
  // The signup form requires a private-beta invite code. The CI harness seeds a
  // genuine one (public.create_invite_code) into the isolated database and passes
  // it here, so this fills the field exactly as a legitimate invited user would.
  // (In CI's local-auth mode the gate flag is off; consumption through the real
  // enforce_beta_invite trigger is proven in tests/pg/invite-gate.test.ts.)
  await page.fill('#inviteCode', process.env.E2E_INVITE_CODE ?? 'E2E_LOCAL_TEST_CODE');
  await page.click('button:has-text("Create account")');
  await page.waitForURL('**/onboarding', { timeout: 20000 });
  check('lands on onboarding after signup', page.url().includes('/onboarding'));

  // ------------------------------------------------------------ track a set
  console.log('\nonboarding');
  await page.fill('input[aria-label="Search sets"]', 'Base');
  await page.waitForTimeout(300);
  await page.click('li:has-text("Base") button >> nth=0');
  const cta = page.locator('button:has-text("Track 1 set")');
  check('CTA activates once a set is chosen', await cta.isVisible());
  await cta.click();
  await page.waitForURL(`${BASE}/app`, { timeout: 20000 });

  // ----------------------------------------------------------- the hero card
  console.log('\ndashboard');
  const heroNeed = dollars(await page.locator('section').first().innerText());
  check('hero shows a TO GO figure', heroNeed !== null && heroNeed > 0, `got ${heroNeed}`);
  const body = await page.locator('main').innerText();
  check('states completion as a percentage', /\d+\.\d% complete/.test(body));
  check('names how many cards remain', /\d+ remaining/.test(body));
  // Section headings are uppercased in CSS, so innerText comes back shouting.
  check('shows a Next Best Move', /next best move/i.test(body));
  check(
    'discloses where the numbers come from',
    /tcgplayer/i.test(body),
  );

  // ------------------------------------------------- logging cards on a set
  console.log('\nset page');
  await page.click('a:has-text("See what\'s missing")');
  await page.waitForURL('**/app/sets/**', { timeout: 20000 });
  const header = page.locator('div.sticky').first();
  const beforeNeed = dollars(await header.innerText());
  const beforeLeft = parseInt((await header.innerText()).match(/(\d+) left/)?.[1] ?? '0', 10);
  check('set page shows a TO GO figure', beforeNeed !== null, `got ${beforeNeed}`);

  await page.locator('ul li button[aria-pressed="false"]').first().click();
  await page.waitForTimeout(1200);
  const afterText = await header.innerText();
  const afterNeed = dollars(afterText);
  const afterLeft = parseInt(afterText.match(/(\d+) left/)?.[1] ?? '0', 10);
  check('tapping a card decrements the remaining count', afterLeft === beforeLeft - 1,
    `${beforeLeft} -> ${afterLeft}`);
  check('tapping a card reduces TO GO', afterNeed !== null && afterNeed <= beforeNeed,
    `${beforeNeed} -> ${afterNeed}`);

  // The change must survive a reload — optimistic UI is not enough.
  await page.reload();
  await page.waitForTimeout(600);
  const reloaded = parseInt((await page.locator('div.sticky').first().innerText()).match(/(\d+) left/)?.[1] ?? '0', 10);
  check('the change persisted to the server', reloaded === afterLeft, `${afterLeft} vs ${reloaded}`);

  // -------------------------------------------------------- card show mode
  console.log('\ncard show mode');
  await page.goto(`${BASE}/app/show`);
  await page.waitForTimeout(800);
  const showText = await page.locator('main').innerText();
  check('builds a pull list from the tracked set', /Pull list \(\d+\)/.test(showText));
  const showNeedBefore = dollars(showText);

  await page.locator('button:has-text("FOUND IT")').first().click();
  await page.waitForTimeout(400);
  check('asks what was paid', await page.locator('#paid').isVisible());
  await page.fill('#paid', '3.50');
  await page.click('button:has-text("Add to collection")');
  await page.waitForTimeout(1200);

  const afterFind = await page.locator('main').innerText();
  check('confirms the card was added', afterFind.includes('Added —'));
  const showNeedAfter = dollars(afterFind);
  check('NEED falls after a find', showNeedAfter !== null && showNeedAfter <= showNeedBefore,
    `${showNeedBefore} -> ${showNeedAfter}`);
  check('running hunt tally updates', /1 found/.test(afterFind));

  // ------------------------------------------------------ totals reconcile
  console.log('\nreconciliation');
  await page.goto(`${BASE}/app`);
  await page.waitForTimeout(500);
  const heroText = await page.locator('section').first().innerText();
  const nums = heroText.replace(/,/g, '').match(/\$[0-9]+(?:\.[0-9]{2})?/g) ?? [];
  const [need, have, complete] = nums.map((n) => parseFloat(n.slice(1)));
  check('hero exposes TO GO, HAVE and COMPLETE', nums.length >= 3, `got ${nums.join(' ')}`);
  if (nums.length >= 3) {
    check(
      'HAVE + NEED equals COMPLETE on screen',
      Math.abs(have + need - complete) < 0.02,
      `${have} + ${need} != ${complete}`,
    );
  }

  // ------------------------------------------------------------ other pages
  console.log('\nremaining screens');
  for (const [path, marker] of [
    ['/app/collection', 'Collection'],
    ['/app/trade', 'Trade'],
    ['/app/journey', 'journey'],
    ['/app/binder', 'binder'],
    ['/app/moves', 'Next Best Move'],
    ['/app/profile', 'Data & pricing'],
  ]) {
    await page.goto(`${BASE}${path}`);
    const text = await page.locator('body').innerText();
    check(`${path} renders`, text.toLowerCase().includes(marker.toLowerCase()));
  }

  // The journey must have recorded the hunt and the acquisitions.
  await page.goto(`${BASE}/app/journey`);
  const journey = await page.locator('main').innerText();
  check('journey records acquisitions', journey.includes('Added'));
  check('journey records the tracked set', journey.includes('Started chasing'));

  // ---------------------------------------------------------- public sharing
  console.log('\nsharing (opt-in)');
  await page.goto(`${BASE}/app/profile`);
  const profile = await page.locator('main').innerText();
  check('sharing is off by default', /Off\. Nobody can see your collection/.test(profile));
  check('no share link is shown while private', !/\/c\//.test(profile));

  const toggle = page.locator('button[role="switch"]');
  check('a sharing control exists', await toggle.isVisible());

  // Private collections must be indistinguishable from missing ones.
  const anon = await browser.newPage();
  const privateResp = await anon.goto(`${BASE}/c/e2e_collector`);
  check('private collection is not readable', (privateResp?.status() ?? 0) === 404);

  await toggle.click();
  await page.waitForTimeout(900);
  const handle = (await page.locator('main').innerText()).match(/\/c\/([a-z0-9_]+)/)?.[1];
  check('opting in reveals the share URL', !!handle);

  if (handle) {
    const resp = await anon.goto(`${BASE}/c/${handle}`);
    check('public page renders once opted in', (resp?.status() ?? 0) === 200);
    const shared = await anon.locator('body').innerText();
    check('public page shows progress', shared.includes('Progress'));
    check('public page hides purchase prices', !shared.toLowerCase().includes('paid'));

    // And opting back out must close it again.
    await page.locator('button[role="switch"]').click();
    await page.waitForTimeout(900);
    const closed = await anon.goto(`${BASE}/c/${handle}`);
    check('opting back out closes the page', (closed?.status() ?? 0) === 404);
  }
  await anon.close();

  // ------------------------------------------------------- sign-in throttle
  //
  // The limiter runs before the credential check, so it is exercisable on any
  // identity provider. Rejecting a *wrong password* is Supabase Auth's job and
  // cannot be driven here without a real project — that half is reported
  // BLOCKED rather than asserted, because the local development provider does
  // not check passwords at all.
  console.log('\nsign-in throttle');
  const attacker = await browser.newPage();
  let throttled = false;
  let wrongPasswordRejected = false;
  for (let i = 0; i < 14 && !throttled; i++) {
    await attacker.goto(`${BASE}/signin`);
    await attacker.fill('#email', email);
    await attacker.fill('#password', `wrong-guess-${i}`);
    await attacker.click('button:has-text("Sign in")');
    await attacker.waitForTimeout(250);
    const text = await attacker.locator('main').innerText();
    if (/Too many sign-in attempts/i.test(text)) throttled = true;
    if (/did not match/i.test(text)) wrongPasswordRejected = true;
  }
  check('repeated sign-in attempts get throttled', throttled);

  if (supabaseAuth) {
    check('a wrong password is rejected', wrongPasswordRejected);
  } else {
    console.log(
      '  BLOCKED — Supabase credentials/environment unavailable: a wrong password is rejected',
    );
    blocked.push('a wrong password is rejected');
  }
  await attacker.close();
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\nERROR', err);
} finally {
  await browser.close();
}

console.log(
  `\n${passed} passed, ${failures.length} failed${blocked.length ? `, ${blocked.length} blocked` : ''}`,
);
if (blocked.length) {
  console.log('\nblocked — Supabase credentials/environment unavailable:');
  for (const b of blocked) console.log(`  - ${b}`);
}
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
