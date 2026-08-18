# Deploying

Two scripts and a fixed order. The order is the point: the safety gate sits
between the schema and anything that exposes it.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_…        # https://supabase.com/dashboard/account/tokens

# 1. Create the project. Writes credentials to ~/.setvalue-deploy/project.env (0600).
node scripts/deploy/provision.mjs --name setvalue --region us-east-1

set -a; . ~/.setvalue-deploy/project.env; set +a

# 2. Schema, then the gate. Do not continue past a failing gate.
npm run migrate
npm run migrate                            # idempotent by construction; prove it
npm run verify                             # exits non-zero if 0013 is missing

# 3. The catalog. ~20k cards, ~67k prices, from the live provider.
npm run ingest:catalog
npm run ingest:prices
npm run verify                             # again: ingest runs as service_role

# 4. The suite, against the real database.
npm test

# 5. Auth. Needs the deployed URL, so this comes after the first deploy.
node scripts/deploy/configure.mjs --site-url https://<preview>.vercel.app

# 6. Edge Functions and the schedule.
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase functions deploy price-sync catalog-sync
psql "$SUPABASE_DB_URL" -c "select vault.create_secret('https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1', 'setvalue_function_url');"
psql "$SUPABASE_DB_URL" -c "select vault.create_secret('$SUPABASE_SERVICE_ROLE_KEY', 'setvalue_service_key');"
psql "$SUPABASE_DB_URL" -f supabase/schedule.sql
npm run verify                             # schedule.sql adds a SECURITY DEFINER function
```

## Why `npm run verify` appears four times

It answers "is this database safe to put an application in front of", and the
answer changes. It runs after migrations because that is what it checks; after
ingest because ingest connects as `service_role`; and after `schedule.sql`
because that file creates `invoke_edge_function`, which is SECURITY DEFINER and
attaches the project's service-role key to an outbound request. PostgreSQL
grants EXECUTE to PUBLIC on every new function, so a missing revoke there is a
privilege escalation reachable by `anon`.

## Secrets

`provision.mjs` generates the database password itself and writes it, with the
API keys, to `~/.setvalue-deploy/project.env` at 0600 — outside the repository,
which `.gitignore` could not protect anyway. Nothing is printed. The values that
belong in Vercel are copied from that file into the project's Environment
Variables by hand; the service-role key must never be prefixed `NEXT_PUBLIC_`.

Rotate the database password in the dashboard once provisioning is done.
