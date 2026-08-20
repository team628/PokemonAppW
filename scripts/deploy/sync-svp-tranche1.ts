/**
 * Tranche 1 — additive SVP re-sync from live pokemontcg.io.
 *
 * SetValue's catalog snapshot stopped at svp #165; pokemontcg.io now exposes 200
 * SVP promos (up to #207). This adds ONLY the identities pokemontcg.io newly
 * exposes and SetValue lacks — nothing existing is touched:
 *   - cards / card_variants / prices / price_points all upsert ON CONFLICT DO
 *     NOTHING, so existing prices, ownership, history and variant identities are
 *     preserved exactly.
 *   - variant + price mapping reuses the real catalog helpers (inferVariants,
 *     primaryVariant, isVariant, reverseHoloEraAllows) so new rows are shaped
 *     identically to a normal ingest.
 *   - provenance preserved: provider 'pokemontcg', prices source 'pokemontcg'.
 *
 *   npx tsx scripts/deploy/sync-svp-tranche1.ts <live_full.json> <new_ids.json> <setmeta.json>            # local (DATABASE_URL)
 *   npx tsx scripts/deploy/sync-svp-tranche1.ts <live_full.json> <new_ids.json> <setmeta.json> --prod     # production (HTTPS)
 */
import { readFileSync } from 'node:fs';
import { inferVariants, isVariant, primaryVariant, reverseHoloEraAllows, type Variant } from '../../src/lib/catalog/variants';

const [fullPath, newIdsPath, metaPath] = process.argv.slice(2);
const prod = process.argv.includes('--prod');
if (!fullPath || !newIdsPath || !metaPath) throw new Error('usage: sync-svp-tranche1.ts <live_full.json> <new_ids.json> <setmeta.json> [--prod]');

const live = JSON.parse(readFileSync(fullPath, 'utf8')).data as any[];
const newIds = new Set(JSON.parse(readFileSync(newIdsPath, 'utf8')) as string[]);
const setMeta = JSON.parse(readFileSync(metaPath, 'utf8')).data;
const cards = live.filter((c) => newIds.has(c.id));
if (cards.length !== newIds.size) throw new Error(`expected ${newIds.size} new cards, matched ${cards.length}`);

