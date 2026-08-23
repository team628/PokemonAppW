/**
 * Emit price observations from a live provider to JSON, using the real adapter
 * so the mapping has a single source of truth. Consumed by
 * apply-baseset-editions.mjs, which writes to whichever database is targeted.
 *
 *   tsx scripts/deploy/emit-observations.ts tcgcsv base1 > /tmp/obs.json
 */
import { priceProvider } from '../../src/lib/pricing/providers/index';

async function main() {
  const [, , providerId = 'tcgcsv', ...setIds] = process.argv;
  const provider = priceProvider(providerId);
  if (!provider) throw new Error(`unknown provider ${providerId}`);
  if (!provider.available) throw new Error(`provider ${providerId} is not available (dormant)`);
  const observations = await provider.observe({ setIds: setIds.length ? setIds : ['base1'] });
  process.stdout.write(JSON.stringify({ provider: providerId, count: observations.length, observations }, null, 0));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
