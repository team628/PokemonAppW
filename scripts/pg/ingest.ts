/**
 * Command-line ingest.
 *
 *   npx tsx scripts/pg/ingest.ts catalog
 *   npx tsx scripts/pg/ingest.ts prices [setId ...]
 *
 * A thin wrapper: the work lives in `src/lib/sync/ingest.ts`, which the
 * Supabase Edge Functions run too. All this adds is a `pg` connection as
 * `service_role`, and a place for CI to call it from.
 */
import { withServiceRole, closePool } from '../../src/lib/db/pg';
import { ingestCatalog, ingestPrices } from '../../src/lib/sync/ingest';

const mode = process.argv[2] ?? 'catalog';
const setIds = process.argv.slice(3);
const scope = { setIds: setIds.length ? setIds : undefined, log: (m: string) => console.log(m) };

void withServiceRole((tx) =>
  mode === 'prices' ? ingestPrices(tx, scope) : ingestCatalog(tx, scope),
)
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
