/**
 * Live-app collector-facing trace against the DEPLOYED Vercel app.
 *
 * Proves DATABASE_MATCH the only way that is airtight at runtime: a Supabase
 * SSR session cookie is signed by ONE project's secret. We sign in against the
 * project our ingest wrote to (NEXT_PUBLIC_SUPABASE_URL), mint that project's
 * sb-<ref>-auth-token cookie, and present it to the live app. If the live app
 * returns authenticated data, its configured Supabase project IS ours. If it
 * 401s, the live app points at a different database — that is the root cause.
 *
 * Then it runs ordinary collector search queries through the live /api/search
 * route (the same handler the UI calls) and reports, per query: total hits,
 * whether the target card_id appears, and at what rank — the Gengar-Staff
 * "exists but unreachable" failure mode. Read-only except one throwaway test
 * user, created and deleted around the run.
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

const SENT = '\n__STATUS__:';
function http(method, url, { headers = {}, body, cookie } = {}) {
  const args = ['-s', '--max-time', '45', '-X', method, url, '-w', `${SENT}%{http_code}`];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (cookie) args.push('-H', `Cookie: ${cookie}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  let out = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try { out = execFileSync('curl', args, { input: body !== undefined ? JSON.stringify(body) : undefined, maxBuffer: 64 * 1024 * 1024 }).toString(); break; }
    catch (e) { out = (e.stdout ? e.stdout.toString() : '') || `${SENT}0`; if (attempt === 0) continue; }
  }
  const idx = out.lastIndexOf(SENT);
  const rawBody = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + SENT.length)) : 0;
  let json = null; try { json = JSON.parse(rawBody); } catch { /* not json */ }
  return { status, body: rawBody, json };
}
const grantInvite = (email) => http('POST', `${SUPABASE_URL}/rest/v1/rpc/grant_beta_invite`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }, body: { p_email: email, p_note: 'live-trace' } });
const adminCreate = (email, password) => http('POST', `${AUTH}/admin/users`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }, body: { email, password, email_confirm: true, user_metadata: { display_name: 'LiveTrace' } } });
const adminDelete = (id) => { if (id) http('DELETE', `${AUTH}/admin/users/${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }); };
function signIn(email, password) {
  const r = http('POST', `${AUTH}/token?grant_type=password`, { headers: { apikey: ANON }, body: { email, password } });
  if (!r.json?.access_token) throw new Error(`sign-in failed: ${r.status} ${r.body.slice(0, 160)}`);
  return r.json;
}
function sessionCookie(session) {
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  if (encoded.length <= MAX) return `${COOKIE_NAME}=${encoded}`;
  const parts = []; for (let i = 0, n = 0; i < encoded.length; i += MAX, n++) parts.push(`${COOKIE_NAME}.${n}=${encoded.slice(i, i + MAX)}`);
  return parts.join('; ');
}

// (query, optional set, target card_id we expect to be reachable, note)
const BATTERY = [
  ['charizard', null, null, 'bare popular name'],
  ['gengar', null, 'swshp-SWSH052', 'Gengar bare name — is a specific promo reachable?'],
  ['pikachu', null, 'swshp-SWSH020', 'Pikachu bare name'],
  ['lucario', null, 'league-and-championship-cards-63', '2nd Place variant card (added this session)'],
  ['tropical wind', null, 'np-26', 'Participation variant (added this session)'],
  ['leafeon', null, 'hgss3-17', 'Prerelease treatment (added this session)'],
  ['eevee gx', null, 'jumbo-cards-sm174-eevee-gx', 'new jumbo card (added this session)'],
  ['tyranitar', null, 'jumbo-cards-3-tyranitar', 'new jumbo card (added this session)'],
  ['inteleon vmax', null, 'swsh8-79', 'Prize Pack treatment (added this session)'],
  ['charizard', 'sv3', 'sv3-125', 'set-scoped Charizard ex'],
];

async function main() {
  console.log(`\n=== LIVE TRACE against ${BASE}\n    signing in against project ref=${REF} (${SUPABASE_URL})\n`);
  const stamp = Date.now();
  const email = `livetrace.${stamp}@setvalue-e2e.test`;
  const PW = `LiveTrace-${stamp}-x`;
  let uid;
  try {
    grantInvite(email);
    const c = adminCreate(email, PW);
    uid = c.json?.id;
    console.log(`test user create: status ${c.status} id ${uid || '(none) ' + c.body.slice(0, 160)}`);
    if (!uid) throw new Error('could not create test user');

    const session = signIn(email, PW);
    const cookie = sessionCookie(session);
    console.log(`signed in; minted cookie ${COOKIE_NAME} (${cookie.length} bytes)\n`);

    // ---- DATABASE_MATCH proof ----
    const dash = http('GET', `${BASE}/app`, { cookie });
    const anon = http('GET', `${BASE}/app`, {});
    console.log('--- DATABASE_MATCH ---');
    console.log(`  live /app WITH our-project session cookie -> ${dash.status}  (200 => live app validates against ${REF})`);
    console.log(`  live /app anonymous                        -> ${anon.status}  (expect 307/302 redirect)`);
    const match = dash.status === 200;
    console.log(`  DATABASE_MATCH = ${match ? 'YES ✓ (live app uses OUR project ' + REF + ')' : 'NO ✗ (cookie rejected — live app uses a DIFFERENT project)'}\n`);
    if (!match) { console.log('  Live /app body head:', dash.body.slice(0, 200)); }

    // ---- live search trace ----
    console.log('--- LIVE SEARCH TRACE (through deployed /api/search) ---');
    for (const [q, set, target, note] of BATTERY) {
      const qs = new URLSearchParams({ q, limit: '30', offset: '0' }); if (set) qs.set('set', set);
      const r = http('GET', `${BASE}/api/search?${qs}`, { cookie });
      const results = r.json?.results ?? [];
      const total = r.json?.total ?? (Array.isArray(results) ? results.length : 0);
      let rank = -1;
      if (target) rank = results.findIndex((x) => x.id === target);
      const reach = !target ? 'n/a' : rank >= 0 ? `rank ${rank + 1}/${results.length}` : (total > results.length ? `NOT in first ${results.length} (total ${total}) → SEARCH_UNREACHABLE` : 'ABSENT');
      console.log(`  q="${q}"${set ? ' set=' + set : ''}  status=${r.status} total=${total} shown=${results.length}  target=${target || '—'} ${target ? '=> ' + reach : ''}   [${note}]`);
      if (r.status !== 200) console.log('      body:', r.body.slice(0, 160));
    }

    // ---- detail page reachability for a couple targets ----
    console.log('\n--- DETAIL PAGE (live server-rendered) ---');
    for (const id of ['league-and-championship-cards-63', 'np-26', 'jumbo-cards-sm174-eevee-gx', 'sv3-125']) {
      const r = http('GET', `${BASE}/app/cards/${encodeURIComponent(id)}`, { cookie });
      const hasName = /card|printing|variant|add to collection/i.test(r.body);
      console.log(`  /app/cards/${id} -> ${r.status} ${r.status === 200 ? (hasName ? '(renders card UI)' : '(200 but no card markup?)') : ''}`);
    }
  } finally {
    adminDelete(uid);
    try { await query("delete from public.beta_invites where email like '%@setvalue-e2e.test'"); } catch { /* best effort */ }
    console.log('\n(cleanup) test user + invite removed');
  }
}
main().catch((e) => { console.error('LIVE TRACE ERROR:', e.message); process.exitCode = 1; });
