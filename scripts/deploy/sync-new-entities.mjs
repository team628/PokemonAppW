/**
 * New-entity ingest — create missing base collectible ENTITIES (sets + cards +
 * variants) for legitimate released English collectibles that pokemontcg.io does
 * not carry and SetValue had no base card for, sourced from TCGplayer via TCGCSV.
 *
 * This is the catalog-completion pass that follows the identity architecture fix
 * (migrations 0021/0022) and the treatment/finish ingest. Each entity was
 * reconciled from the MISSING_ENTITY population: Japanese-only, sealed, provider
 * artifacts, non-English, and already-represented slots were excluded with explicit
 * reasons; only physically-substantiated cards remain.
 *
 * Strictly additive & provenance-preserving:
 *   - sets / cards / card_variants / prices / price_points insert ON CONFLICT DO
 *     NOTHING (no target where a row can collide on more than the PK), so no
 *     existing set, card, variant, price, history, or ownership is ever overwritten,
 *     and a re-run is a clean no-op (idempotent).
 *   - cards.provider = 'tcgcsv'; prices.provider = 'tcgplayer', source = 'tcgcsv',
 *     with the TCGplayer provider_product_id preserved — labelled TCGplayer-derived,
 *     never presented as pokemontcg.io.
 *   - Each identity carries its OWN observed price; nothing inherits another
 *     identity's price. A variant with no trustworthy price is still created (it
 *     resolves to UNVALUED) rather than being dropped.
 *   - New variants are is_primary only for the base treatment; treatment variants
 *     are treatment<>'base', so set completion (base-only, migration 0021) counts
 *     the base printings and cannot explode.
 *
 *   node scripts/deploy/sync-new-entities.mjs <sets.json> <cards.json> <variants.json>          # local
 *   node scripts/deploy/sync-new-entities.mjs <sets.json> <cards.json> <variants.json> --prod   # production
 */
import { readFileSync } from 'node:fs';

const [setsFile, cardsFile, variantsFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const prod = process.argv.includes('--prod');
if (!setsFile || !cardsFile || !variantsFile) {
  throw new Error('usage: sync-new-entities.mjs <sets.json> <cards.json> <variants.json> [--prod]');
}
const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
const cards = JSON.parse(readFileSync(cardsFile, 'utf8'));
const variants = JSON.parse(readFileSync(variantsFile, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
  : `'${String(v).replace(/'/g, "''")}'`;
const row = (vals) => '(' + vals.map(lit).join(',') + ')';
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

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

const setRows = sets.map((s) => [s.id, s.name, s.series, s.printed_total, s.total, null, s.release_date || null, 'tcgcsv']);
const cardRows = cards.map((c) => [
  c.id, c.set_id, c.number, c.number_sort, c.number_suffix ?? '', c.name, c.supertype,
  JSON.stringify([]), c.rarity, null, null, JSON.stringify([]), JSON.stringify([]), null,
  c.image_small, c.image_large, c.is_secret, 'tcgcsv',
]);
const variantRows = variants.map((v) => [v.card_id, v.variant, 'market_data', v.is_primary, v.edition ?? null, v.finish ?? null, v.treatment ?? 'base', 'EN', false]);
const priceRows = variants
  .filter((v) => v.market_cents != null || v.mid != null || v.low != null)
  .map((v) => [v.card_id, v.variant, 'tcgplayer', 'USD', v.low, v.mid, v.high, v.market_cents, v.direct, today, 'tcgcsv', v.productId]);
const pointRows = priceRows.map((p) => [p[0], p[1], 'tcgplayer', today, p[7], p[4]]);

async function main() {
  console.log(`New-entity ingest → ${prod ? 'PRODUCTION' : 'local'}: ${setRows.length} sets, ${cardRows.length} cards, ` +
    `${variantRows.length} variants (${priceRows.length} priced, ${variantRows.length - priceRows.length} UNVALUED)`);

  for (const slice of chunk(setRows, 200)) {
    await run(`insert into public.sets (id,name,series,printed_total,total,ptcgo_code,release_date,provider)
      values ${slice.map(row).join(',')} on conflict (id) do nothing`);
  }
  for (const slice of chunk(cardRows, 300)) {
    await run(`insert into public.cards
      (id,set_id,number,number_sort,number_suffix,name,supertype,subtypes,rarity,artist,hp,types,national_dex,flavor_text,image_small,image_large,is_secret,provider)
      values ${slice.map(row).join(',')} on conflict (id) do nothing`);
  }
  for (const slice of chunk(variantRows, 400)) {
    await run(`insert into public.card_variants (card_id,variant,source,is_primary,edition,finish,treatment,language,needs_resolution)
      values ${slice.map(row).join(',')} on conflict do nothing`);
  }
  for (const slice of chunk(priceRows, 400)) {
    await run(`insert into public.prices
      (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source,provider_product_id)
      values ${slice.map(row).join(',')} on conflict (card_id,variant,provider) do nothing`);
  }
  for (const slice of chunk(pointRows, 400)) {
    await run(`insert into public.price_points (card_id,variant,provider,observed_on,market_cents,low_cents)
      values ${slice.map(row).join(',')} on conflict (card_id,variant,provider,observed_on) do nothing`);
  }
  console.log('done.');
}
main().catch((e) => { console.error('SYNC ERROR:', e.message); process.exit(1); });
