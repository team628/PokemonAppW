/**
 * Catalog / price ingest against a hosted project, over the HTTPS query
 * endpoint.
 *
 *   node scripts/deploy/ingest-https.mjs catalog
 *   node scripts/deploy/ingest-https.mjs prices [setId ...]
 *
 * Same shared ingest core as the pg-socket script and the Edge Functions; the
 * only difference is the database handle it is given. Small batches, because
 * the endpoint inlines values into one SQL string rather than binding them.
 */
import { ingestCatalog, ingestPrices } from '../../src/lib/sync/ingest.ts';
import { httpsTx } from './https-sql.mjs';

process.env.SETVALUE_INGEST_BATCH_ROWS ||= '250';

const mode = process.argv[2] ?? 'catalog';
const setIds = process.argv.slice(3);
const scope = { setIds: setIds.length ? setIds : undefined, log: (m) => console.log(m) };
const tx = httpsTx();

try {
  if (mode === 'prices') await ingestPrices(tx, scope);
  else await ingestCatalog(tx, scope);
} catch (e) {
  console.error(`\ningest failed: ${e.message}`);
  process.exit(1);
}
