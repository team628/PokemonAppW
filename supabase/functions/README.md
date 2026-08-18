# Edge Functions

Two scheduled jobs, invoked by pg_cron through pg_net. See `../schedule.sql` for
the registration and `../README.md` for the Vault secrets they need.

| Function | Cadence | Does |
|---|---|---|
| `price-sync` | hourly, :07 | refreshes prices for a bounded slice of the sets that are due, most-wanted first |
| `catalog-sync` | nightly, 03:20 UTC | reconciles sets, cards and metadata, then rebuilds the want index |

## They run the same code the rest of the project does

Neither function implements variant inference, the reverse-holo era rules, or
price normalisation. All of that is `src/lib/sync/ingest.ts`, which the
`npm run ingest:*` scripts and CI run on every pull request. The functions
supply a database handle and decide *which* sets; the shared core decides
everything about *how*. A second implementation of that logic in another
runtime is where quiet pricing bugs would live, so there isn't one.

The provider adapter (`src/lib/providers/pokemontcg.ts`) and the variant rules
(`src/lib/catalog/variants.ts`) run unmodified under Deno.

## Running them locally

They are Deno, so the project's `tsc` does not type-check them — `tsconfig.json`
excludes this directory and `deno check` covers it instead:

```bash
deno check --config supabase/functions/deno.json supabase/functions/*/index.ts

SUPABASE_DB_URL=postgresql://postgres@127.0.0.1:5432/postgres \
SUPABASE_SERVICE_ROLE_KEY=any-local-value \
deno run --allow-all --config supabase/functions/deno.json \
  supabase/functions/price-sync/index.ts

curl -X POST http://localhost:8000/ \
  -H "Authorization: Bearer any-local-value" \
  -H 'Content-Type: application/json' \
  -d '{"setIds":["base1"]}'
```

A request without the bearer token is refused with 401 before anything else
happens.

## Deploying

```bash
supabase functions deploy price-sync catalog-sync
```

The Supabase CLI bundles the import graph with esbuild, which resolves the
extensionless relative imports inside `src/`. `deno.json` turns on
`sloppy-imports` so local `deno check` and `deno run` resolve them the same way.
