import type { DB } from '../db';

/**
 * The Completion Graph, aggregated.
 *
 * A want index answers "how many collectors are currently missing this exact
 * printing?" — the question that makes SetValue useful to a shop deciding what
 * to stock, and to a collector deciding whether a spare is worth holding.
 *
 * This used to walk every user's goals in JavaScript, recomputing full set
 * metrics per goal. That is O(users x sets x cards) and measured 3.2s at 1,000
 * collectors and 15s at 5,000 — on a public page, in a synchronous driver, so
 * it stalled every other request on the server. It is now a single indexed
 * aggregate that expresses the same rule set in SQL.
 *
 * The goal-mode predicate below must stay in lockstep with
 * `requirementsForMode` in src/lib/domain/goals.ts:
 *   master   - every printing
 *   complete - the primary printing of every card
 *   main     - the primary printing of every non-secret card
 * A test asserts the two agree.
 */

export interface WantEntry {
  cardId: string;
  variant: string;
  /** Distinct collectors missing this printing for a set they are chasing. */
  collectors: number;
  /** Market value of the printing, USD cents — null when unpriced. */
  marketCents: number | null;
}

/** The shared predicate: a (goal, printing) pair this goal actually requires. */
const MODE_PREDICATE = `(
  g.mode = 'master'
  OR (v.is_primary = 1 AND (g.mode = 'complete' OR c.is_secret = 0))
)`;

/** …and the collector does not already own it. */
const NOT_OWNED = `NOT EXISTS (
  SELECT 1 FROM collection_items ci
  WHERE ci.user_id = g.user_id AND ci.card_id = v.card_id
    AND ci.variant = v.variant AND ci.quantity > 0
)`;

export function buildWantIndex(db: DB, opts: { excludeUserId?: string } = {}): Map<string, WantEntry> {
  const rows = db
    .prepare(
      `SELECT v.card_id, v.variant, COUNT(DISTINCT g.user_id) AS collectors,
              COALESCE(p.market_cents, p.mid_cents, p.low_cents) AS market_cents
       FROM set_goals g
       JOIN cards c ON c.set_id = g.set_id
       JOIN card_variants v ON v.card_id = c.id
       LEFT JOIN prices p
              ON p.card_id = v.card_id AND p.variant = v.variant AND p.provider = 'tcgplayer'
       WHERE ${MODE_PREDICATE}
         AND ${opts.excludeUserId ? 'g.user_id != ? AND' : ''} ${NOT_OWNED}
       GROUP BY v.card_id, v.variant`,
    )
    .all(...(opts.excludeUserId ? [opts.excludeUserId] : [])) as {
    card_id: string;
    variant: string;
    collectors: number;
    market_cents: number | null;
  }[];

  return new Map(
    rows.map((r) => [
      `${r.card_id}::${r.variant}`,
      {
        cardId: r.card_id,
        variant: r.variant,
        collectors: r.collectors,
        marketCents: r.market_cents,
      },
    ]),
  );
}

export interface SpareDemand {
  itemId: string;
  cardId: string;
  name: string;
  number: string;
  setName: string;
  variant: string;
  imageSmall: string | null;
  spareCopies: number;
  unitValueCents: number | null;
  forTrade: boolean;
  /** Other collectors who need this exact printing. */
  wantedBy: number;
}

/**
 * How much other collectors want the spare copies this collector is sitting on.
 *
 * Scoped to the printings the collector actually holds spare, rather than
 * building the whole want index and discarding almost all of it.
 */
