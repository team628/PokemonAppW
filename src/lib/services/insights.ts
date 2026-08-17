import type { DB } from '../db';
import type { Variant } from '../catalog/variants';
import { computeMoves, type DupeInput, type Move, type PriceDropInput, type TradeMatchInput } from '../domain/nextBestMove';
import { goalViews, type GoalView } from './goals';
import { CONDITION_MULTIPLIER, type Condition } from '../domain/conditions';

const key = (cardId: string, variant: string) => `${cardId}::${variant}`;

/**
 * Cards the collector holds more than one of — the raw material for trades.
 *
 * Filtered in SQL rather than by loading and decorating the entire collection:
 * for a 15,000-card collector that was 15,000 rows materialised to find a few
 * dozen duplicates. Graded cards are excluded — a slab is not a spare, and it
 * carries no value SetValue is willing to quote.
 */
export function duplicates(db: DB, userId: string): DupeInput[] {
  const rows = db
    .prepare(
      `SELECT ci.card_id, ci.variant, ci.quantity, ci.condition,
              c.name, c.number, c.image_small,
              COALESCE(p.market_cents, p.mid_cents, p.low_cents) AS base_cents
       FROM collection_items ci
       JOIN cards c ON c.id = ci.card_id
       LEFT JOIN prices p
              ON p.card_id = ci.card_id AND p.variant = ci.variant AND p.provider = 'tcgplayer'
       WHERE ci.user_id = ? AND ci.quantity > 1 AND IFNULL(ci.grade_company,'') = ''
       ORDER BY base_cents DESC
       LIMIT 500`,
    )
    .all(userId) as {
    card_id: string; variant: string; quantity: number; condition: Condition;
    name: string; number: string; image_small: string | null; base_cents: number | null;
  }[];

  return rows
    .map((r) => ({
      cardId: r.card_id,
      name: r.name,
      number: r.number,
      variant: r.variant,
      imageSmall: r.image_small,
      spareCopies: r.quantity - 1,
      unitValueCents:
        r.base_cents === null
          ? null
          : Math.round(r.base_cents * (CONDITION_MULTIPLIER[r.condition] ?? 1)),
    }))
    .sort((a, b) => (b.unitValueCents ?? 0) * b.spareCopies - (a.unitValueCents ?? 0) * a.spareCopies);
}

/**
 * Missing slots across every tracked goal, as a lookup set.
 * Used by the trade matcher and by Card Show mode's "do I need this?" check.
 */
export function missingSlotKeys(views: GoalView[]): Set<string> {
  const s = new Set<string>();
  for (const v of views) for (const m of v.metrics.missing) s.add(key(m.cardId, m.variant));
  return s;
}

export interface TradeCandidate extends TradeMatchInput {
  counterpartUserId: string;
  spareCopies: number;
}

/**
 * Finds copies other collectors have flagged for trade that fill holes in this
 * collector's tracked sets, and marks the ones where the interest runs both
 * ways.
 *
 * Scoping the scan to sets the collector actually tracks keeps this bounded:
 * the candidate pool is other people's trade binders intersected with a handful
 * of sets, not the whole database. At larger scale this same shape becomes a
 * materialised want/have index rather than a live join, but the query and its
 * result contract stay the same.
 */
export const TRADE_MATCH_LIMIT = 400;

interface OfferedRow {
  user_id: string;
  card_id: string;
  variant: string;
  quantity: number;
  handle: string;
  display_name: string;
  name: string;
  number: string;
  image_small: string | null;
  market_cents: number | null;
}

