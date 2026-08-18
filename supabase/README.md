# Supabase deployment

## Environment

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>     # server only, never NEXT_PUBLIC_
SUPABASE_DB_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
CARD_DATA_PROVIDER=pokemontcg
POKEMONTCG_API_KEY=<optional, raises the provider rate limit>
```

`SUPABASE_DB_URL` must use the **Supavisor pooler on port 6543** (transaction
mode). That is what makes a connection pool safe from Vercel's serverless
functions; the direct 5432 endpoint will exhaust connections under load.

## Applying the schema

```bash
supabase link --project-ref <ref>
supabase db push                       # runs supabase/migrations in order
supabase db execute -f supabase/schedule.sql   # registers pg_cron jobs
```

Migrations are idempotent and safe to re-run — CI applies them twice to prove it.

Then verify the database is safe to expose before pointing anything at it:

```bash
SUPABASE_DB_URL=... npm run verify
```

This exits non-zero on a database missing migration 0013, and on any database
where a SECURITY DEFINER function is executable by PUBLIC, RLS is off on an
owner-scoped table, or `anon` can reach more than its three intended entry
points. It asks the database what is true of it rather than reading a version
number, so it also catches a correctly-migrated database that has since had a
grant restored underneath it.

## Secrets used by the scheduler

`supabase/schedule.sql` reads two Vault secrets so pg_cron can invoke Edge
Functions:

```sql
select vault.create_secret('https://<project>.supabase.co/functions/v1', 'setvalue_function_url');
select vault.create_secret('<service role key>', 'setvalue_service_key');
```

## Jobs

| Job | Cadence | Responsibility |
|---|---|---|
| `setvalue-hourly-prices` | hourly, :07 | `price-sync` — refresh 12 sets, most-wanted first, among those older than 20h |
| `setvalue-nightly-catalog` | daily, 03:20 UTC | `catalog-sync` — discover sets/cards/printings, reconcile metadata, rebuild the want index |
| `setvalue-want-index` | daily, 03:50 UTC | rebuild the want index from first principles |
| `setvalue-sweeps` | daily, 04:30 UTC | expire idempotency keys and rate-limit windows |

The first two are Edge Functions (`supabase/functions/`); the last two run
entirely in-database. All four are registered by `schedule.sql`.

The provider serves prices a set at a time, so a set is the unit of work.
Twelve an hour against a 174-set catalog is 288 set-refreshes a day — every set
at least daily, with headroom for the most-wanted to come round more than once.
Ordering by demand alone would refresh the same dozen popular sets forever, so a
set only becomes a candidate once its prices are stale; among the candidates,
open demand from the want index decides the order.

The want index is maintained incrementally by triggers during the day. It is
rebuilt twice a night on purpose: `catalog-sync` rebuilds it because cards
discovered in that run can create new wants, and the standalone job repeats it
in-database so reconciliation still happens on a night when the provider is
unreachable and `catalog-sync` fails.

A scheduled run that fails is recorded in `sync_runs` with status `failed` and
the error. The ingest's own run row is written inside the transaction that does
the work and rolls back with it — which is correct, but would mean an outage
left no trace at all, and "no row" is also what a job that never fired looks
like.

## Local development

No Supabase project is required to run the schema or the tests:

```bash
/usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata -U postgres --auth=trust
/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log start
for f in supabase/migrations/*.sql; do psql "$SUPABASE_DB_URL" -f "$f"; done
npx tsx scripts/pg/ingest.ts catalog && npx tsx scripts/pg/ingest.ts prices
```

Migration `0001_foundation.sql` creates the `auth` schema, the
anon/authenticated/service_role roles and `auth.uid()` only when absent, so the
same migrations run against both a plain PostgreSQL instance and a hosted
Supabase project. RLS behaves identically in both.