export function demandForSpares(db: DB, userId: string): SpareDemand[] {
  const rows = db
    .prepare(
      `SELECT ci.id, ci.card_id, ci.variant, ci.quantity, ci.for_trade,
              c.name, c.number, c.image_small, s.name AS set_name,
              COALESCE(p.market_cents, p.mid_cents, p.low_cents) AS unit_cents,
              (
                SELECT COUNT(DISTINCT g.user_id)
                FROM set_goals g
                JOIN cards gc ON gc.set_id = g.set_id AND gc.id = ci.card_id
                JOIN card_variants v ON v.card_id = gc.id AND v.variant = ci.variant
                WHERE g.user_id != ci.user_id
                  AND (
                    g.mode = 'master'
                    OR (v.is_primary = 1 AND (g.mode = 'complete' OR gc.is_secret = 0))
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM collection_items o
                    WHERE o.user_id = g.user_id AND o.card_id = v.card_id
                      AND o.variant = v.variant AND o.quantity > 0
                  )
              ) AS wanted_by
       FROM collection_items ci
       JOIN cards c ON c.id = ci.card_id
       JOIN sets s ON s.id = c.set_id
       LEFT JOIN prices p
              ON p.card_id = ci.card_id AND p.variant = ci.variant AND p.provider = 'tcgplayer'
       WHERE ci.user_id = ? AND ci.quantity > 1
       ORDER BY wanted_by DESC, unit_cents DESC
       LIMIT 200`,
    )
    .all(userId) as {
    id: string; card_id: string; variant: string; quantity: number; for_trade: number;
    name: string; number: string; image_small: string | null; set_name: string;
    unit_cents: number | null; wanted_by: number;
  }[];

  return rows.map((r) => ({
    itemId: r.id,
    cardId: r.card_id,
    name: r.name,
    number: r.number,
    setName: r.set_name,
    variant: r.variant,
    imageSmall: r.image_small,
    spareCopies: r.quantity - 1,
    unitValueCents: r.unit_cents,
    forTrade: r.for_trade === 1,
    wantedBy: r.wanted_by,
  }));
}

export interface DemandRow extends WantEntry {
  name: string;
  number: string;
  setId: string;
  setName: string;
  imageSmall: string | null;
  rarity: string | null;
}

export interface DemandSummary {
  rows: DemandRow[];
  /** Distinct printings with at least one collector waiting. */
  openWants: number;
  /** Sum of collectors across every wanted printing. */
  totalDemand: number;
  demandValueCents: number;
  /** When the index was last rebuilt; null if it never has been. */
  computedAt: string | null;
  /** How long that rebuild took, for the operational note on the page. */
  durationMs: number | null;
}

/**
 * The report a card shop asks for: which cards do SetValue collectors actually
 * need, ranked by how many collectors need them.
 *
 * Reads the materialised index rather than recomputing. The recompute is
 * roughly (goals x set size) row visits — 8.7s at 5,000 collectors — and this
 * page is public, so doing that work per request handed anyone a denial of
 * service. See wantIndexWorker.mjs.
 *
 * Deliberately aggregate-only — it reports counts, never identities. A partner
 * learns what the market wants without learning anything about any collector.
 */
export function demandReport(db: DB, opts: { limit?: number; setId?: string } = {}): DemandSummary {
  const limit = Math.min(opts.limit ?? 60, 200);

  const meta = db.prepare('SELECT * FROM want_index_meta WHERE id = 1').get() as
    | { computed_at: string; duration_ms: number; open_wants: number; total_demand: number; demand_value_cents: number }
    | undefined;

  const rows = db
    .prepare(
      `SELECT w.card_id, w.variant, w.collectors, w.market_cents,
              c.name, c.number, c.rarity, c.image_small, c.set_id, s.name AS set_name
       FROM want_index w
       JOIN cards c ON c.id = w.card_id
       JOIN sets s ON s.id = c.set_id
       ${opts.setId ? 'WHERE c.set_id = ?' : ''}
       ORDER BY w.collectors DESC, w.market_cents DESC
       LIMIT ?`,
    )
    .all(...(opts.setId ? [opts.setId, limit] : [limit])) as {
    card_id: string; variant: string; collectors: number; market_cents: number | null;
    name: string; number: string; rarity: string | null; image_small: string | null;
    set_id: string; set_name: string;
  }[];

  return {
    rows: rows.map((r) => ({
      cardId: r.card_id,
      variant: r.variant,
      collectors: r.collectors,
      marketCents: r.market_cents,
      name: r.name,
      number: r.number,
      setId: r.set_id,
      setName: r.set_name,
      imageSmall: r.image_small,
      rarity: r.rarity,
    })),
    openWants: meta?.open_wants ?? 0,
    totalDemand: meta?.total_demand ?? 0,
    demandValueCents: meta?.demand_value_cents ?? 0,
    computedAt: meta?.computed_at ?? null,
    durationMs: meta?.duration_ms ?? null,
  };
}
