/**
 * Tranche 2A — additive ingest of dual-corroborated, priced promo identities that
 * pokemontcg.io does NOT carry: SVP tail (svp #175-225 gaps) + MEP Black Star
 * Promos, sourced from TCGplayer via TCGCSV and independently corroborated by the
 * master spreadsheet's cited sources.
 *
 * Strictly additive & provenance-preserving:
 *   - cards / card_variants / prices / price_points upsert ON CONFLICT DO NOTHING
 *     (the MEP set row upserts metadata only), so no existing card, price,
 *     history, variant identity or ownership is ever overwritten.
 *   - cards.provider = 'tcgcsv'; prices.provider = 'tcgplayer', source = 'tcgcsv'
 *     — these are labelled TCGplayer-derived, never presented as pokemontcg.io.
 *   - Only base identities with a real market price are included (input is
 *     pre-filtered: no [Staff]/Prerelease/Pokémon-Center stamped variants, no
 *     holo-pattern micro-variants, no guessed prices).
 *
 *   node scripts/deploy/sync-tranche2a.mjs tranche2a_data.json           # local (DATABASE_URL)
 *   node scripts/deploy/sync-tranche2a.mjs tranche2a_data.json --prod    # production (HTTPS)
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const prod = process.argv.includes('--prod');
if (!file) throw new Error('usage: sync-tranche2a.mjs <data.json> [--prod]');
const { mepSet, cards } = JSON.parse(readFileSync(file, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
  : `'${String(v).replace(/'/g, "''")}'`;
const row = (vals) => '(' + vals.map(lit).join(',') + ')';

// number_sort / suffix, mirroring src/lib/sync/ingest.ts parseNumber
function parseNumber(raw) {
  const m = String(raw).match(/^([A-Za-z]*)(\d+)(.*)$/);
  if (!m) return { n: 999999, suffix: raw };
  const n = parseInt(m[2], 10);
  const offset = m[1] ? 100000 + m[1].charCodeAt(0) * 100 : 0;
  return { n: n + offset, suffix: (m[3] ?? '').trim() };
}

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

const cardRows = [];
const variantRows = [];
const priceRows = [];
const pointRows = [];
for (const c of cards) {
  const { n, suffix } = parseNumber(c.number);
  const secret = false; // promos are not secret rares
  cardRows.push([
    c.id, c.set_id, c.number, n, suffix, c.name, c.supertype,
    JSON.stringify(c.subtypes ?? []), c.rarity, null, c.hp,
    JSON.stringify(c.types ?? []), JSON.stringify([]),
    null, c.image_small, c.image_large, secret, 'tcgcsv',
  ]);
  for (const v of c.variants) {
    variantRows.push([c.id, v.variant, 'market_data', v.variant === c.primary]);
    if (v.market != null || v.mid != null || v.low != null) {
      priceRows.push([c.id, v.variant, 'tcgplayer', 'USD', v.low, v.mid, v.high, v.market, v.direct, today, 'tcgcsv']);
      pointRows.push([c.id, v.variant, 'tcgplayer', today, v.market, v.low]);
    }
  }
}

async function main() {
  console.log(`Tranche 2A → ${prod ? 'PRODUCTION' : 'local'}: ${cardRows.length} cards, ${variantRows.length} variants, ${priceRows.length} prices`);

  // 1. Set metadata (only when creating a new set; existing sets are untouched —
  //    pass mepSet=null to add cards into a set that already exists, e.g. swshp).
  if (mepSet) await run(`insert into public.sets (id,name,series,printed_total,total,ptcgo_code,release_date,provider)
    values (${lit(mepSet.id)},${lit(mepSet.name)},${lit(mepSet.series)},${lit(mepSet.printedTotal)},${lit(mepSet.total)},${lit(mepSet.ptcgoCode)},${lit(mepSet.releaseDate)},'tcgcsv')
    on conflict (id) do update set name=excluded.name, series=excluded.series,
      printed_total=excluded.printed_total, total=excluded.total,
      ptcgo_code=excluded.ptcgo_code, release_date=excluded.release_date, synced_at=now()`);

  await run(`insert into public.cards
    (id,set_id,number,number_sort,number_suffix,name,supertype,subtypes,rarity,artist,hp,types,national_dex,flavor_text,image_small,image_large,is_secret,provider)
    values ${cardRows.map(row).join(',')}
    on conflict (id) do nothing`);

  await run(`insert into public.card_variants (card_id,variant,source,is_primary)
    values ${variantRows.map(row).join(',')}
    on conflict (card_id,variant) do nothing`);

  if (priceRows.length) await run(`insert into public.prices
    (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source)
    values ${priceRows.map(row).join(',')}
    on conflict (card_id,variant,provider) do nothing`);

  if (pointRows.length) await run(`insert into public.price_points (card_id,variant,provider,observed_on,market_cents,low_cents)
    values ${pointRows.map(row).join(',')}
    on conflict (card_id,variant,provider,observed_on) do nothing`);

  console.log('done.');
}
main().catch((e) => { console.error('SYNC ERROR:', e.message); process.exit(1); });