// --- helpers (parseNumber mirrors src/lib/sync/ingest.ts exactly) ------------
function parseNumber(raw: string): { n: number; suffix: string } {
  const m = raw.match(/^([A-Za-z]*)(\d+)(.*)$/);
  if (!m) return { n: 999999, suffix: raw };
  const prefix = m[1] ?? '';
  const n = parseInt(m[2]!, 10);
  const tail = (m[3] ?? '').trim();
  const offset = prefix ? 100000 + prefix.charCodeAt(0) * 100 : 0;
  return { n: n + offset, suffix: tail };
}
const cents = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null;
const isoDate = (s: string | null | undefined): string | null =>
  s ? s.slice(0, 10).replace(/\//g, '-') : null;
const lit = (v: any): string =>
  v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
  : `'${String(v).replace(/'/g, "''")}'`;
const row = (vals: any[]) => '(' + vals.map(lit).join(',') + ')';

const setId = 'svp';
const releaseDate = isoDate(setMeta.releaseDate);
const printedTotal = setMeta.printedTotal ?? 0;

// --- build rows --------------------------------------------------------------
const cardRows: any[][] = [];
const variantRows: any[][] = [];
const priceRows: any[][] = [];
const pointRows: any[][] = [];

for (const c of cards) {
  const { n, suffix } = parseNumber(c.number);
  cardRows.push([
    c.id, setId, c.number, n, suffix, c.name, c.supertype ?? null,
    JSON.stringify(c.subtypes ?? []), c.rarity ?? null, c.artist ?? null, c.hp ?? null,
    JSON.stringify(c.types ?? []), JSON.stringify(c.nationalPokedexNumbers ?? []),
    c.flavorText ?? null, c.images?.small ?? null, c.images?.large ?? null,
    n > printedTotal && n < 100000, 'pokemontcg',
  ]);

  const plausible = inferVariants({ rarity: c.rarity ?? null, setId, setReleaseDate: releaseDate });
  const reverseAllowed = reverseHoloEraAllows(setId, releaseDate);
  const tcgDate = isoDate(c.tcgplayer?.updatedAt);
  const tcgVariants: Variant[] = [];
  if (c.tcgplayer?.prices && tcgDate) {
    for (const [k, p] of Object.entries<any>(c.tcgplayer.prices)) {
      if (!p || !isVariant(k)) continue;
      if (k === 'reverseHolofoil' && !reverseAllowed) continue;
      tcgVariants.push(k);
    }
  }
  const cm = c.cardmarket?.prices;
  const cmDate = isoDate(c.cardmarket?.updatedAt);
  const cmReverse = !!cm && !!(cm.reverseHoloTrend || cm.reverseHoloSell || cm.reverseHoloLow);
  const cmBase = !!cm && !!(cm.trendPrice || cm.averageSellPrice || cm.lowPrice);

  const variants: Variant[] = [...tcgVariants];
  if (!variants.length) variants.push(...plausible);
  if (cmReverse && reverseAllowed && !variants.includes('reverseHolofoil')) variants.push('reverseHolofoil');
  const isCovered = tcgVariants.length > 0 || (cmReverse && reverseAllowed) || cmBase;
  const nonReverse = variants.filter((v) => v !== 'reverseHolofoil');
  const primary = primaryVariant(nonReverse.length ? nonReverse : variants);

  for (const v of variants) {
    const source =
      tcgVariants.includes(v) || (v === 'reverseHolofoil' && cmReverse) ? 'market_data'
      : tcgVariants.length ? 'inferred' : isCovered ? 'market_data' : 'inferred';
    variantRows.push([c.id, v, source, v === primary]);
  }

  if (c.tcgplayer?.prices && tcgDate) {
    for (const [k, p] of Object.entries<any>(c.tcgplayer.prices)) {
      if (!p || !isVariant(k) || !variants.includes(k)) continue;
      priceRows.push([c.id, k, 'tcgplayer', 'USD', cents(p.low), cents(p.mid), cents(p.high), cents(p.market), cents(p.directLow), tcgDate, 'pokemontcg']);
      pointRows.push([c.id, k, 'tcgplayer', tcgDate, cents(p.market), cents(p.low)]);
    }
  }
  if (cm && cmDate) {
    const base = tcgVariants.length ? primaryVariant(nonReverse.length ? nonReverse : tcgVariants) : primary;
    if (cmBase && variants.includes(base)) {
      priceRows.push([c.id, base, 'cardmarket', 'EUR', cents(cm.lowPrice), cents(cm.averageSellPrice), cents(cm.avg1), cents(cm.trendPrice ?? cm.averageSellPrice), cents(cm.lowPriceExPlus), cmDate, 'pokemontcg']);
      pointRows.push([c.id, base, 'cardmarket', cmDate, cents(cm.trendPrice), cents(cm.lowPrice)]);
    }
    if (cmReverse && variants.includes('reverseHolofoil')) {
      priceRows.push([c.id, 'reverseHolofoil', 'cardmarket', 'EUR', cents(cm.reverseHoloLow), cents(cm.reverseHoloSell), cents(cm.reverseHoloAvg1), cents(cm.reverseHoloTrend ?? cm.reverseHoloSell), null, cmDate, 'pokemontcg']);
      pointRows.push([c.id, 'reverseHolofoil', 'cardmarket', cmDate, cents(cm.reverseHoloTrend), cents(cm.reverseHoloLow)]);
    }
  }
}

// --- DB target ---------------------------------------------------------------
async function getRun(): Promise<(sql: string) => Promise<any>> {
  if (prod) {
    // @ts-expect-error — .mjs helper has no type declaration; runtime-only.
    const { query } = await import('./https-sql.mjs');
    return (sql: string) => query(sql);
  }
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres' });
  process.on('exit', () => { void pool.end(); });
  return async (sql) => (await pool.query(sql)).rows;
}

async function main() {
  const run = await getRun();
  console.log(`SVP Tranche 1 → ${prod ? 'PRODUCTION' : 'local'}: ${cardRows.length} cards, ${variantRows.length} variants, ${priceRows.length} prices`);

  // Bump the svp set row's counts to the live figures (metadata only; not destructive).
  await run(`update public.sets set total=${lit(setMeta.total)}, printed_total=${lit(printedTotal)}, ptcgo_code=${lit(setMeta.ptcgoCode ?? null)}, synced_at=now() where id='svp'`);

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
