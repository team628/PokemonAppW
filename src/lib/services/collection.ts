import { newId, nowIso, type DB } from '../db';
import type { Variant } from '../catalog/variants';
import { logEvent, syncMilestonesForSet, type MilestoneRow } from './goals';
import { CONDITION_MULTIPLIER, type Condition } from '../domain/conditions';

export { CONDITIONS, CONDITION_LABEL, CONDITION_MULTIPLIER } from '../domain/conditions';
export type { Condition } from '../domain/conditions';

export interface AddInput {
  cardId: string;
  variant: Variant;
  condition?: Condition;
  quantity?: number;
  paidCents?: number | null;
  acquiredOn?: string | null;
  sourceNote?: string | null;
  gradeCompany?: string | null;
  gradeValue?: string | null;
}

export interface AddResult {
  itemId: string;
  quantity: number;
  setId: string;
  milestones: MilestoneRow[];
  firstCopy: boolean;
}

function setIdFor(db: DB, cardId: string): string {
  const row = db.prepare('SELECT set_id FROM cards WHERE id = ?').get(cardId) as
    | { set_id: string }
    | undefined;
  if (!row) throw new Error(`Unknown card: ${cardId}`);
  return row.set_id;
}

/**
 * Adds copies of a printing to a collection.
 *
 * Identity is (card, printing, condition, grade) — the same Charizard in NM and
 * in LP are genuinely different objects to a collector and to the market, so
 * they are different rows, and the value engine prices them differently.
 */
