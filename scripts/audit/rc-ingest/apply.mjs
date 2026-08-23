/**
 * Additive, idempotent ingest of the master-reconciliation pass (RC-1 one-offs +
 * clean treatment gaps). Reads manifest.json (produced by the reconciler with a
 * name-match safety guard) and inserts cards / variants / prices with
 * `on conflict do nothing`, so re-running produces zero duplicates. Never edits
 * or deletes an existing row; never touches holdings. Prices are observed
 * TCGplayer market only (else the identity is kept UNVALUED — never borrowed).
 *   node scripts/audit/rc-ingest/apply.mjs --apply
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from '../../deploy/https-sql.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const { cardRows, variantRows, priceRows } = JSON.parse(readFileSync(join(here, 'manifest.json')));
const Q = (s) => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`;
const today = '2026-08-22';
const counts = async () => (await query(`select (select count(*) from public.cards)::int cards,(select count(*) from public.card_variants)::int variants,(select count(*) from public.prices)::int prices,(select coalesce(sum(quantity),0)::int from public.collection_items) hq,(select md5(coalesce(string_agg(user_id::text||card_id||variant||quantity,'|' order by user_id,card_id,variant),'')) from public.collection_items) hhash`))[0];
const before = await counts(); console.log('BEFORE', JSON.stringify(before));
if (process.argv[2] !== '--apply') { console.log(`DRY RUN: ${cardRows.length} cards / ${variantRows.length} variants / ${priceRows.length} prices`); process.exit(0); }
for (const c of cardRows) await query(`insert into public.cards (id,set_id,number,number_sort,number_suffix,name,supertype,subtypes,rarity,artist,hp,types,national_dex,flavor_text,image_small,image_large,is_secret,provider) values (${Q(c.id)},${Q(c.set_id)},${Q(c.number ?? 'N')},${c.number_sort},'',${Q(c.name)},${Q(c.supertype)},'[]'::jsonb,${Q(c.rarity)},null,null,'[]'::jsonb,'[]'::jsonb,null,${Q(c.image)},${Q(c.image)},false,${Q(c.provider)}) on conflict (id) do nothing`);
for (const v of variantRows) await query(`insert into public.card_variants (card_id,variant,source,is_primary,edition,finish,treatment,language,needs_resolution) values (${Q(v.card_id)},${Q(v.variant)},'market_data',${v.is_primary},null,${Q(v.finish)},${Q(v.treatment)},'EN',false) on conflict (card_id,variant) do nothing`);
for (const p of priceRows) await query(`insert into public.prices (card_id,variant,provider,currency,low_cents,mid_cents,high_cents,market_cents,direct_cents,observed_on,source,provider_product_id) values (${Q(p.card_id)},${Q(p.variant)},'tcgplayer','USD',null,null,null,${p.market_cents},null,'${today}','tcgcsv',${Q(String(p.productId))}) on conflict (card_id,variant,provider) do nothing`);
const after = await counts(); console.log('AFTER ', JSON.stringify(after));
console.log('holdings unchanged:', before.hq === after.hq && before.hhash === after.hhash ? 'YES' : 'NO');
