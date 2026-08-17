import type { DB } from '../db';
import { goalViews } from './goals';

/**
 * The Completion Graph, aggregated.
 *
 * A want index answers "how many collectors are currently missing this exact
 * printing?" — the question that makes SetValue useful to a shop deciding what
 * to stock, and to a collector deciding whether a spare is worth holding.
 *
 * Scale note: this walks every tracked goal on every call, which is correct and
 * cheap at the size a single instance runs at. The shape it would become is a
 * `want_index` table maintained on collection and goal writes; every consumer
 * below reads through this function, so that change is local to this file.
 */

export interface WantEntry {
  cardId: string;
  variant: string;
  /** Distinct collectors missing this printing for a set they are chasing. */
  collectors: number;
  /** Market value of the printing, USD cents — null when unpriced. */
  marketCents: number | null;
}

const key = (cardId: string, variant: string) => `${cardId}::${variant}`;

export function buildWantIndex(db: DB, opts: { excludeUserId?: string } = {}): Map<string, WantEntry> {
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  const index = new Map<string, WantEntry>();

  for (const u of users) {
    if (u.id === opts.excludeUserId) continue;
    for (const view of goalViews(db, u.id)) {
      for (const m of view.metrics.missing) {
        const k = key(m.cardId, m.variant);
        const existing = index.get(k);
        if (existing) existing.collectors++;
        else
          index.set(k, {
            cardId: m.cardId,
            variant: m.variant,
            collectors: 1,
            marketCents: m.marketCents,
          });
      }
    }
  }
  return index;
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

/** How much other collectors want the spare copies this collector is sitting on. */
export function demandForSpares(db: DB, userId: string): SpareDemand[] {
  const index = buildWantIndex(db, { excludeUserId: userId });
  const rows = db
    .prepare(
      `SELECT ci.id, ci.card_id, ci.variant, ci.quantity, ci.for_trade, ci.condition,
              c.name, c.number, c.image_small, s.name AS set_name,
              p.market_cents, p.mid_cents, p.low_cents
       FROM collection_items ci
       JOIN cards c ON c.id = ci.card_id
       JOIN sets s ON s.id = c.set_id
       LEFT JOIN prices p ON p.card_id = ci.card_id AND p.variant = ci.variant AND p.provider='tcgplayer'
       WHERE ci.user_id = ? AND ci.quantity > 1`,
    )
    .all(userId) as {
    id: string; card_id: string; variant: string; quantity: number; for_trade: number;
    name: string; number: string; image_small: string | null; set_name: string;
    market_cents: number | null; mid_cents: number | null; low_cents: number | null;
  }[];

  return rows
    .map((r) => ({
      itemId: r.id,
      cardId: r.card_id,
      name: r.name,
      number: r.number,
      setName: r.set_name,
      variant: r.variant,
      imageSmall: r.image_small,
      spareCopies: r.quantity - 1,
      unitValueCents: r.market_cents ?? r.mid_cents ?? r.low_cents,
      forTrade: r.for_trade === 1,
      wantedBy: index.get(key(r.card_id, r.variant))?.collectors ?? 0,
    }))
    .sort((a, b) => b.wantedBy - a.wantedBy || (b.unitValueCents ?? 0) - (a.unitValueCents ?? 0));
}

export interface DemandRow extends WantEntry {
  name: string;
  number: string;
  setId: string;
  setName: string;
  imageSmall: string | null;
  rarity: string | null;
  /** Copies of this printing sitting in partner inventory, if any. */
  partnerStock?: number;
}

/**
 * The report a card shop asks for: which cards do SetValue collectors actually
 * need, ranked by how many collectors need them.
 *
 * Deliberately aggregate-only — it reports counts, never identities. A partner
 * learns what the market wants without learning anything about any collector.
 */
export function demandReport(
  db: DB,
  opts: { limit?: number; setId?: string; partnerId?: string } = {},
): DemandRow[] {
  const index = buildWantIndex(db);
  const entries = [...index.values()].filter((e) => e.collectors > 0);
  if (!entries.length) return [];

  const cardIds = [...new Set(entries.map((e) => e.cardId))];
  const meta = new Map<string, { name: string; number: string; set_id: string; set_name: string; image_small: string | null; rarity: string | null }>();
  const CHUNK = 400;
  for (let i = 0; i < cardIds.length; i += CHUNK) {
    const chunk = cardIds.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.number, c.set_id, c.rarity, c.image_small, s.name AS set_name
         FROM cards c JOIN sets s ON s.id = c.set_id
         WHERE c.id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as { id: string; name: string; number: string; set_id: string; set_name: string; image_small: string | null; rarity: string | null }[];
    for (const r of rows) meta.set(r.id, r);
  }

  let stock = new Map<string, number>();
  if (opts.partnerId) {
    const rows = db
      .prepare('SELECT card_id, variant, quantity FROM partner_inventory WHERE partner_id = ?')
      .all(opts.partnerId) as { card_id: string; variant: string; quantity: number }[];
    stock = new Map(rows.map((r) => [key(r.card_id, r.variant), r.quantity]));
  }

  return entries
    .map((e): DemandRow | null => {
      const m = meta.get(e.cardId);
      if (!m) return null;
      if (opts.setId && m.set_id !== opts.setId) return null;
      return {
        ...e,
        name: m.name,
        number: m.number,
        setId: m.set_id,
        setName: m.set_name,
        imageSmall: m.image_small,
        rarity: m.rarity,
        partnerStock: opts.partnerId ? (stock.get(key(e.cardId, e.variant)) ?? 0) : undefined,
      };
    })
    .filter((r): r is DemandRow => r !== null)
    .sort((a, b) => b.collectors - a.collectors || (b.marketCents ?? 0) - (a.marketCents ?? 0))
    .slice(0, opts.limit ?? 100);
}
