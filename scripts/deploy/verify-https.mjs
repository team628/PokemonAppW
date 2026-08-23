/**
 * The deployment safety gate, over the HTTPS query endpoint.
 *
 * scripts/pg/verify.mjs is the canonical gate but connects with `pg`, which
 * cannot reach a hosted project from this container. This runs the identical
 * checks over the Management query endpoint. It asks the database whether
 * migration 0013's properties hold rather than reading a version number, so it
 * also catches a database that was migrated and has since had a grant restored.
 *
 * Exits non-zero — loudly — when the database is not safe to expose.
 */
import { query } from './https-sql.mjs';

const OWNED_TABLES = [
  'profiles', 'set_goals', 'collection_items', 'collection_events',
  'wishlist_items', 'milestones', 'show_sessions', 'show_finds', 'idempotency_keys',
];
const ANON_DEFINER = ['consume_rate_limit', 'demand_population', 'public_goal_missing'];

const failures = [];
const notes = [];
function must(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const list = (rows, col) => rows.map((r) => r[col]);

console.log('\nschema');
const tables = list(
  await query(
    `select tablename from pg_tables where schemaname='public' and tablename = any(array[${OWNED_TABLES.map((t) => `'${t}'`).join(',')}])`,
  ),
  'tablename',
);
must('every collector-owned table exists', tables.length === OWNED_TABLES.length,
  `${tables.length} of ${OWNED_TABLES.length}${tables.length < OWNED_TABLES.length ? ` — missing ${OWNED_TABLES.filter((t) => !tables.includes(t)).join(', ')}` : ''}`);

console.log('\nmigration 0013 — partner authorization');
const pop = await query(
  `select p.prosecdef, pg_get_function_identity_arguments(p.oid) as args, p.proconfig
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='demand_population'`,
);
must('demand_population() exists', pop.length === 1, `${pop.length} definitions`);
if (pop.length === 1) {
  must('it is SECURITY DEFINER', pop[0].prosecdef === true);
  must('it takes no argument', pop[0].args === '', `"${pop[0].args}"`);
  must('its search_path is pinned', (pop[0].proconfig ?? []).some((c) => c.startsWith('search_path=')),
    (pop[0].proconfig ?? []).join(',') || 'unset');
}
const oracle = await query(
  `select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='user_wants_slot'`,
);
must('the individual-goal oracle user_wants_slot() is gone', oracle.length === 0);

console.log('\nprivileges');
const openDefiners = await query(
  `select p.proname, pg_get_function_identity_arguments(p.oid) as args
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef
     and (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))
   order by p.proname`,
);
must('no SECURITY DEFINER function is executable by PUBLIC', openDefiners.length === 0,
  openDefiners.map((r) => `${r.proname}(${r.args})`).join(', '));

const anonReach = list(
  await query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
     order by p.proname`,
  ),
  'proname',
);
must('anon reaches only its three intended definer functions',
  anonReach.length === ANON_DEFINER.length && anonReach.every((n, i) => n === ANON_DEFINER[i]),
  anonReach.join(', ') || 'none');

const uuidDefiners = await query(
  `select p.proname, pg_get_function_identity_arguments(p.oid) as args
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef
     and pg_get_function_identity_arguments(p.oid) like '%uuid%'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
);
must('no definer function lets a caller name whose data to read', uuidDefiners.length === 0,
  uuidDefiners.map((r) => `${r.proname}(${r.args})`).join(', '));

console.log('\nrow level security');
const rls = await query(
  `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname = any(array[${OWNED_TABLES.map((t) => `'${t}'`).join(',')}])`,
);
const noRls = rls.filter((r) => !r.enabled).map((r) => r.relname);
must('RLS is enabled on every collector-owned table', noRls.length === 0, noRls.join(', '));
const policies = await query(
  `select tablename, count(*)::int as n from pg_policies
   where schemaname='public' and tablename = any(array[${OWNED_TABLES.map((t) => `'${t}'`).join(',')}]) group by tablename`,
);
const unpoliced = OWNED_TABLES.filter((t) => !policies.some((p) => p.tablename === t));
must('every collector-owned table carries a policy', unpoliced.length === 0, unpoliced.join(', '));
const unforced = rls.filter((r) => r.enabled && !r.forced).map((r) => r.relname);
if (unforced.length) notes.push(`RLS enabled but not FORCEd on ${unforced.join(', ')} — table owner bypasses it; only a risk if the app ever connects as owner.`);

console.log('\ncatalog');
const [c] = await query(
  `select (select count(*) from public.sets)::int as sets,
          (select count(*) from public.cards)::int as cards,
          (select count(*) from public.prices)::int as prices`,
);
must('the catalog is populated', c.sets > 0 && c.cards > 0, `${c.sets} sets, ${c.cards} cards`);
if (c.prices === 0) notes.push('no prices ingested yet — every valuation reads as unpriced.');

if (notes.length) { console.log('\nnotes:'); for (const n of notes) console.log(`  - ${n}`); }
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed — NOT safe to expose:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nall checks passed — safe to expose');
