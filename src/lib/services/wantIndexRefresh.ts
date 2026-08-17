/**
 * Recomputes the materialised want index.
 *
 * Kept in its own module with no Next.js imports so it can be required from a
 * worker thread as well as directly (tests, CLI). It must express exactly the
 * same rule as `requirementsForMode`; tests/demand-parity.test.ts holds the two
 * definitions together.
 */
import type { DB } from '../db';

export interface RefreshResult {
  openWants: number;
  totalDemand: number;
  demandValueCents: number;
  durationMs: number;
}

export function refreshWantIndex(db: DB): RefreshResult {
  const started = Date.now();

  const rows = db
    .prepare(
      `SELECT v.card_id, v.variant, COUNT(DISTINCT g.user_id) AS collectors,
              COALESCE(p.market_cents, p.mid_cents, p.low_cents) AS market_cents
       FROM set_goals g
       JOIN cards c ON c.set_id = g.set_id
       JOIN card_variants v ON v.card_id = c.id
       LEFT JOIN prices p
              ON p.card_id = v.card_id AND p.variant = v.variant AND p.provider = 'tcgplayer'
       WHERE (
               g.mode = 'master'
               OR (v.is_primary = 1 AND (g.mode = 'complete' OR c.is_secret = 0))
             )
         AND NOT EXISTS (
               SELECT 1 FROM collection_items ci
               WHERE ci.user_id = g.user_id AND ci.card_id = v.card_id
                 AND ci.variant = v.variant AND ci.quantity > 0
             )
       GROUP BY v.card_id, v.variant`,
    )
    .all() as { card_id: string; variant: string; collectors: number; market_cents: number | null }[];

  let totalDemand = 0;
  let demandValue = 0;
  for (const r of rows) {
    totalDemand += r.collectors;
    demandValue += r.collectors * (r.market_cents ?? 0);
  }

  const insert = db.prepare(
    'INSERT OR REPLACE INTO want_index (card_id, variant, collectors, market_cents) VALUES (?, ?, ?, ?)',
  );
  const durationMs = Date.now() - started;

  db.transaction(() => {
    db.prepare('DELETE FROM want_index').run();
    for (const r of rows) insert.run(r.card_id, r.variant, r.collectors, r.market_cents);
    db.prepare(
      `INSERT OR REPLACE INTO want_index_meta
         (id, computed_at, duration_ms, open_wants, total_demand, demand_value_cents)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(new Date().toISOString(), durationMs, rows.length, totalDemand, demandValue);
  })();

  return {
    openWants: rows.length,
    totalDemand,
    demandValueCents: demandValue,
    durationMs: Date.now() - started,
  };
}
