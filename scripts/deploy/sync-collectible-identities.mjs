/**
 * Collectible-identity ingest — additive, orthogonal-identity aware (migration 0021).
 *
 * Ingests recognized-treatment and missing-finish collectible identities that
 * pokemontcg.io does not carry, sourced from TCGplayer via TCGCSV and attached to an
 * EXISTING SetValue base card (the entity is corroborated by our own catalog; the
 * market price + product id are TCGplayer-derived). Each identity is:
 *
 *   - independently ownable   — a new public.card_variants row with its own token
 *     (finish[__treatment]); treatment/language on the orthogonal axes from 0021.
 *   - independently priced     — its OWN public.prices row from its OWN TCGplayer
 *     product id. No price is ever inherited from the base card.
 *   - completion-safe          — every new row is is_primary=false and (for
 *     treatments) treatment<>'base', so set_requirements()/HAVE/NEED/COMPLETE for
 *     complete/main modes is unchanged (migration 0021 excludes treatments from all
 *     modes; is_primary=false keeps new finishes out of complete/main).
 *
 * Strictly additive & provenance-preserving:
 *   - card_variants / prices / price_points insert ON CONFLICT DO NOTHING, so no
 *     existing variant, price, history, ownership or provenance is ever overwritten.
 *     (`on conflict do nothing` with no target absorbs BOTH the (card_id,variant) PK
 *     and the uq_card_variants_identity unique index, so a re-run is a clean no-op.)
 *   - Pricefills (existing UNPRICED variants) upsert prices with a stale-guard on
 *     observed_on: they fill/refresh but never clobber a newer observation.
 *   - provider='tcgplayer', source='tcgcsv', provider_product_id preserved. Cards are
 *     labelled TCGplayer-derived, never presented as pokemontcg.io.
 *
 *   node scripts/deploy/sync-collectible-identities.mjs <variants.json> <pricefills.json>          # local
 *   node scripts/deploy/sync-collectible-identities.mjs <variants.json> <pricefills.json> --prod   # production (HTTPS)
 */
import { readFileSync } from 'node:fs';

const variantsFile = process.argv[2];
const pricefillsFile = process.argv[3];
const prod = process.argv.includes('--prod');
if (!variantsFile || !pricefillsFile) {
  throw new Error('usage: sync-collectible-identities.mjs <variants.json> <pricefills.json> [--prod]');
}
const variants = JSON.parse(readFileSync(variantsFile, 'utf8'));
const pricefills = JSON.parse(readFileSync(pricefillsFile, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
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

// New-identity rows (treatment + finish variants on existing cards).
const variantRows = [];
const priceRows = [];
const pointRows = [];
for (const c of variants) {
  // card_variants: additive identity, is_primary=false (completion-safe), EN.
  variantRows.push([c.card_id, c.variant, 'market_data', false, c.edition ?? null, c.finish ?? null, c.treatment ?? 'base', 'EN', false]);
  if (c.market_cents != null || c.mid != null || c.low != null) {
    priceRows.push([c.card_id, c.variant, 'tcgplayer', 'USD', c.low, c.mid, c.high, c.market_cents, c.direct, today, 'tcgcsv', c.productId]);
    pointRows.push([c.card_id, c.variant, 'tcgplayer', today, c.market_cents, c.low]);
  }
}

// Pricefill rows (existing variants that had no price): fill with exact-match price.
const fillPriceRows = [];
const fillPointRows = [];
for (const c of pricefills) {
  fillPriceRows.push([c.card_id, c.variant, 'tcgplayer', 'USD', c.low, c.mid, c.high, c.market_cents, c.direct, today, 'tcgcsv', c.productId]);
  fillPointRows.push([c.card_id, c.variant, 'tcgplayer', today, c.market_cents, c.low]);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function main() {
  console.log(`Collectible-identity ingest → ${prod ? 'PRODUCTION' : 'local'}: ` +
    `${variantRows.length} new identities (${variants.filter((v) => v.kind === 'treatment').length} treatment, ` +
    `${variants.filter((v) => v.kind === 'finish').length} finish), ${fillPriceRows.length} pricefills`);

  // 1. New identities — card_variants. `on conflict do nothing` (no target) so a
  //    conflict on EITHER the PK or the uq_card_variants_identity index is a no-op.
  for (const slice of chunk(variantRows, 400)) {
    await run(`insert into public.card_variants
      (card_id,variant,source,is_primary,edition,finish,treatment,language,needs_resolution)
      values ${slice.map(row).join(',')}
      on conflict do nothing`);
  }

  // 2. Their OWN prices + history (never inherited from base).
  for (const slice of chunk(priceRows, 400)) {
    await run(`insert into public.prices
      (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source,provider_product_id)
      values ${slice.map(row).join(',')}
      on conflict (card_id,variant,provider) do nothing`);
  }
  for (const slice of chunk(pointRows, 400)) {
    await run(`insert into public.price_points (card_id,variant,provider,observed_on,market_cents,low_cents)
      values ${slice.map(row).join(',')}
      on conflict (card_id,variant,provider,observed_on) do nothing`);
  }

  // 3. Pricefills — existing variants; fill/refresh with a stale-guard (never clobber a newer observation).
  for (const slice of chunk(fillPriceRows, 400)) {
    await run(`insert into public.prices
      (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source,provider_product_id)
      values ${slice.map(row).join(',')}
      on conflict (card_id,variant,provider) do update set
        currency=excluded.currency, low_cents=excluded.low_cents, mid_cents=excluded.mid_cents,
        high_cents=excluded.high_cents, market_cents=excluded.market_cents, direct_cents=excluded.direct_cents,
        observed_on=excluded.observed_on, source=excluded.source, provider_product_id=excluded.provider_product_id,
        fetched_at=now()
      where excluded.observed_on >= public.prices.observed_on`);
  }
  for (const slice of chunk(fillPointRows, 400)) {
    await run(`insert into public.price_points (card_id,variant,provider,observed_on,market_cents,low_cents)
      values ${slice.map(row).join(',')}
      on conflict (card_id,variant,provider,observed_on) do nothing`);
  }

  console.log('done.');
}
main().catch((e) => { console.error('SYNC ERROR:', e.message); process.exit(1); });
