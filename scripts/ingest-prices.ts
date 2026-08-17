/**
 * Loads market prices into SQLite and derives the variant table.
 *
 * Sources (both via api.pokemontcg.io, which republishes them):
 *   - TCGplayer  (USD) — per-printing low/mid/high/market/directLow
 *   - Cardmarket (EUR) — trend/average/low, plus separate reverse-holo figures
 *
 * Two rules keep this honest:
 *   1. A printing exists in `card_variants` with source='market_data' only if a
 *      provider actually quoted that printing. Everything else is 'inferred'.
 *   2. Nothing is written without the provider's own `updatedAt` date, so the
 *      app can always show how old a number is.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from '../src/lib/db/index';
import {
  inferVariants,
  isVariant,
  primaryVariant,
  reverseHoloEraAllows,
  type Variant,
} from '../src/lib/catalog/variants';

interface TcgPrices {
  low: number | null;
  mid: number | null;
  high: number | null;
  market: number | null;
  directLow: number | null;
}
interface RawPriceCard {
  id: string;
  tcgplayer?: { updatedAt?: string; prices?: Record<string, TcgPrices | null> };
  cardmarket?: { updatedAt?: string; prices?: Record<string, number | null> };
}

const cents = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100);

/** '2026/08/17' -> '2026-08-17' */
const toIsoDate = (d: string | undefined): string | null =>
  d ? d.slice(0, 10).replace(/\//g, '-') : null;

const RAW = path.join(process.cwd(), 'data', 'raw', 'prices');

function main() {
  if (!existsSync(RAW)) {
    console.error(`no price data at ${RAW} — run scripts/fetch-prices.mjs first`);
    process.exit(1);
  }
  const db = openDb();
  const started = nowIso();
  const fetchedAt = nowIso();

  const insVariant = db.prepare(
    `INSERT INTO card_variants (card_id, variant, source, is_primary) VALUES (?, ?, ?, ?)
     ON CONFLICT(card_id, variant) DO UPDATE SET source=excluded.source, is_primary=excluded.is_primary`,
  );
  const insPrice = db.prepare(`
    INSERT INTO prices (card_id, variant, provider, currency, low_cents, mid_cents, high_cents,
                        market_cents, direct_cents, observed_on, fetched_at)
    VALUES (@card_id, @variant, @provider, @currency, @low, @mid, @high, @market, @direct, @observed_on, @fetched_at)
    ON CONFLICT(card_id, variant, provider) DO UPDATE SET
      low_cents=excluded.low_cents, mid_cents=excluded.mid_cents, high_cents=excluded.high_cents,
      market_cents=excluded.market_cents, direct_cents=excluded.direct_cents,
      observed_on=excluded.observed_on, fetched_at=excluded.fetched_at`);
  const insPoint = db.prepare(`
    INSERT INTO price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, variant, provider, observed_on) DO UPDATE SET
      market_cents=excluded.market_cents, low_cents=excluded.low_cents`);

  const allCards = db
    .prepare(
      `SELECT c.id, c.set_id, c.rarity, s.release_date
       FROM cards c JOIN sets s ON s.id = c.set_id`,
    )
    .all() as { id: string; set_id: string; rarity: string | null; release_date: string | null }[];
  const cardMeta = new Map(allCards.map((c) => [c.id, c]));

  const withMarketData = new Set<string>();
  let priceRows = 0;
  let anachronisticReverse = 0;

  const run = db.transaction(() => {
    for (const file of readdirSync(RAW)) {
      if (!file.endsWith('.json')) continue;
      const rows: RawPriceCard[] = JSON.parse(readFileSync(path.join(RAW, file), 'utf8'));

      for (const r of rows) {
        const meta = cardMeta.get(r.id);
        if (!meta) continue;

        // Which printings could physically exist for this card, from the set's
        // era and the card's rarity. Used both as a fallback and as a veto.
        const plausible = inferVariants({
          rarity: meta.rarity,
          setId: meta.set_id,
          setReleaseDate: meta.release_date,
        });
        // The era gate is the only thing allowed to overrule a provider: it is
        // a historical fact. Whether a particular holo rare also had a reverse
        // holo printing varies set by set, and there the provider knows better
        // than any rule we could write.
        const reverseAllowed = reverseHoloEraAllows(meta.set_id, meta.release_date);
        const inReverseEra = (v: Variant) => v !== 'reverseHolofoil' || reverseAllowed;

        // --- Step 1: decide the printings -----------------------------------
        const tcgDate = toIsoDate(r.tcgplayer?.updatedAt);
        const tcgVariants: Variant[] = [];
        if (r.tcgplayer?.prices && tcgDate) {
          for (const [k, p] of Object.entries(r.tcgplayer.prices)) {
            if (!p || !isVariant(k)) continue;
            if (!inReverseEra(k)) { anachronisticReverse++; continue; }
            tcgVariants.push(k);
          }
        }

        const cm = r.cardmarket?.prices;
        const cmDate = toIsoDate(r.cardmarket?.updatedAt);
        const cmHasReverse = !!cm && !!(cm.reverseHoloTrend || cm.reverseHoloSell || cm.reverseHoloLow);
        const cmHasBase = !!cm && !!(cm.trendPrice || cm.averageSellPrice || cm.lowPrice);

        // A card is only "covered" by market data if a provider names a
        // printing we accept. Otherwise it falls back to the inferred set —
        // which is what stops a Cardmarket reverse-holo figure from leaving a
        // Diamond & Pearl common with a reverse holo as its only printing.
        const variants: Variant[] = [...tcgVariants];
        if (!variants.length) variants.push(...plausible);
        if (cmHasReverse && reverseAllowed && !variants.includes('reverseHolofoil')) {
          variants.push('reverseHolofoil');
        }

        const covered = tcgVariants.length > 0 || (cmHasReverse && reverseAllowed) || cmHasBase;
        const source = tcgVariants.length ? 'market_data' : covered ? 'market_data' : 'inferred';
        const nonReverse = variants.filter((v) => v !== 'reverseHolofoil');
        const primary = primaryVariant(nonReverse.length ? nonReverse : variants);

        for (const v of variants) {
          // Printings only a rarity rule proposed stay labelled as inferred,
          // even on a card a provider otherwise covers.
          const vSource = tcgVariants.includes(v) || (v === 'reverseHolofoil' && cmHasReverse)
            ? source
            : tcgVariants.length ? 'inferred' : source;
          insVariant.run(r.id, v, vSource, v === primary ? 1 : 0);
        }
        if (covered) withMarketData.add(r.id);

        // --- Step 2: attach prices, only to printings that exist -------------
        if (r.tcgplayer?.prices && tcgDate) {
          for (const [k, p] of Object.entries(r.tcgplayer.prices)) {
            if (!p || !isVariant(k) || !variants.includes(k)) continue;
            insPrice.run({
              card_id: r.id, variant: k, provider: 'tcgplayer', currency: 'USD',
              low: cents(p.low), mid: cents(p.mid), high: cents(p.high),
              market: cents(p.market), direct: cents(p.directLow),
              observed_on: tcgDate, fetched_at: fetchedAt,
            });
            insPoint.run(r.id, k, 'tcgplayer', tcgDate, cents(p.market), cents(p.low));
            priceRows++;
          }
        }

        if (cm && cmDate) {
          // Cardmarket quotes the base printing without naming it, so it binds
          // to whichever printing this card's base actually is.
          const base = tcgVariants.length
            ? primaryVariant(tcgVariants.filter((v) => v !== 'reverseHolofoil').length
                ? tcgVariants.filter((v) => v !== 'reverseHolofoil')
                : tcgVariants)
            : primary;

          if (cmHasBase && variants.includes(base)) {
            insPrice.run({
              card_id: r.id, variant: base, provider: 'cardmarket', currency: 'EUR',
              low: cents(cm.lowPrice), mid: cents(cm.averageSellPrice), high: cents(cm.avg1),
              market: cents(cm.trendPrice ?? cm.averageSellPrice), direct: cents(cm.lowPriceExPlus),
              observed_on: cmDate, fetched_at: fetchedAt,
            });
            insPoint.run(r.id, base, 'cardmarket', cmDate, cents(cm.trendPrice), cents(cm.lowPrice));
            priceRows++;
          }

          if (cmHasReverse && variants.includes('reverseHolofoil')) {
            insPrice.run({
              card_id: r.id, variant: 'reverseHolofoil', provider: 'cardmarket', currency: 'EUR',
              low: cents(cm.reverseHoloLow), mid: cents(cm.reverseHoloSell), high: cents(cm.reverseHoloAvg1),
              market: cents(cm.reverseHoloTrend ?? cm.reverseHoloSell), direct: null,
              observed_on: cmDate, fetched_at: fetchedAt,
            });
            insPoint.run(
              r.id, 'reverseHolofoil', 'cardmarket', cmDate,
              cents(cm.reverseHoloTrend), cents(cm.reverseHoloLow),
            );
            priceRows++;
          }
        }
      }
    }

    // --- Cards no provider covers: fall back to era + rarity rules ----------
    let inferred = 0;
    for (const c of allCards) {
      if (withMarketData.has(c.id)) continue;
      const vs = inferVariants({
        rarity: c.rarity,
        setId: c.set_id,
        setReleaseDate: c.release_date,
      });
      const primary = primaryVariant(vs);
      for (const v of vs) insVariant.run(c.id, v, 'inferred', v === primary ? 1 : 0);
      inferred++;
    }
    console.log(`variants: ${withMarketData.size} from market data, ${inferred} inferred`);
  });

  run();

  db.prepare(
    `INSERT INTO ingest_runs (kind, source, started_at, finished_at, rows, notes)
     VALUES ('prices', 'api.pokemontcg.io (TCGplayer + Cardmarket)', ?, ?, ?, ?)`,
  ).run(started, nowIso(), priceRows, `${readdirSync(RAW).length} set files`);

  console.log(`prices: ${priceRows} rows`);
  console.log(`rejected ${anachronisticReverse} reverse-holo listings on sets predating reverse holos`);
  db.close();
}

main();
