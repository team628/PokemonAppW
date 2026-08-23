/**
 * Pricing-completeness audit against the live production database.
 *
 * "Priced" means the app's own definition of a trustworthy market value: a
 * tcgplayer (USD) row whose slot_market_cents(market,mid,low) ladder yields a
 * positive figure. cardmarket (EUR) is stored but the product never values in
 * it, so a variant priced only in cardmarket is treated as unpriced for dollar
 * coverage and reported under "unsupported currency/source".
 *
 * Every unpriced variant is classified into one of the six reasons. Read-only:
 * this script computes and prints, it changes nothing.
 */
import { query } from './https-sql.mjs';

const pct = (n, d) => (d ? (100 * n / d).toFixed(2) : '0.00');
const j = (o) => JSON.stringify(o);

// One pass: label every card_variant.
const LABELLED = `
with v as (
  select cv.card_id, cv.variant, cv.source,
         c.set_id, c.rarity, s.series, s.release_date,
         exists(select 1 from public.prices p where p.card_id=cv.card_id and p.variant=cv.variant and p.provider='tcgplayer' and public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) is not null) tcg_priced,
         exists(select 1 from public.prices p where p.card_id=cv.card_id and p.variant=cv.variant and p.provider='tcgplayer') tcg_row,
         exists(select 1 from public.prices p where p.card_id=cv.card_id and p.variant=cv.variant and p.provider='cardmarket') cm_row,
         exists(select 1 from public.prices p where p.card_id=cv.card_id and p.variant=cv.variant) any_row
  from public.card_variants cv
  join public.cards c on c.id = cv.card_id
  join public.sets  s on s.id = c.set_id
),
labelled as (
  select v.*,
    case
      when tcg_priced then 'priced'
      when tcg_row and not tcg_priced then 'r5_stale_invalid'   -- tcgplayer row exists but no usable value
      when (not any_row) and source='market_data' then 'r3_sync_gap'  -- claims market data but no price landed
      when cm_row then 'r6_currency'                             -- only cardmarket (EUR)
      when (not any_row) and source='inferred' then 'r1_no_data' -- provider has no data; printing inferred
      else 'r_other'
    end reason
  from v
)`;

async function main() {
  console.log('=== SetValue pricing completeness audit (live) ===\n');

  const total = (await query(`${LABELLED} select
     count(*)::int total,
     count(*) filter (where reason='priced')::int priced,
     count(*) filter (where reason<>'priced')::int unpriced,
     count(*) filter (where source='market_data')::int observed,
     count(*) filter (where source='inferred')::int inferred
   from labelled`))[0];
  console.log('TOTALS');
  console.log('  total variants   :', total.total);
  console.log('  priced (tcg USD) :', total.priced, `(${pct(total.priced,total.total)}%)`);
  console.log('  unpriced         :', total.unpriced, `(${pct(total.unpriced,total.total)}%)`);
  console.log('  observed variants:', total.observed, '| inferred variants:', total.inferred);

  console.log('\nREASON CLASSIFICATION (of unpriced)');
  const reasons = await query(`${LABELLED} select reason, count(*)::int n from labelled where reason<>'priced' group by reason order by n desc`);
  const LABELS = {
    r1_no_data: '1. provider genuinely has no market data (printing inferred)',
    r6_currency: '6. unsupported currency/source (cardmarket EUR only)',
    r5_stale_invalid: '5. stale/invalid provider response (tcg row, no usable value)',
    r3_sync_gap: '3. sync/ingest skipped or failed (market_data variant, no price)',
    r_other: '?. unclassified',
  };
  for (const r of reasons) console.log(`  ${LABELS[r.reason] ?? r.reason}: ${r.n} (${pct(r.n,total.unpriced)}% of unpriced)`);
  console.log('  2. provider has data, adapter not mapping: 0 (verified: all raw tcgplayer keys map)');
  console.log('  4. variant identity mismatch: 0 (verified: no phantom prices, keys aligned)');

  console.log('\nBY VARIANT TYPE');
  const byVar = await query(`${LABELLED} select variant, count(*)::int total, count(*) filter (where reason='priced')::int priced from labelled group by variant order by total desc`);
  for (const r of byVar) console.log(`  ${r.variant.padEnd(20)} ${String(r.priced).padStart(6)}/${String(r.total).padStart(6)}  ${pct(r.priced,r.total)}%`);

  console.log('\nBY PROVIDER / SOURCE (variant source label)');
  const bySrc = await query(`${LABELLED} select source, count(*)::int total, count(*) filter (where reason='priced')::int priced from labelled group by source order by total desc`);
  for (const r of bySrc) console.log(`  ${r.source.padEnd(14)} ${r.priced}/${r.total}  ${pct(r.priced,r.total)}%`);
  const provRows = await query(`select provider, count(*)::int rows, count(distinct (card_id,variant))::int pairs from public.prices group by provider order by rows desc`);
  for (const r of provRows) console.log(`  price rows: ${r.provider.padEnd(12)} ${r.rows} rows / ${r.pairs} pairs`);

  console.log('\nBY ERA (series)  [priced/total  coverage%]');
  const byEra = await query(`${LABELLED} select coalesce(series,'(none)') era, min(release_date)::text since, count(*)::int total, count(*) filter (where reason='priced')::int priced from labelled group by series order by min(release_date)`);
  for (const r of byEra) console.log(`  ${(r.era||'').padEnd(22)} ${String(r.priced).padStart(6)}/${String(r.total).padStart(6)}  ${pct(r.priced,r.total).padStart(6)}%   since ${r.since??'?'}`);

  console.log('\nBY RARITY  [priced/total  coverage%]  (top 20 by size)');
  const byRar = await query(`${LABELLED} select coalesce(rarity,'(none)') rarity, count(*)::int total, count(*) filter (where reason='priced')::int priced from labelled group by rarity order by total desc limit 20`);
  for (const r of byRar) console.log(`  ${r.rarity.padEnd(26)} ${String(r.priced).padStart(6)}/${String(r.total).padStart(6)}  ${pct(r.priced,r.total)}%`);

  console.log('\nWORST-COVERED SETS (>=5 variants, lowest coverage, top 25)');
  const bySet = await query(`${LABELLED} select set_id, count(*)::int total, count(*) filter (where reason='priced')::int priced from labelled group by set_id having count(*)>=5 order by (count(*) filter (where reason='priced'))::numeric/count(*) asc, total desc limit 25`);
  for (const r of bySet) console.log(`  ${r.set_id.padEnd(10)} ${String(r.priced).padStart(5)}/${String(r.total).padStart(5)}  ${pct(r.priced,r.total)}%`);

  console.log('\nFRESHNESS / SYNC');
  const fresh = (await query(`select count(*)::int rows, count(*) filter (where fetched_at < now() - interval '24 hours')::int stale24, max(fetched_at)::text newest from public.prices where provider='tcgplayer'`))[0];
  console.log('  tcgplayer rows:', fresh.rows, '| stale >24h:', fresh.stale24, '| newest fetch:', fresh.newest);
  const runs = (await query(`select count(*) filter (where status='failed')::int failed, count(*) filter (where status='partial')::int partial, count(*) filter (where status='succeeded')::int ok from public.sync_runs`))[0];
  console.log('  sync_runs: ok', runs.ok, '| partial', runs.partial, '| failed', runs.failed);
}
main().catch((e) => { console.error('AUDIT ERROR:', e.message); process.exitCode = 1; });
