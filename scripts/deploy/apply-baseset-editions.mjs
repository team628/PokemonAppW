/**
 * Apply emitted price observations to the database: create the edition-level
 * card_variants, write the rich price_observations, and set the resolved
 * current price (public.prices) + legacy history (public.price_points) for each
 * — all idempotent, all provenance-preserving.
 *
 *   node scripts/deploy/apply-baseset-editions.mjs /tmp/obs.json            # local (DATABASE_URL)
 *   node scripts/deploy/apply-baseset-editions.mjs /tmp/obs.json --prod     # production (HTTPS)
 *
 * Never fabricates or moves a price across identities. Flags the owner's
 * ambiguous Base Set records (edition unspecified + owned) for manual
 * resolution rather than guessing.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const prod = process.argv.includes('--prod');
if (!file) throw new Error('usage: apply-baseset-editions.mjs <obs.json> [--prod]');

const { observations } = JSON.parse(readFileSync(file, 'utf8'));

// --- DB target -------------------------------------------------------------
let run;
if (prod) {
  const { query } = await import('./https-sql.mjs');
  run = (sql) => query(sql);
} else {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres' });
  run = async (sql) => (await pool.query(sql)).rows;
  process.on('exit', () => pool.end());
}

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
  : `'${String(v).replace(/'/g, "''")}'`;
const row = (vals) => '(' + vals.map(lit).join(',') + ')';

const today = new Date().toISOString().slice(0, 10);

async function main() {
  console.log(`applying ${observations.length} observations to ${prod ? 'PRODUCTION' : 'local'} DB`);

  // 1. card_variants (edition identities; non-primary; carry edition/finish)
  const cvRows = new Map();
  for (const o of observations) cvRows.set(`${o.cardId}|${o.variant}`, [o.cardId, o.variant, 'market_data', false, o.edition, o.finish, false]);
  await run(`insert into public.card_variants (card_id, variant, source, is_primary, edition, finish, needs_resolution)
    values ${[...cvRows.values()].map(row).join(',')}
    on conflict (card_id, variant) do update set source=excluded.source, edition=excluded.edition, finish=excluded.finish`);

  // 2. price_observations (the rich store of record)
  const obsRows = observations.map((o) => row([
    o.provider, o.source, o.providerProductId, o.cardId, o.setId, o.variant, o.edition, o.finish,
    o.condition, o.gradingCompany, o.grade, o.language, o.region, o.currency, o.observationType,
    o.valueCents, o.valueUsdCents, o.fxSource, o.lowCents, o.midCents, o.highCents, o.observedAt,
  ]));
  await run(`insert into public.price_observations
    (provider, source, provider_product_id, card_id, set_id, variant, edition, finish,
     condition, grading_company, grade, language, region, currency, observation_type,
     value_cents, value_usd_cents, fx_source, low_cents, mid_cents, high_cents, observed_at)
    values ${obsRows.join(',')}
    on conflict (provider, identity_key, observed_at) do update set
      value_cents=excluded.value_cents, value_usd_cents=excluded.value_usd_cents,
      low_cents=excluded.low_cents, mid_cents=excluded.mid_cents, high_cents=excluded.high_cents,
      fetched_at=now()`);

  // 3. public.prices — resolved current price the app reads. provider stays the
  //    marketplace label (tcgplayer); source records the access channel (tcgcsv).
  const priceRows = observations.map((o) => row([
    o.cardId, o.variant, 'tcgplayer', 'USD', o.lowCents, o.midCents, o.highCents, o.valueCents, null, today, 'tcgcsv', o.providerProductId,
  ]));
  await run(`insert into public.prices
    (card_id, variant, provider, currency, low_cents, mid_cents, high_cents, market_cents, direct_cents, observed_on, source, provider_product_id)
    values ${priceRows.join(',')}
    on conflict (card_id, variant, provider) do update set
      currency=excluded.currency, low_cents=excluded.low_cents, mid_cents=excluded.mid_cents,
      high_cents=excluded.high_cents, market_cents=excluded.market_cents, observed_on=excluded.observed_on,
      source=excluded.source, provider_product_id=excluded.provider_product_id, fetched_at=now()`);

  // 4. legacy per-variant history so trends work for these identities too
  const ppRows = observations.map((o) => row([o.cardId, o.variant, 'tcgplayer', today, o.valueCents, o.lowCents]));
  await run(`insert into public.price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
    values ${ppRows.join(',')}
    on conflict (card_id, variant, provider, observed_on) do update set
      market_cents=excluded.market_cents, low_cents=excluded.low_cents`);

  // 5. Flag the owner's ambiguous legacy Base Set records (edition unspecified +
  //    owned) for MANUAL resolution — never auto-assigned to an edition.
  const flagged = await run(`update public.card_variants cv set needs_resolution=true
    from public.cards c
    where cv.card_id=c.id and c.set_id='base1' and cv.edition is null
      and exists (select 1 from public.collection_items ci where ci.card_id=cv.card_id and ci.variant=cv.variant)
    returning cv.card_id, cv.variant`);
  console.log('flagged for manual edition resolution:', JSON.stringify(flagged));

  const byVar = {};
  for (const o of observations) byVar[o.variant] = (byVar[o.variant] || 0) + 1;
  console.log('edition prices written by variant:', JSON.stringify(byVar));
  console.log('done.');
}
main().catch((e) => { console.error('APPLY ERROR:', e.message); process.exit(1); });
