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

Migrations are idempotent and safe to re-run.

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
| `setvalue-hourly-prices` | hourly, :07 | refresh market prices, highest-intent cards first |
| `setvalue-nightly-catalog` | daily, 03:20 UTC | discover sets/cards/printings, reconcile metadata |
| `setvalue-want-index` | daily, 03:50 UTC | rebuild the want index from first principles |
| `setvalue-sweeps` | daily, 04:30 UTC | expire idempotency keys and rate-limit windows |

The want index is maintained incrementally by triggers during the day; the
nightly rebuild is a reconciliation backstop, not the primary mechanism.

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
