/**
 * Authenticated real-environment E2E against the deployed app.
 *
 * The headless browser cannot tunnel this container's egress proxy, so instead
 * of a browser we drive the deployed app's real HTTP surface as a genuinely
 * authenticated collector: sign in through Supabase Auth, materialise the exact
 * `sb-<ref>-auth-token` cookie @supabase/ssr expects, and call the same route
 * handlers the UI calls. Every request therefore runs through the same
 * middleware, the same `getUser()` revalidation, and the same RLS-scoped data
 * layer a real session would — this is the deployed product, exercised end to
 * end, not a mock.
 *
 * Journeys: dashboard, track a set, HAVE/NEED/COMPLETE, authoritative metric
 * recompute on every ownership change, 100% completion + the milestone moment,
 * item edit, remove/rollback, Card Show with an idempotent replayed find,
 * public-share privacy toggling, and two-account RLS isolation. Billing is
 * asserted OFF. Test users are created and deleted around the run.
 */
import { execFileSync } from 'node:child_process';
import { query } from './https-sql.mjs';

const BASE = process.env.PREVIEW_URL ?? 'https://pokemon-app-w-three.vercel.app';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REF = process.env.SUPABASE_PROJECT_REF;
const AUTH = `${SUPABASE_URL}/auth/v1`;
const COOKIE_NAME = `sb-${REF}-auth-token`;
const TARGET_SET = process.env.E2E_SET ?? 'fut20';

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** curl wrapper returning { status, body, json }. Status via -w sentinel so the
 *  parse is robust to HTTP/2 + Cloudflare header framing (no -i splitting). */
const SENT = '\n__STATUS__:';
function http(method, url, { headers = {}, body, cookie } = {}) {
  const args = ['-s', '--max-time', '45', '-X', method, url, '-w', `${SENT}%{http_code}`];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (cookie) args.push('-H', `Cookie: ${cookie}`);
  if (body !== undefined) { args.push('-H', 'Content-Type: application/json', '--data-binary', '@-'); }
  const out = execFileSync('curl', args, { input: body !== undefined ? JSON.stringify(body) : undefined, maxBuffer: 64 * 1024 * 1024 }).toString();
  const idx = out.lastIndexOf(SENT);
  const rawBody = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + SENT.length)) : 0;
  let json = null; try { json = JSON.parse(rawBody); } catch { /* not json */ }
  return { status, body: rawBody, json };
}