export function tradeMatches(
  db: DB,
  userId: string,
  views: GoalView[],
  opts: { limit?: number } = {},
): TradeCandidate[] {
  if (!views.length) return [];
  const setIds = [...new Set(views.map((v) => v.set.id))];
  const mine = missingSlotKeys(views);
  if (!mine.size) return [];

  // Two strategies, chosen by how much this collector is missing.
  //
  // Narrowing by missing card id is far cheaper for a typical collector (one
  // or two goals), because the card_id lookup is indexed and the trade
  // inventory of a popular set is large. But a collector chasing eight master
  // sets is missing thousands of cards, and the chunked IN clauses then cost
  // more than simply scanning the sets' trade inventory once. Measured at 5,010
  // collectors: 219ms scoped vs 96ms narrowed for a typical collector. Each
  // chunk is itself capped, because a single popular card can carry hundreds of
  // trade listings once the user base is large, and the sort that picks the
  // most valuable matches happens after the rows are bounded.
  const missingCardIds = [...new Set([...mine].map((k) => k.split('::')[0]!))];
  const NARROW_THRESHOLD = 2000;
  const limit = opts.limit ?? TRADE_MATCH_LIMIT;
  const rows: OfferedRow[] = [];

  const SELECT = `SELECT ci.user_id, ci.card_id, ci.variant, ci.quantity,
                         u.handle, u.display_name,
                         c.name, c.number, c.image_small,
                         p.market_cents
                  FROM collection_items ci
                  JOIN users u ON u.id = ci.user_id
                  JOIN cards c ON c.id = ci.card_id
                  LEFT JOIN prices p
                         ON p.card_id = ci.card_id AND p.variant = ci.variant
                        AND p.provider = 'tcgplayer'`;

  if (missingCardIds.length <= NARROW_THRESHOLD) {
    const CARD_CHUNK = 400;
    for (let i = 0; i < missingCardIds.length; i += CARD_CHUNK) {
      const chunk = missingCardIds.slice(i, i + CARD_CHUNK);
      rows.push(
        ...(db
          .prepare(
            `${SELECT}
             WHERE ci.for_trade = 1 AND ci.user_id != ?
               AND ci.card_id IN (${chunk.map(() => '?').join(',')})
             ORDER BY p.market_cents DESC
             LIMIT ?`,
          )
          .all(userId, ...chunk, limit * 2) as OfferedRow[]),
      );
    }
  } else {
    const placeholders = setIds.map(() => '?').join(',');
    rows.push(
      ...(db
        .prepare(
          `${SELECT}
           WHERE ci.user_id != ? AND ci.for_trade = 1 AND c.set_id IN (${placeholders})
           ORDER BY p.market_cents DESC
           LIMIT ?`,
        )
        .all(userId, ...setIds, limit * 6) as OfferedRow[]),
    );
  }

  const wanted = rows
    .filter((o) => mine.has(key(o.card_id, o.variant)))
    .sort((a, b) => (b.market_cents ?? 0) - (a.market_cents ?? 0))
    .slice(0, limit);
  if (!wanted.length) return [];

  // Does each counterpart need anything this collector holds spare?
  //
  // This used to recompute every counterpart's full set metrics in JavaScript —
  // O(counterparts x set size), and measured 1.8s at 1,000 collectors. It is now
  // one aggregate restricted to the printings this collector actually holds
  // spare, using the same goal-mode predicate as the want index.
  const mySpares = duplicates(db, userId);
  const mutualBy = new Map<string, boolean>();

  if (mySpares.length) {
    const spareKeys = new Set(mySpares.map((d) => key(d.cardId, d.variant)));
    const spareCardIds = [...new Set(mySpares.map((d) => d.cardId))];
    const counterparts = [...new Set(wanted.map((w) => w.user_id))];

    const CHUNK = 300;
    for (let i = 0; i < spareCardIds.length; i += CHUNK) {
      const chunk = spareCardIds.slice(i, i + CHUNK);
      const rows = db
        .prepare(
          `SELECT DISTINCT g.user_id, v.card_id, v.variant
           FROM set_goals g
           JOIN cards c ON c.set_id = g.set_id
           JOIN card_variants v ON v.card_id = c.id
           WHERE g.user_id IN (${counterparts.map(() => '?').join(',')})
             AND v.card_id IN (${chunk.map(() => '?').join(',')})
             AND (
               g.mode = 'master'
               OR (v.is_primary = 1 AND (g.mode = 'complete' OR c.is_secret = 0))
             )
             AND NOT EXISTS (
               SELECT 1 FROM collection_items ci
               WHERE ci.user_id = g.user_id AND ci.card_id = v.card_id
                 AND ci.variant = v.variant AND ci.quantity > 0
             )`,
        )
        .all(...counterparts, ...chunk) as { user_id: string; card_id: string; variant: string }[];

      for (const r of rows) {
        if (spareKeys.has(key(r.card_id, r.variant))) mutualBy.set(r.user_id, true);
      }
    }
  }

  return wanted.map((o) => ({
    counterpartUserId: o.user_id,
    counterpartHandle: o.handle,
    counterpartDisplayName: o.display_name,
    cardId: o.card_id,
    name: o.name,
    number: o.number,
    variant: o.variant,
    imageSmall: o.image_small,
    valueCents: o.market_cents,
    spareCopies: Math.max(0, o.quantity - 1),
    mutual: mutualBy.get(o.user_id) ?? false,
  }));
}

