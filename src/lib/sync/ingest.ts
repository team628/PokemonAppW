/**
 * Catalog and price ingest, independent of where it runs.
 *
 * The same code backs three callers: the `npm run ingest:*` scripts, CI (which
 * runs those scripts on every pull request), and the two Supabase Edge
 * Functions the scheduler invokes. That is deliberate. Variant inference, the
 * reverse-holo era rules and price normalisation decide which printings exist
 * and what a collection is worth; a second implementation of them in another
 * runtime is where quiet pricing bugs would live.
 *
 * So the database is injected rather than imported. A caller supplies something
 * that can run parameterised SQL — `pg` in Node, a Deno Postgres client in an
 * Edge Function — and everything above that line is shared.
 *
 * Writes require `service_role`; it is the only role permitted to write the
 * catalog. Inserts are batched rather than row-at-a-time because the full
 * catalog is ~20k cards and ~35k printings.
 */
import { activeProvider } from '../providers/pokemontcg';
import type { ProviderSet } from '../providers/types';
import {
  inferVariants,
  isVariant,
  primaryVariant,
  reverseHoloEraAllows,
  type Variant,
} from '../catalog/variants';

const provider = activeProvider();

/**
 * The slice of a database handle this needs. Deliberately smaller than any one
 * client's surface, so a Deno Postgres client satisfies it as readily as `pg`.
 */
export interface SyncTx {
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  one<T>(sql: string, params?: readonly unknown[]): Promise<T | null | undefined>;
  rows<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Where progress goes. Console in a script, structured log in a function. */
export type Log = (message: string) => void;

/** Bounds a run to part of the catalog, for the incremental hourly refresh. */
export interface Scope {
  /** Only these sets. Omitted means the whole catalog. */
  setIds?: string[];
  log?: Log;
}

const cents = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100);

