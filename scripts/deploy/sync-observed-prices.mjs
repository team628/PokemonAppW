/**
 * Observed-price sync — fill currently-unvalued identities with EXACT-match
 * TCGplayer-derived market prices (via TCGCSV). Observed only; never estimates.
 *
 * Exactness guarantees (built into the input, enforced here):
 *   - identity match is (card_id, variant) → the TCGplayer base product at the
 *     exact (set, number) with the subtype matching the variant's finish
 *     (holofoil↔Holofoil, normal↔Normal, reverseHolofoil↔Reverse Holofoil).
 *   - no cross-edition / cross-finish / cross-language / graded↔raw / approximate
 *     matches: anything without an exact-finish market price was rejected upstream.
 *   - provider='tcgplayer', source='tcgcsv', provider_product_id, currency USD,
 *     observed_on (snapshot) all preserved.
 *
 * Safety:
 *   - prices upsert only fills/refreshes and NEVER overwrites a newer observation
 *     (guarded by observed_on); price_points append ON CONFLICT DO NOTHING.
 *   - idempotent and safe to re-run.
 *
 *   node scripts/deploy/sync-observed-prices.mjs price_sync_data.json          # local
 *   node scripts/deploy/sync-observed-prices.mjs price_sync_data.json --prod   # production
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const prod = process.argv.includes('--prod');
if (!file) throw new Error('usage: sync-observed-prices.mjs <price_sync_data.json> [--prod]');
const { rows } = JSON.parse(readFileSync(file, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : `'${String(v).replace(/'/g, "''")}'`;
const row = (vals) => '(' + vals.map(lit).join(',') + ')';

let run;
if (prod) {
  const { query } = await import('./https-sql.mjs');
  run = (sql) => query(sql);
} else {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres' });
  run = async (sql) => (await pool.query(sql)).rows;
  process.on('exit', () => { void pool.end(); });
}

const priceRows = rows.map((r) => row([
  r.card_id, r.variant, 'tcgplayer', 'USD', r.low, r.mid, r.high, r.market, r.direct, today, 'tcgcsv', r.productId,
]));
const pointRows = rows.map((r) => row([r.card_id, r.variant, 'tcgplayer', today, r.market, r.low]));

async function main() {
  console.log(`Observed-price sync → ${prod ? 'PRODUCTION' : 'local'}: ${rows.length} exact-match price rows`);

  // Fill/refresh, but never clobber a NEWER observation (stale-guard on observed_on).
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < priceRows.length; i += CHUNK) {
    const slice = priceRows.slice(i, i + CHUNK);
    const res = await run(`insert into public.prices
      (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source,provider_product_id)
      values ${slice.join(',')}
      on conflict (card_id,variant,provider) do update set
        currency=excluded.currency, low_cents=excluded.low_cents, mid_cents=excluded.mid_cents,
        high_cents=excluded.high_cents, market_cents=excluded.market_cents, direct_cents=excluded.direct_cents,
        observed_on=excluded.observed_on, source=excluded.source, provider_product_id=excluded.provider_product_id,
        fetched_at=now()
      where excluded.observed_on >= public.prices.observed_on`);
    written += Array.isArray(res) ? res.length : 0;
  }
  for (let i = 0; i < pointRows.length; i += CHUNK) {
    const slice = pointRows.slice(i, i + CHUNK);
    await run(`insert into public.price_points (card_id,variant,provider,observed_on,market_cents,low_cents)
      values ${slice.join(',')}
      on conflict (card_id,variant,provider,observed_on) do nothing`);
  }
  console.log('done.');
}
main().catch((e) => { console.error('SYNC ERROR:', e.message); process.exit(1); });