export function addToCollection(db: DB, userId: string, input: AddInput): AddResult {
  const setId = setIdFor(db, input.cardId);
  const qty = Math.max(1, Math.trunc(input.quantity ?? 1));
  const condition = input.condition ?? 'NM';
  const now = nowIso();

  const priorTotal = countCopies(db, userId, input.cardId, input.variant);

  const existing = db
    .prepare(
      `SELECT id, quantity FROM collection_items
       WHERE user_id = ? AND card_id = ? AND variant = ? AND condition = ?
         AND IFNULL(grade_company,'') = IFNULL(?,'') AND IFNULL(grade_value,'') = IFNULL(?,'')`,
    )
    .get(
      userId, input.cardId, input.variant, condition,
      input.gradeCompany ?? null, input.gradeValue ?? null,
    ) as { id: string; quantity: number } | undefined;

  let itemId: string;
  let quantity: number;

  if (existing) {
    quantity = existing.quantity + qty;
    itemId = existing.id;
    db.prepare('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?').run(
      quantity, now, itemId,
    );
  } else {
    itemId = newId('item');
    quantity = qty;
    db.prepare(
      `INSERT INTO collection_items
         (id, user_id, card_id, variant, condition, grade_company, grade_value, quantity,
          paid_cents, acquired_on, source_note, for_trade, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      itemId, userId, input.cardId, input.variant, condition,
      input.gradeCompany ?? null, input.gradeValue ?? null, qty,
      input.paidCents ?? null, input.acquiredOn ?? null, input.sourceNote ?? null, now, now,
    );
  }

  const firstCopy = priorTotal === 0;
  logEvent(db, userId, firstCopy ? 'card_acquired' : 'copy_added', {
    setId,
    cardId: input.cardId,
    payload: { variant: input.variant, condition, quantity: qty, paidCents: input.paidCents ?? null },
  });

  const milestones = firstCopy ? syncMilestonesForSet(db, userId, setId) : [];
  return { itemId, quantity, setId, milestones, firstCopy };
}

export function countCopies(db: DB, userId: string, cardId: string, variant: string): number {
  const row = db
    .prepare(
      'SELECT IFNULL(SUM(quantity),0) AS n FROM collection_items WHERE user_id = ? AND card_id = ? AND variant = ?',
    )
    .get(userId, cardId, variant) as { n: number };
  return row.n;
}

/** Removes copies; deletes the row when it hits zero. Returns remaining count. */
export function removeFromCollection(
  db: DB,
  userId: string,
  input: { cardId: string; variant: Variant; condition?: Condition; quantity?: number },
): { remaining: number; setId: string } {
  const setId = setIdFor(db, input.cardId);
  const qty = Math.max(1, Math.trunc(input.quantity ?? 1));

  const rows = db
    .prepare(
      `SELECT id, quantity FROM collection_items
       WHERE user_id = ? AND card_id = ? AND variant = ?${input.condition ? ' AND condition = ?' : ''}
       ORDER BY condition DESC`,
    )
    .all(
      ...(input.condition
        ? [userId, input.cardId, input.variant, input.condition]
        : [userId, input.cardId, input.variant]),
    ) as { id: string; quantity: number }[];

  let toRemove = qty;
  for (const r of rows) {
    if (toRemove <= 0) break;
    const take = Math.min(toRemove, r.quantity);
    if (take === r.quantity) db.prepare('DELETE FROM collection_items WHERE id = ?').run(r.id);
    else
      db.prepare('UPDATE collection_items SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(
        take, nowIso(), r.id,
      );
    toRemove -= take;
  }

  const remaining = countCopies(db, userId, input.cardId, input.variant);
  logEvent(db, userId, 'card_removed', {
    setId,
    cardId: input.cardId,
    payload: { variant: input.variant, quantity: qty - toRemove },
  });
  return { remaining, setId };
}

export function setForTrade(db: DB, userId: string, itemId: string, forTrade: boolean): void {
  db.prepare('UPDATE collection_items SET for_trade = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    forTrade ? 1 : 0, nowIso(), itemId, userId,
  );
}

export function updateItem(
  db: DB,
  userId: string,
  itemId: string,
  patch: { quantity?: number; condition?: Condition; paidCents?: number | null; acquiredOn?: string | null; forTrade?: boolean },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.quantity !== undefined) { fields.push('quantity = ?'); values.push(Math.max(0, patch.quantity)); }
  if (patch.condition !== undefined) { fields.push('condition = ?'); values.push(patch.condition); }
  if (patch.paidCents !== undefined) { fields.push('paid_cents = ?'); values.push(patch.paidCents); }
  if (patch.acquiredOn !== undefined) { fields.push('acquired_on = ?'); values.push(patch.acquiredOn); }
  if (patch.forTrade !== undefined) { fields.push('for_trade = ?'); values.push(patch.forTrade ? 1 : 0); }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(nowIso(), itemId, userId);
  db.prepare(`UPDATE collection_items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  db.prepare('DELETE FROM collection_items WHERE id = ? AND user_id = ? AND quantity <= 0').run(itemId, userId);
}

// ------------------------------------------------------------- portfolio ----

export interface HoldingRow {
  id: string;
  card_id: string;
  variant: string;
  condition: Condition;
  quantity: number;
  paid_cents: number | null;
  acquired_on: string | null;
  for_trade: number;
  grade_company: string | null;
  grade_value: string | null;
  name: string;
  number: string;
  number_sort: number;
  rarity: string | null;
  image_small: string | null;
  set_id: string;
  set_name: string;
  release_date: string | null;
  market_cents: number | null;
  mid_cents: number | null;
  low_cents: number | null;
  observed_on: string | null;
}

export interface Holding extends HoldingRow {
  /** Per-copy value after the condition adjustment, USD cents. null = unpriced. */
  unitValueCents: number | null;
  /** unitValueCents × quantity. */
  valueCents: number | null;
  conditionAdjusted: boolean;
  basis: 'market' | 'mid' | 'low' | null;
}

const HOLDINGS_SQL = `
  SELECT ci.id, ci.card_id, ci.variant, ci.condition, ci.quantity, ci.paid_cents,
         ci.acquired_on, ci.for_trade, ci.grade_company, ci.grade_value,
         c.name, c.number, c.number_sort, c.rarity, c.image_small,
         c.set_id, s.name AS set_name, s.release_date,
         p.market_cents, p.mid_cents, p.low_cents, p.observed_on
  FROM collection_items ci
  JOIN cards c ON c.id = ci.card_id
  JOIN sets  s ON s.id = c.set_id
  LEFT JOIN prices p ON p.card_id = ci.card_id AND p.variant = ci.variant AND p.provider = 'tcgplayer'
  WHERE ci.user_id = ?`;

export function listHoldings(
  db: DB,
  userId: string,
  opts: { setId?: string; forTradeOnly?: boolean } = {},
): Holding[] {
  let sql = HOLDINGS_SQL;
  const params: unknown[] = [userId];
  if (opts.setId) { sql += ' AND c.set_id = ?'; params.push(opts.setId); }
  if (opts.forTradeOnly) sql += ' AND ci.for_trade = 1';
  sql += ' ORDER BY s.release_date DESC, c.number_sort, c.number_suffix';

  return (db.prepare(sql).all(...params) as HoldingRow[]).map(decorate);
}

export function decorate(r: HoldingRow): Holding {
  let base: number | null = null;
  let basis: Holding['basis'] = null;
  for (const [b, c] of [
    ['market', r.market_cents],
    ['mid', r.mid_cents],
    ['low', r.low_cents],
  ] as const) {
    if (c !== null && c > 0) { base = c; basis = b; break; }
  }
  const mult = CONDITION_MULTIPLIER[r.condition] ?? 1;
  const unit = base === null ? null : Math.round(base * mult);
  return {
    ...r,
    unitValueCents: unit,
    valueCents: unit === null ? null : unit * r.quantity,
    conditionAdjusted: mult !== 1,
    basis,
  };
}

export interface PortfolioSummary {
  totalCards: number;
  uniqueCards: number;
  valueCents: number;
  pricedCards: number;
  unpricedCards: number;
  costBasisCents: number;
  cardsWithCost: number;
  /** Unrealised gain on the subset that has a recorded purchase price. */
  gainCents: number | null;
  duplicateCopies: number;
  duplicateValueCents: number;
  setsTouched: number;
}

export function portfolioSummary(db: DB, userId: string): PortfolioSummary {
  const holdings = listHoldings(db, userId);
  let totalCards = 0, valueCents = 0, priced = 0, unpriced = 0;
  let costBasis = 0, withCost = 0, costValue = 0;
  let dupCopies = 0, dupValue = 0;
  const sets = new Set<string>();

  for (const h of holdings) {
    totalCards += h.quantity;
    sets.add(h.set_id);
    if (h.valueCents === null) unpriced += h.quantity;
    else { valueCents += h.valueCents; priced += h.quantity; }
    if (h.paid_cents !== null) {
      costBasis += h.paid_cents * h.quantity;
      withCost += h.quantity;
      if (h.unitValueCents !== null) costValue += h.unitValueCents * h.quantity;
    }
    if (h.quantity > 1) {
      dupCopies += h.quantity - 1;
      if (h.unitValueCents !== null) dupValue += h.unitValueCents * (h.quantity - 1);
    }
  }

  return {
    totalCards,
    uniqueCards: holdings.length,
    valueCents,
    pricedCards: priced,
    unpricedCards: unpriced,
    costBasisCents: costBasis,
    cardsWithCost: withCost,
    gainCents: withCost > 0 ? costValue - costBasis : null,
    duplicateCopies: dupCopies,
    duplicateValueCents: dupValue,
    setsTouched: sets.size,
  };
}