async function adminCreateUser(email, password, displayName) {
  const r = http('POST', `${AUTH}/admin/users`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    body: { email, password, email_confirm: true, user_metadata: { display_name: displayName } },
  });
  return r.json?.id;
}
function adminDeleteUser(id) {
  if (id) http('DELETE', `${AUTH}/admin/users/${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
}

function signIn(email, password) {
  const r = http('POST', `${AUTH}/token?grant_type=password`, {
    headers: { apikey: ANON }, body: { email, password },
  });
  if (!r.json?.access_token) throw new Error(`sign-in failed: ${r.body.slice(0, 200)}`);
  return r.json; // the session object auth-js stores
}

/** Build the sb-<ref>-auth-token cookie(s) the SSR client reads. */
function sessionCookie(session) {
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  if (encoded.length <= MAX) return `${COOKIE_NAME}=${encoded}`;
  const parts = [];
  for (let i = 0, n = 0; i < encoded.length; i += MAX, n++) parts.push(`${COOKIE_NAME}.${n}=${encoded.slice(i, i + MAX)}`);
  return parts.join('; ');
}

const j = (session, method, path, body) =>
  http(method, `${BASE}${path}`, { cookie: sessionCookie(session), body });

async function main() {
  console.log(`\n=== Authenticated E2E against ${BASE} (set ${TARGET_SET}) ===\n`);

  // Target set cards with their primary variant.
  const cards = await query(
    `select c.id as card_id, v.variant
       from public.cards c
       join public.card_variants v on v.card_id = c.id and v.is_primary
      where c.set_id = $1 order by c.number`, [TARGET_SET]);
  check('catalog: target set has cards', cards.length > 0, `${cards.length} cards`);

  const stamp = Date.now();
  const aliceEmail = `e2e.alice.${stamp}@setvalue-e2e.test`;
  const bobEmail = `e2e.bob.${stamp}@setvalue-e2e.test`;
  const PW = `Setvalue-E2E-${stamp}-x`;
  let aliceId, bobId;
  try {
    aliceId = await adminCreateUser(aliceEmail, PW, 'E2E Alice');
    bobId = await adminCreateUser(bobEmail, PW, 'E2E Bob');
    check('auth: created two confirmed users', Boolean(aliceId && bobId));

    const alice = signIn(aliceEmail, PW);
    const bob = signIn(bobEmail, PW);
    check('auth: password sign-in returns a session', Boolean(alice.access_token && bob.access_token));

    // Dashboard renders for an authenticated session.
    const dash = j(alice, 'GET', '/app');
    check('dashboard: GET /app renders (200)', dash.status === 200);

    // Sanity: an anonymous GET /app must still redirect, not render.
    const anonApp = http('GET', `${BASE}/app`, {});
    check('auth guard: anonymous /app redirects', anonApp.status === 307 || anonApp.status === 302, `status ${anonApp.status}`);

    // Track the set.
    const track = j(alice, 'POST', '/api/goals', { setId: TARGET_SET, mode: 'main' });
    check('track: POST /api/goals creates a goal', track.status === 200 && Boolean(track.json?.goalId));

    let goals = j(alice, 'GET', '/api/goals');
    const g0 = goals.json?.goals?.find((g) => g.setId === TARGET_SET);
    check('HAVE/NEED: fresh goal is 0%', g0 && g0.percent === 0, g0 ? `percent=${g0.percent} missing=${g0.missingCount}` : 'goal missing');

    // Own each card; metrics must recompute authoritatively and monotonically.
    let lastPercent = -1, lastOwned = -1, firstItemId = null, monotonic = true;
    let finalMetrics = null, completionMilestone = false;
    for (const c of cards) {
      const r = j(alice, 'POST', '/api/collection/add', { cardId: c.card_id, variant: c.variant, withMode: 'main' });
      if (r.status !== 200) { check(`own ${c.card_id}`, false, `status ${r.status} ${r.body.slice(0, 120)}`); monotonic = false; break; }
      const m = r.json.metrics;
      if (m.percent < lastPercent || m.ownedCount <= lastOwned) monotonic = false;
      lastPercent = m.percent; lastOwned = m.ownedCount; finalMetrics = m;
      if (!firstItemId) firstItemId = r.json.itemId;
      if (r.json.milestones && r.json.milestones.length) completionMilestone = true;
    }
    check('HAVE: authoritative metrics recompute monotonically as cards are owned', monotonic,
      finalMetrics ? `owned=${finalMetrics.ownedCount}/${finalMetrics.requiredCount}` : '');
    check('COMPLETE: set reaches 100%', finalMetrics && Math.abs(finalMetrics.percent - 1) < 1e-9,
      finalMetrics ? `percent=${finalMetrics.percent}` : '');
    check('completion moment: a milestone fired during the run', completionMilestone);

    // Optimistic edit path (server is the source of truth after the tap).
    const edit = j(alice, 'PATCH', `/api/collection/item/${firstItemId}`, { quantity: 3 });
    check('edit: PATCH item quantity succeeds', edit.status === 200);

    // Ownership boundary: a bogus/other id changes nothing and says so.
    const bogus = j(alice, 'PATCH', `/api/collection/item/00000000-0000-0000-0000-000000000000`, { quantity: 2 });
    check('edit: unknown item id is rejected (not a false success)', bogus.status >= 400, `status ${bogus.status}`);

    // Remove ALL copies of a card → drops below 100%; re-add → back to 100%
    // (rollback semantics). Quantity 999 clears every copy — card 0 was bumped
    // to qty 3 by the edit above, and removing a single copy would (correctly)
    // leave it owned, so we clear the lot to exercise the completion drop.
    const rem = j(alice, 'POST', '/api/collection/remove', { cardId: cards[0].card_id, variant: cards[0].variant, quantity: 999, withMode: 'main' });
    check('remove: clearing a card recomputes below 100%', rem.status === 200 && rem.json.metrics.percent < 1, `percent=${rem.json?.metrics?.percent}`);
    const readd = j(alice, 'POST', '/api/collection/add', { cardId: cards[0].card_id, variant: cards[0].variant, withMode: 'main' });
    check('remove→re-add restores 100%', readd.status === 200 && Math.abs(readd.json.metrics.percent - 1) < 1e-9);

    // Card Show: start, find (idempotent replay), end.
    const startS = j(alice, 'POST', '/api/show/session', { action: 'start', name: 'E2E hunt' });
    const sessionId = startS.json?.session?.id;
    check('Card Show: start a hunt session', startS.status === 200 && Boolean(sessionId));
    const idem = `e2e-${stamp}`;
    const find1 = j(alice, 'POST', '/api/show/find', { sessionId, cardId: cards[1].card_id, variant: cards[1].variant, idempotencyKey: idem, withMode: 'main' });
    check('Card Show: record a find', find1.status === 200 && !find1.json?.duplicate);
    const find2 = j(alice, 'POST', '/api/show/find', { sessionId, cardId: cards[1].card_id, variant: cards[1].variant, idempotencyKey: idem, withMode: 'main' });
    check('Card Show: replayed idempotency key is a no-op (offline-safe)', find2.status === 200 && find2.json?.duplicate === true);
    const endS = j(alice, 'POST', '/api/show/session', { action: 'end', sessionId });
    check('Card Show: end the session', endS.status === 200 && Boolean(endS.json?.summary));

    // Privacy — public share is opt-in and RLS-enforced.
    const aliceHandle = (await query('select handle from public.profiles where id = $1', [aliceId]))[0]?.handle;
    const pubOn = j(alice, 'POST', '/api/profile/share', { isPublic: true });
    check('privacy: enable public share', pubOn.status === 200 && pubOn.json?.isPublic === true);
    const anonView = http('GET', `${BASE}/c/${aliceHandle}`, {});
    check('privacy: public share page is visible to anon when opted-in', anonView.status === 200 && anonView.body.includes(aliceHandle));
    const pubOff = j(alice, 'POST', '/api/profile/share', { isPublic: false });
    check('privacy: disable public share', pubOff.status === 200 && pubOff.json?.isPublic === false);
    const anonHidden = http('GET', `${BASE}/c/${aliceHandle}`, {});
    check('privacy: private collection returns 404 to anon (RLS denies)', anonHidden.status === 404, `status ${anonHidden.status}`);

    // RLS isolation between two real accounts.
    const bobGoals = j(bob, 'GET', '/api/goals');
    const bobSeesAlice = (bobGoals.json?.goals ?? []).some((g) => g.setId === TARGET_SET);
    check("RLS: Bob does not see Alice's goals", bobGoals.status === 200 && !bobSeesAlice, `bob goals=${(bobGoals.json?.goals ?? []).length}`);
    const bobEditAlice = j(bob, 'PATCH', `/api/collection/item/${firstItemId}`, { quantity: 9 });
    check("RLS: Bob cannot edit Alice's item", bobEditAlice.status >= 400, `status ${bobEditAlice.status}`);
    // DB-level confirmation: as authenticated Bob, Alice's holdings are invisible.
    const crossRead = await query(
      `select set_config('role','authenticated',true), set_config('request.jwt.claims', $1, true);
       select count(*)::int as n from public.collection_items where user_id = $2`,
      [JSON.stringify({ sub: bobId, role: 'authenticated' }), aliceId]);
    // (two statements → last result is the count)
    const crossN = Array.isArray(crossRead) ? (crossRead[crossRead.length - 1]?.n ?? crossRead[0]?.n) : null;
    check("RLS (DB): Alice's rows are 0 when read as Bob", crossN === 0, `rows=${crossN}`);

    // Billing OFF — no checkout surface; the webhook does not act without keys.
    const checkout = http('POST', `${BASE}/api/billing/checkout`, { cookie: sessionCookie(alice), body: {} });
    check('billing OFF: no checkout endpoint', checkout.status === 404, `status ${checkout.status}`);
    const dashHtml = j(alice, 'GET', '/app').body;
    check('billing OFF: no payment UI on dashboard', !/stripe|checkout|upgrade to pro|add card|\$\d+\s*\/\s*mo/i.test(dashHtml));
  } finally {
    adminDeleteUser(aliceId);
    adminDeleteUser(bobId);
    console.log('\n  (cleanup) test users deleted');
  }

  console.log(`\n=== E2E RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('E2E ERROR:', e.message); process.exitCode = 1; });