const isoDate = (d: string | undefined | null): string | null =>
  d ? d.slice(0, 10).replace(/\//g, '-') : null;

/**
 * Batched multi-row insert; keeps parameter counts under Postgres' 65535 cap.
 *
 * `keyColumns` names the conflict target. Rows are de-duplicated on it before
 * sending, because ON CONFLICT DO UPDATE refuses to touch the same row twice in
 * one statement — and the provider legitimately yields two quotes for one
 * printing (a base figure and a reverse-holo figure for the same card).
 * Last write wins, matching the row-at-a-time behaviour it replaces.
 */
async function insertBatch(
  tx: SyncTx,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
  keyColumns: string[] = [],
): Promise<number> {
  if (!rows.length) return 0;

  if (keyColumns.length) {
    const idx = keyColumns.map((k) => columns.indexOf(k));
    const seen = new Map<string, unknown[]>();
    for (const r of rows) seen.set(idx.map((i) => String(r[i])).join('\u0000'), r);
    rows = [...seen.values()];
  }
  const perRow = columns.length;
  // The default keeps each statement under PostgreSQL's 65535-parameter cap.
  // A transport that inlines values instead of binding them — the HTTPS query
  // endpoint used for deployment, where there is no parameter cap but there is
  // a request-body size limit — sets SETVALUE_INGEST_BATCH_ROWS to a smaller
  // number so each statement stays inside that limit. Row-for-row output is
  // identical either way; only how many rows share one INSERT changes.
  const cap = Number(
    (typeof process !== 'undefined' && process.env?.SETVALUE_INGEST_BATCH_ROWS) || 0,
  );
  const maxRows =
    cap > 0 ? Math.max(1, cap) : Math.max(1, Math.floor(60_000 / perRow));
  let written = 0;

  for (let i = 0; i < rows.length; i += maxRows) {
    const slice = rows.slice(i, i + maxRows);
    const values = slice
      .map(
        (_, r) =>
          `(${columns.map((__, c) => `$${r * perRow + c + 1}`).join(',')})`,
      )
      .join(',');
    written += await tx.exec(
      `insert into ${table} (${columns.join(',')}) values ${values} ${conflict}`,
      slice.flat(),
    );
  }
  return written;
}

export function parseNumber(raw: string): { n: number; suffix: string } {
  const m = raw.match(/^([A-Za-z]*)(\d+)(.*)$/);
  if (!m) return { n: 999999, suffix: raw };
  const prefix = m[1] ?? '';
  const n = parseInt(m[2]!, 10);
  const tail = (m[3] ?? '').trim();
  const offset = prefix ? 100000 + prefix.charCodeAt(0) * 100 : 0;
  return { n: n + offset, suffix: tail };
}

export async function ingestCatalog(tx: SyncTx, scope: Scope = {}): Promise<void> {
  const log = scope.log ?? (() => {});
  const all: ProviderSet[] = await provider.listSets();
  const sets = scope.setIds ? all.filter((s) => scope.setIds!.includes(s.id)) : all;
  log(`sets: ${sets.length}${scope.setIds ? ` of ${all.length}` : ''}`);

  {
    const runId = (
      await tx.one<{ id: number }>(`select public.start_sync_run('nightly_catalog', $1) as id`, [
        provider.id,
      ])
    )!.id;

    await insertBatch(
      tx,
      'public.sets',
      ['id', 'name', 'series', 'printed_total', 'total', 'ptcgo_code', 'release_date', 'symbol_url', 'logo_url', 'provider'],
      sets.map((s) => [
        s.id, s.name, s.series, s.printedTotal, s.total, s.ptcgoCode,
        isoDate(s.releaseDate), s.symbolUrl, s.logoUrl, provider.id,
      ]),
      `on conflict (id) do update set
         name = excluded.name, series = excluded.series,
         printed_total = excluded.printed_total, total = excluded.total,
         ptcgo_code = excluded.ptcgo_code, release_date = excluded.release_date,
         symbol_url = excluded.symbol_url, logo_url = excluded.logo_url,
         synced_at = now()`,
      ['id'],
    );

    let cardCount = 0;
    for (const set of sets) {
      const cards = await provider.listCards(set.id);
      if (!cards.length) continue;
      const rows = cards.map((c) => {
        const { n, suffix } = parseNumber(c.number);
        return [
          c.id, set.id, c.number, n, suffix, c.name, c.supertype,
          JSON.stringify(c.subtypes ?? []), c.rarity, c.artist, c.hp,
          JSON.stringify(c.types ?? []), JSON.stringify(c.nationalPokedexNumbers ?? []),
          c.flavorText, c.imageSmall, c.imageLarge,
          n > set.printedTotal && n < 100000, provider.id,
        ];
      });
      cardCount += await insertBatch(
        tx,
        'public.cards',
        ['id','set_id','number','number_sort','number_suffix','name','supertype','subtypes','rarity','artist','hp','types','national_dex','flavor_text','image_small','image_large','is_secret','provider'],
        rows,
        `on conflict (id) do update set
           name = excluded.name, number = excluded.number, number_sort = excluded.number_sort,
           number_suffix = excluded.number_suffix, rarity = excluded.rarity,
           artist = excluded.artist, image_small = excluded.image_small,
           image_large = excluded.image_large, is_secret = excluded.is_secret,
           synced_at = now()`,
        ['id'],
      );
    }

    await tx.exec(`select public.finish_sync_run($1, 'succeeded', $2, $3, 0, $4)`, [
      runId, cardCount, sets.length, `${sets.length} sets, ${cardCount} cards`,
    ]);
    log(`cards: ${cardCount}`);
  }
}

/**
 * The (edition, finish) identity axes for a base variant token, derived exactly
 * as migration 0017's backfill does (`ilike` order preserved): a lossless
 * relabel of the token, never a price or catalog change. Keeps a fresh ingest's
 * card_variants rows unique under migration 0021's identity index instead of
 * collapsing every finish of a card to the same null-null identity.
 */
function identityAxes(variant: string): { finish: string; edition: string | null } {
  const v = variant.toLowerCase();
  const finish = v.includes('reverseholofoil')
    ? 'Reverse Holofoil'
    : v.includes('holofoil')
      ? 'Holofoil'
      : 'Normal';
  const edition = v.startsWith('1stedition')
    ? '1st Edition'
    : v.startsWith('unlimited')
      ? 'Unlimited'
      : v.startsWith('shadowless')
        ? 'Shadowless'
        : null;
  return { finish, edition };
}

export async function ingestPrices(tx: SyncTx, scope: Scope = {}): Promise<void> {
  const log = scope.log ?? (() => {});
  const all: ProviderSet[] = await provider.listSets();
  // Every set's metadata stays in scope even for a partial run: the era rules
  // that decide whether a reverse holo could exist are read per card, and a
  // card in a synced set can belong to a set outside the slice only if the
  // catalog is inconsistent — but reading it from the full list costs nothing
  // and removes the question.
  const setMeta = new Map(all.map((s) => [s.id, s]));
  const sets = scope.setIds ? all.filter((s) => scope.setIds!.includes(s.id)) : all;
  log(`pricing ${sets.length}${scope.setIds ? ` of ${all.length}` : ''} sets`);

  {
    const runId = (
      await tx.one<{ id: number }>(`select public.start_sync_run('hourly_prices', $1) as id`, [
        provider.id,
      ])
    )!.id;

    // Scoped to the sets in this run. Without that, a partial run's fallback
    // below would relabel every card in the catalog it did not price as
    // `inferred` — silently discarding real market data for 170 other sets.
    const cardMeta = new Map(
      (
        await tx.rows<{ id: string; set_id: string; rarity: string | null; release_date: string | null }>(
          `select c.id, c.set_id, c.rarity, s.release_date::text
           from public.cards c join public.sets s on s.id = c.set_id
           where $1::text[] is null or c.set_id = any($1::text[])`,
          [scope.setIds ?? null],
        )
      ).map((c) => [c.id, c]),
    );

    const variantRows: unknown[][] = [];
    const priceRows: unknown[][] = [];
    const pointRows: unknown[][] = [];
    const covered = new Set<string>();
    let rejectedReverse = 0;

    // A provider failing on one set must not discard the other 173. This is a
    // single transaction, so an uncaught throw here rolls back every set that
    // did work — and the upstream API does persistently 500 on some sets.
    // Failures are collected, the run is finished as `partial`, and the cards
    // in a failed set fall through to the era+rarity inference below, where
    // they are labelled `inferred` rather than pretending to be market data.
    const failedSets: string[] = [];

    for (const set of sets) {
      let quotes: Awaited<ReturnType<typeof provider.listPrices>>;
      try {
        quotes = await provider.listPrices(set.id);
      } catch (e) {
        failedSets.push(`${set.id}:${(e as Error).message.slice(0, 80)}`);
        continue;
      }
      for (const q of quotes) {
        const meta = cardMeta.get(q.cardId);
        if (!meta) continue;

        const plausible = inferVariants({
          rarity: meta.rarity,
          setId: meta.set_id,
          setReleaseDate: setMeta.get(meta.set_id)?.releaseDate ?? null,
        });
        const reverseAllowed = reverseHoloEraAllows(
          meta.set_id,
          setMeta.get(meta.set_id)?.releaseDate ?? null,
        );

        const tcgDate = isoDate(q.tcgplayer?.updatedAt);
        const tcgVariants: Variant[] = [];
        if (q.tcgplayer?.prices && tcgDate) {
          for (const [k, p] of Object.entries(q.tcgplayer.prices)) {
            if (!p || !isVariant(k)) continue;
            if (k === 'reverseHolofoil' && !reverseAllowed) { rejectedReverse++; continue; }
            tcgVariants.push(k);
          }
        }

        const cm = q.cardmarket?.prices;
        const cmDate = isoDate(q.cardmarket?.updatedAt);
        const cmReverse = !!cm && !!(cm.reverseHoloTrend || cm.reverseHoloSell || cm.reverseHoloLow);
        const cmBase = !!cm && !!(cm.trendPrice || cm.averageSellPrice || cm.lowPrice);

        const variants: Variant[] = [...tcgVariants];
        if (!variants.length) variants.push(...plausible);
        if (cmReverse && reverseAllowed && !variants.includes('reverseHolofoil')) {
          variants.push('reverseHolofoil');
        }
        const isCovered = tcgVariants.length > 0 || (cmReverse && reverseAllowed) || cmBase;
        if (isCovered) covered.add(q.cardId);

        const nonReverse = variants.filter((v) => v !== 'reverseHolofoil');
        const primary = primaryVariant(nonReverse.length ? nonReverse : variants);

        for (const v of variants) {
          const source =
            tcgVariants.includes(v) || (v === 'reverseHolofoil' && cmReverse)
              ? 'market_data'
              : tcgVariants.length ? 'inferred' : isCovered ? 'market_data' : 'inferred';
          const { finish, edition } = identityAxes(v);
          variantRows.push([q.cardId, v, source, v === primary, finish, edition]);
        }

        if (q.tcgplayer?.prices && tcgDate) {
          for (const [k, p] of Object.entries(q.tcgplayer.prices)) {
            if (!p || !isVariant(k) || !variants.includes(k)) continue;
            priceRows.push([q.cardId, k, 'tcgplayer', 'USD', cents(p.low), cents(p.mid), cents(p.high), cents(p.market), cents(p.directLow), tcgDate]);
            pointRows.push([q.cardId, k, 'tcgplayer', tcgDate, cents(p.market), cents(p.low)]);
          }
        }

        if (cm && cmDate) {
          const base = tcgVariants.length
            ? primaryVariant(nonReverse.length ? nonReverse : tcgVariants)
            : primary;
          if (cmBase && variants.includes(base)) {
            priceRows.push([q.cardId, base, 'cardmarket', 'EUR', cents(cm.lowPrice), cents(cm.averageSellPrice), cents(cm.avg1), cents(cm.trendPrice ?? cm.averageSellPrice), cents(cm.lowPriceExPlus), cmDate]);
            pointRows.push([q.cardId, base, 'cardmarket', cmDate, cents(cm.trendPrice), cents(cm.lowPrice)]);
          }
          if (cmReverse && variants.includes('reverseHolofoil')) {
            priceRows.push([q.cardId, 'reverseHolofoil', 'cardmarket', 'EUR', cents(cm.reverseHoloLow), cents(cm.reverseHoloSell), cents(cm.reverseHoloAvg1), cents(cm.reverseHoloTrend ?? cm.reverseHoloSell), null, cmDate]);
            pointRows.push([q.cardId, 'reverseHolofoil', 'cardmarket', cmDate, cents(cm.reverseHoloTrend), cents(cm.reverseHoloLow)]);
          }
        }
      }
    }

    // Cards no provider covers fall back to era + rarity rules, labelled.
    let inferredCards = 0;
    for (const [id, meta] of cardMeta) {
      if (covered.has(id)) continue;
      const vs = inferVariants({
        rarity: meta.rarity,
        setId: meta.set_id,
        setReleaseDate: setMeta.get(meta.set_id)?.releaseDate ?? null,
      });
      const primary = primaryVariant(vs);
      for (const v of vs) {
        const { finish, edition } = identityAxes(v);
        variantRows.push([id, v, 'inferred', v === primary, finish, edition]);
      }
      inferredCards++;
    }

    // finish + edition are set on insert so each token maps to a distinct
    // (card_id, edition, finish, treatment, language) identity — the uniqueness
    // migration 0021 enforces. Without them a fresh ingest would give every
    // finish variant of a card the same null-null identity and collide. They are
    // NOT overwritten on conflict: an existing row keeps whatever it was labelled.
    await insertBatch(tx, 'public.card_variants',
      ['card_id', 'variant', 'source', 'is_primary', 'finish', 'edition'], variantRows,
      `on conflict (card_id, variant) do update set source = excluded.source, is_primary = excluded.is_primary`,
      ['card_id', 'variant']);

    const written = await insertBatch(
      tx, 'public.prices',
      ['card_id','variant','provider','currency','low_cents','mid_cents','high_cents','market_cents','direct_cents','observed_on'],
      priceRows,
      `on conflict (card_id, variant, provider) do update set
         currency = excluded.currency,
         low_cents = coalesce(excluded.low_cents, public.prices.low_cents),
         mid_cents = coalesce(excluded.mid_cents, public.prices.mid_cents),
         high_cents = coalesce(excluded.high_cents, public.prices.high_cents),
         market_cents = coalesce(excluded.market_cents, public.prices.market_cents),
         direct_cents = coalesce(excluded.direct_cents, public.prices.direct_cents),
         observed_on = greatest(excluded.observed_on, public.prices.observed_on),
         fetched_at = now()`,
      ['card_id', 'variant', 'provider'],
    );

    await insertBatch(tx, 'public.price_points', ['card_id','variant','provider','observed_on','market_cents','low_cents'], pointRows,
      `on conflict (card_id, variant, provider, observed_on) do update set
         market_cents = coalesce(excluded.market_cents, public.price_points.market_cents),
         low_cents = coalesce(excluded.low_cents, public.price_points.low_cents)`,
      ['card_id', 'variant', 'provider', 'observed_on']);

    // `partial` is the honest status when some sets are missing: the corpus is
    // usable but incomplete, and the count and the set ids are recorded rather
    // than rounded up to success.
    const status = failedSets.length ? 'partial' : 'succeeded';
    await tx.exec(`select public.finish_sync_run($1, $5::public.sync_status, $2, $3, $6, $4)`, [
      runId, written, covered.size,
      `${covered.size} cards from market data, ${inferredCards} inferred, ` +
        `${rejectedReverse} anachronistic reverse-holo listings rejected` +
        (failedSets.length ? `; ${failedSets.length} sets unavailable: ${failedSets.join(', ')}` : ''),
      status, failedSets.length,
    ]);

    log(`variants: ${variantRows.length}, prices: ${written}, inferred cards: ${inferredCards}`);
    log(`rejected ${rejectedReverse} reverse-holo listings on sets predating reverse holos`);

    if (failedSets.length) {
      log(
        `\nPARTIAL: ${failedSets.length}/${sets.length} sets could not be priced and are ` +
          `recorded as unpriced, not guessed at:\n  ${failedSets.join('\n  ')}`,
      );
      // Nothing at all landing means the provider is down, not flaky — that is
      // a failure. A handful of bad sets is not, and the coverage assertion in
      // tests/pg/data-integrity.test.ts is what decides whether enough landed.
      if (failedSets.length === sets.length) {
        throw new Error('every set failed to price — provider unavailable');
      }
    }
  }
}
