/**
 * Adversarial authorization audit against the deployed database.
 *
 *   node scripts/deploy/adversarial-https.mjs <aliceId> <bobId>
 *
 * Runs the same properties the local RLS and partner-authorization suites pin,
 * but over the HTTPS query endpoint against the real project, as the real
 * roles. Each probe sets `role` and the JWT claims inside one request — the same
 * SET LOCAL mechanism PostgREST uses — so what it exercises is exactly what a
 * signed-in (or anonymous) request would hit.
 *
 * The two accounts are real Supabase Auth users. Alice is given a goal and a
 * holding; every check then asks whether Bob, or anon, can reach any of it.
 */
import { query } from './https-sql.mjs';

const [aliceId, bobId] = process.argv.slice(2);
if (!aliceId || !bobId) throw new Error('usage: adversarial-https.mjs <aliceId> <bobId>');

let pass = 0;
const fail = [];
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/** Run a statement as a given identity, under RLS, in one transaction. */
const claims = (sub) => JSON.stringify({ sub, role: 'authenticated' });
async function asUser(sub, sql) {
  const wrapped = `set local role authenticated; select set_config('request.jwt.claims', '${claims(sub)}', true); ${sql}`;
  const rows = await query(wrapped);
  return rows;
}
async function asAnon(sql) {
  return query(`set local role anon; select set_config('request.jwt.claims', '{"role":"anon"}', true); ${sql}`);
}

console.log('\nseeding alice (as service_role, the app own write path)');
// Alice tracks a set and owns one card — data that must be hers alone.
await query(
  `insert into public.set_goals (user_id, set_id, mode)
   values ('${aliceId}'::uuid, 'base1', 'main')
   on conflict (user_id, set_id, mode) do nothing`,
);
await query(
  `insert into public.collection_items (user_id, card_id, variant, quantity)
   values ('${aliceId}'::uuid, 'base1-4', 'holofoil', 1)
   on conflict do nothing`,
);
const aliceGoals = await asUser(aliceId, 'select count(*)::int n from public.set_goals');
ok('alice sees her own goal', (aliceGoals.at(-1)?.n ?? 0) >= 1, `${aliceGoals.at(-1)?.n} goals`);
const aliceItems = await asUser(aliceId, 'select count(*)::int n from public.collection_items');
ok('alice sees her own holding', (aliceItems.at(-1)?.n ?? 0) >= 1, `${aliceItems.at(-1)?.n} items`);

console.log('\nbob cannot reach alice');
const bobGoals = await asUser(bobId, `select count(*)::int n from public.set_goals`);
ok('bob sees zero goals (alices hidden)', (bobGoals.at(-1)?.n ?? -1) === 0, `${bobGoals.at(-1)?.n}`);
const bobItems = await asUser(bobId, `select count(*)::int n from public.collection_items`);
ok('bob sees zero collection items', (bobItems.at(-1)?.n ?? -1) === 0, `${bobItems.at(-1)?.n}`);
const bobTargeted = await asUser(bobId, `select count(*)::int n from public.collection_items where user_id = '${aliceId}'::uuid`);
ok('bob cannot read alice by naming her id', (bobTargeted.at(-1)?.n ?? -1) === 0, `${bobTargeted.at(-1)?.n}`);
const bobProfiles = await asUser(bobId, `select count(*)::int n from public.profiles`);
ok('bob cannot enumerate other profiles', (bobProfiles.at(-1)?.n ?? -1) <= 1, `${bobProfiles.at(-1)?.n} visible`);

console.log('\nbob cannot write as alice');
let blocked = false;
try {
  await asUser(bobId, `insert into public.collection_items (user_id, card_id, variant, quantity) values ('${aliceId}'::uuid, 'base1-2', 'normal', 1)`);
} catch { blocked = true; }
ok('bob cannot insert a row owned by alice (RLS WITH CHECK)', blocked);

console.log('\nanon cannot reach any collector data');
for (const t of ['profiles', 'set_goals', 'collection_items', 'milestones', 'wishlist_items', 'show_sessions', 'show_finds']) {
  const r = await asAnon(`select count(*)::int n from public.${t}`);
  ok(`anon reads zero from ${t}`, (r.at(-1)?.n ?? -1) === 0, `${r.at(-1)?.n}`);
}

console.log('\nthe four grant holes 0013/0014 closed, on the live database');
const tryFail = async (label, sql, runner) => {
  let denied = false, msg = '';
  try { await runner(sql); } catch (e) { denied = true; msg = e.message.split('\n')[0]; }
  ok(label, denied, denied ? 'denied' : 'ALLOWED');
};
await tryFail('anon cannot write the demand index (want_index_bump)',
  `select public.want_index_bump('base1-4','holofoil',999999)`, asAnon);
await tryFail('anon cannot wipe the rate limiter (sweep_rate_limits)',
  `select public.sweep_rate_limits('0 seconds'::interval)`, asAnon);
await tryFail('anon cannot forge a price (apply_price_observation)',
  `select public.apply_price_observation('base1-4','holofoil','tcgplayer','USD',1,1,1,1,null,current_date)`, asAnon);
await tryFail('anon cannot reach cross-collector trade matching',
  `select * from public.trade_matches(5)`, asAnon);
await tryFail('the individual-goal oracle no longer exists',
  `select public.user_wants_slot('${aliceId}'::uuid,'base1-4','holofoil')`, asAnon);

console.log('\nthe public surfaces still work, and only expose aggregates');
const pop = await asAnon('select * from public.demand_population()');
ok('anon can read population counts', pop.length === 1 && Object.keys(pop[0]).sort().join() === 'collectors,tracked', JSON.stringify(pop[0]));
const dr = await asAnon('select * from public.demand_report(5, null)');
ok('demand_report returns card aggregates, no identities', dr.every((r) => !('user_id' in r)) , `${dr.length} rows`);

console.log('\ncleanup');
await query(`delete from public.collection_items where user_id = '${aliceId}'::uuid`);
await query(`delete from public.set_goals where user_id = '${aliceId}'::uuid`);

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('\nfailures:'); for (const f of fail) console.log(`  - ${f}`); process.exit(1); }