/**
 * Market moves on cards the collector still needs.
 *
 * Requires two provider observations on different dates. Until a second daily
 * snapshot lands, this correctly returns nothing — a single data point is not a
 * trend, and presenting it as one would be the exact kind of invented signal
 * SetValue refuses to ship.
 */
export function priceDrops(
  db: DB,
  views: GoalView[],
  opts: { minDropPct?: number; limit?: number } = {},
): PriceDropInput[] {
  const minDrop = opts.minDropPct ?? 0.1;
  const missing = views.flatMap((v) =>
    v.metrics.missing.map((m) => ({ ...m, setId: v.set.id })),
  );
  if (!missing.length) return [];

  const byCard = new Map(missing.map((m) => [key(m.cardId, m.variant), m]));
  const cardIds = [...new Set(missing.map((m) => m.cardId))];

  const out: PriceDropInput[] = [];
  const CHUNK = 400;
  for (let i = 0; i < cardIds.length; i += CHUNK) {
    const chunk = cardIds.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT card_id, variant, observed_on, market_cents
         FROM price_points
         WHERE provider = 'tcgplayer' AND market_cents IS NOT NULL
           AND card_id IN (${chunk.map(() => '?').join(',')})
         ORDER BY card_id, variant, observed_on DESC`,
      )
      .all(...chunk) as { card_id: string; variant: string; observed_on: string; market_cents: number }[];

    const series = new Map<string, { on: string; cents: number }[]>();
    for (const r of rows) {
      const k = key(r.card_id, r.variant);
      if (!byCard.has(k)) continue;
      const arr = series.get(k) ?? [];
      if (arr.length < 2) arr.push({ on: r.observed_on, cents: r.market_cents });
      series.set(k, arr);
    }

    for (const [k, points] of series) {
      if (points.length < 2) continue;
      const [now, prev] = points as [{ on: string; cents: number }, { on: string; cents: number }];
      if (prev.cents <= 0) continue;
      const drop = (prev.cents - now.cents) / prev.cents;
      if (drop < minDrop) continue;
      const m = byCard.get(k)!;
      out.push({
        cardId: m.cardId,
        name: m.name,
        number: m.number,
        variant: m.variant,
        setId: m.setId,
        imageSmall: m.imageSmall,
        currentCents: now.cents,
        previousCents: prev.cents,
        currentOn: now.on,
        previousOn: prev.on,
      });
    }
  }

  return out
    .sort((a, b) => b.previousCents - b.currentCents - (a.previousCents - a.currentCents))
    .slice(0, opts.limit ?? 12);
}

export interface Insights {
  views: GoalView[];
  moves: Move[];
  dupes: DupeInput[];
  trades: TradeCandidate[];
  drops: PriceDropInput[];
  /** True when history is too shallow for change detection to say anything. */
  historyTooShallow: boolean;
  historyStartedOn: string | null;
}

export function buildInsights(db: DB, userId: string, budgetCents?: number | null): Insights {
  const views = goalViews(db, userId);
  const dupes = duplicates(db, userId);
  const trades = tradeMatches(db, userId, views);
  const drops = priceDrops(db, views);

  // Change detection needs two readings *of the same printing*, not two dates
  // somewhere in the table. Providers stamp each card with its own
  // last-updated date, so a database holding one snapshot still spans years of
  // distinct dates — counting those would advertise trend detection that
  // cannot actually run. This asks the only question that matters: is there any
  // printing we have seen twice?
  const span = db
    .prepare(
      `SELECT (SELECT MIN(observed_on) FROM price_points WHERE provider = 'tcgplayer') AS first,
              EXISTS (
                SELECT 1 FROM price_points WHERE provider = 'tcgplayer'
                GROUP BY card_id, variant HAVING COUNT(DISTINCT observed_on) > 1
              ) AS comparable`,
    )
    .get() as { first: string | null; comparable: number };

  const moves = computeMoves({
    goals: views.map((v) => ({
      goalId: v.goal.id,
      setId: v.set.id,
      setName: v.set.name,
      mode: v.goal.mode,
      metrics: v.metrics,
    })),
    dupes,
    tradeMatches: trades,
    priceDrops: drops,
    budgetCents,
  });

  return {
    views,
    moves,
    dupes,
    trades,
    drops,
    historyTooShallow: span.comparable !== 1,
    historyStartedOn: span.first,
  };
}
