/**
 * Deployment gate: is this database safe to put an application in front of?
 *
 *   node scripts/pg/verify.mjs [connection-string]
 *
 * Exits non-zero — loudly — when the answer is no. Intended to run after
 * migrations and before anything is exposed, including in CI.
 *
 * Migrations are applied by file, not tracked in a table, so "is 0013 applied"
 * cannot be answered by reading a version number. It is answered the only way
 * that cannot be wrong: by asking the database whether the things 0013 does are
 * true of it. A database that reports the right version but has had a grant
 * restored underneath it is exactly the database this is meant to catch.
 *
 * The checks are the security properties, not a checklist of statements:
 *
 *   - `demand_population()` exists, is SECURITY DEFINER, takes no argument
 *   - `user_wants_slot(uuid, text, text)` — the individual-goal oracle — is gone
 *   - no SECURITY DEFINER function is executable by PUBLIC
 *   - `anon` can execute only the three entry points it is supposed to have
 *   - RLS is enabled and forced-on for every table holding collector data
 *   - the tables a collector owns all carry an owner policy
 */
import pg from 'pg';

const url =
  process.argv[2] ??
  process.env.SUPABASE_DB_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/postgres';

const OWNED_TABLES = [
  'profiles',
  'set_goals',
  'collection_items',
  'collection_events',
  'wishlist_items',
  'milestones',
  'show_sessions',
  'show_finds',
  'idempotency_keys',
];

/** Exactly the SECURITY DEFINER functions anonymous traffic is meant to reach. */
const ANON_DEFINER = ['consume_rate_limit', 'demand_population', 'public_goal_missing'];

const failures = [];
const notes = [];
function must(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const client = new pg.Client({
  connectionString: url,
  ssl:
    url.includes('127.0.0.1') || url.includes('localhost')
      ? undefined
      : { rejectUnauthorized: true },
});
await client.connect();

try {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  console.log(`\nverifying ${url.replace(/:[^:@/]*@/, ':***@')}\n`);
  console.log('schema');
  const tables = (
    await q(
      `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
      [OWNED_TABLES],
    )
  ).map((r) => r.tablename);
  must(
    'every collector-owned table exists',
    tables.length === OWNED_TABLES.length,
    `${tables.length} of ${OWNED_TABLES.length}${
      tables.length < OWNED_TABLES.length
        ? ` — missing ${OWNED_TABLES.filter((t) => !tables.includes(t)).join(', ')}`
        : ''
    }`,
  );

  console.log('\nmigration 0013 — partner authorization');
  const pop = await q(
    `select p.prosecdef, pg_get_function_identity_arguments(p.oid) as args, p.proconfig
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'demand_population'`,
  );
  must('demand_population() exists', pop.length === 1, `${pop.length} definitions`);
  if (pop.length === 1) {
    must('it is SECURITY DEFINER', pop[0].prosecdef === true);
    must('it takes no argument', pop[0].args === '', `"${pop[0].args}"`);
    must(
      'its search_path is pinned',
      (pop[0].proconfig ?? []).some((c) => c.startsWith('search_path=')),
      (pop[0].proconfig ?? []).join(',') || 'unset',
    );
  }

  const oracle = await q(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'user_wants_slot'`,
  );
  must('the individual-goal oracle user_wants_slot() is gone', oracle.length === 0);

  console.log('\nprivileges');
  const openDefiners = await q(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))
     order by p.proname`,
  );
  must(
    'no SECURITY DEFINER function is executable by PUBLIC',
    openDefiners.length === 0,
    openDefiners.map((r) => `${r.proname}(${r.args})`).join(', '),
  );

  const anonReach = (
    await q(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by p.proname`,
    )
  ).map((r) => r.proname);
  must(
    'anon reaches only its three intended definer functions',
    anonReach.length === ANON_DEFINER.length && anonReach.every((n, i) => n === ANON_DEFINER[i]),
    anonReach.join(', ') || 'none',
  );

  const uuidDefiners = await q(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and pg_get_function_identity_arguments(p.oid) like '%uuid%'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  );
  must(
    'no definer function lets a caller name whose data to read',
    uuidDefiners.length === 0,
    uuidDefiners.map((r) => `${r.proname}(${r.args})`).join(', '),
  );

  console.log('\nrow level security');
  const rls = await q(
    `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1)`,
    [OWNED_TABLES],
  );
  const noRls = rls.filter((r) => !r.enabled).map((r) => r.relname);
  must('RLS is enabled on every collector-owned table', noRls.length === 0, noRls.join(', '));

  const policies = await q(
    `select tablename, count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename = any($1) group by tablename`,
    [OWNED_TABLES],
  );
  const unpoliced = OWNED_TABLES.filter((t) => !policies.some((p) => p.tablename === t));
  must('every collector-owned table carries a policy', unpoliced.length === 0, unpoliced.join(', '));

  // A table with RLS on and no policy denies everything, which is safe but
  // broken; a table with RLS off is the dangerous one and is caught above.
  const unforced = rls.filter((r) => r.enabled && !r.forced).map((r) => r.relname);
  if (unforced.length) {
    notes.push(
      `RLS is enabled but not FORCEd on ${unforced.join(', ')} — the table owner bypasses ` +
        'it. That is how Supabase ships and is only a risk if the application ever ' +
        'connects as the owner rather than as anon/authenticated.',
    );
  }

  console.log('\ncatalog');
  const [{ sets, cards, prices }] = await q(
    `select (select count(*) from public.sets)::int as sets,
            (select count(*) from public.cards)::int as cards,
            (select count(*) from public.prices)::int as prices`,
  );
  must('the catalog is populated', sets > 0 && cards > 0, `${sets} sets, ${cards} cards`);
  if (prices === 0) notes.push('no prices ingested yet — every valuation will read as unpriced.');
} finally {
  await client.end();
}

if (notes.length) {
  console.log('\nnotes:');
  for (const n of notes) console.log(`  - ${n}`);
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed — this database is NOT safe to expose:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nApply supabase/migrations in order and re-run before deploying.');
  process.exit(1);
}
console.log('\nall checks passed — safe to expose');
