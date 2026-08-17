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
  /**
   * Skip the milestone recomputation for this write.
   *
   * Milestone syncing recomputes a whole set's metrics, which is right for a
   * single tap and catastrophic for a bulk import: measured at 2.4ms/row versus
   * 0.2ms, so a 20,000-row import blocked the (synchronous) server for ~48s.
   * Bulk callers defer, then call `syncMilestonesForSet` once per set.
   */
  deferMilestones?: boolean;
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

  const milestones =
    firstCopy && !input.deferMilestones ? syncMilestonesForSet(db, userId, setId) : [];
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

export function updateItem(
  db: DB,
  userId: string,
  itemId: string,
  patch: { quantity?: number; condition?: Condition; paidCents?: number | null; acquiredOn?: string | null; forTrade?: boolean },
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.quantity !== undefined) { fields.push('quantity = ?'); values.push(Math.max(0, patch.quantity)); }
  if (patch.condition !== undefined) { fields.push('condition = ?'); values.push(patch.condition); }
  if (patch.paidCents !== undefined) { fields.push('paid_cents = ?'); values.push(patch.paidCents); }
  if (patch.acquiredOn !== undefined) { fields.push('acquired_on = ?'); values.push(patch.acquiredOn); }
  if (patch.forTrade !== undefined) { fields.push('for_trade = ?'); values.push(patch.forTrade ? 1 : 0); }
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  values.push(nowIso(), itemId, userId);
  // Scoped by user_id, so another collector's row simply matches nothing. The
  // caller is told it matched nothing rather than being handed a false success.
  const result = db
    .prepare(`UPDATE collection_items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...values);
  db.prepare('DELETE FROM collection_items WHERE id = ? AND user_id = ? AND quantity <= 0').run(itemId, userId);
  return result.changes > 0;
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
  /** Per-copy value after the condition adjustment, USD cents. null = not valued. */
  unitValueCents: number | null;
  /** unitValueCents × quantity. */
  valueCents: number | null;
  conditionAdjusted: boolean;
  basis: 'market' | 'mid' | 'low' | null;
  /** Professionally graded — a different object to the market than the raw card. */
  isGraded: boolean;
  /**
   * Why no value is shown. 'graded' means SetValue has no graded price source
   * and refuses to substitute the raw price; 'unpriced' means no provider
   * covers the printing at all.
   */
  unvaluedReason: 'graded' | 'unpriced' | null;
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
  opts: { setId?: string; forTradeOnly?: boolean; limit?: number } = {},
): Holding[] {
  let sql = HOLDINGS_SQL;
  const params: unknown[] = [userId];
  if (opts.setId) { sql += ' AND c.set_id = ?'; params.push(opts.setId); }
  if (opts.forTradeOnly) sql += ' AND ci.for_trade = 1';
  sql += ' ORDER BY s.release_date DESC, c.number_sort, c.number_suffix';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  return (db.prepare(sql).all(...params) as HoldingRow[]).map(decorate);
}

export type HoldingsView = 'all' | 'duplicates' | 'trade' | 'valuable' | 'graded';
export type HoldingsSort = 'value' | 'recent' | 'name' | 'set';

export interface HoldingsQuery {
  view?: HoldingsView;
  q?: string;
  sort?: HoldingsSort;
  page?: number;
  pageSize?: number;
}

export interface HoldingsPage {
  rows: Holding[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Totals for the whole filtered set, not just this page. */
  totalCards: number;
  valueCents: number;
  unpricedCards: number;
  gradedCards: number;
  spareCopies: number;
  spareValueCents: number;
}

const VIEW_CLAUSE: Record<HoldingsView, string> = {
  all: '',
  duplicates: ' AND ci.quantity > 1',
  trade: ' AND ci.for_trade = 1',
  valuable: ' AND COALESCE(p.market_cents, p.mid_cents, p.low_cents) >= 1000',
  graded: " AND IFNULL(ci.grade_company,'') != ''",
};

const SORT_CLAUSE: Record<HoldingsSort, string> = {
  value: 'COALESCE(p.market_cents, p.mid_cents, p.low_cents) DESC NULLS LAST, c.name',
  recent: 's.release_date DESC, c.number_sort',
  name: 'c.name, s.release_date DESC',
  set: 's.name, c.number_sort, c.number_suffix',
};

/**
 * A page of holdings, with totals computed over the whole filtered set.
 *
 * Rendering an entire collection was measured at 17 MB of HTML for a
 * 15,000-card collector — on the mobile screen that collector actually uses.
 * Filtering, sorting and paging all happen in SQL so the payload stays flat
 * regardless of collection size, and the header figures still describe
 * everything that matched rather than only what fits on the page.
 */
export function listHoldingsPage(db: DB, userId: string, query: HoldingsQuery = {}): HoldingsPage {
  const view = query.view ?? 'all';
  const sort = query.sort ?? 'value';
  const pageSize = Math.min(Math.max(query.pageSize ?? 100, 10), 200);
  const term = (query.q ?? '').trim();

  const where: string[] = ['ci.user_id = ?'];
  const params: unknown[] = [userId];
  const viewClause = VIEW_CLAUSE[view];

  if (term) {
    where.push('(c.name LIKE ? OR s.name LIKE ? OR c.number = ?)');
    params.push(`%${term}%`, `%${term}%`, term);
  }

  const from = `
    FROM collection_items ci
    JOIN cards c ON c.id = ci.card_id
    JOIN sets  s ON s.id = c.set_id
    LEFT JOIN prices p ON p.card_id = ci.card_id AND p.variant = ci.variant AND p.provider = 'tcgplayer'
    WHERE ${where.join(' AND ')}${viewClause}`;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS rows_matched,
              COALESCE(SUM(ci.quantity),0) AS total_cards,
              COALESCE(SUM(CASE WHEN IFNULL(ci.grade_company,'') != '' THEN ci.quantity ELSE 0 END),0) AS graded_cards,
              COALESCE(SUM(CASE WHEN IFNULL(ci.grade_company,'') = ''
                                 AND COALESCE(p.market_cents,p.mid_cents,p.low_cents) IS NULL
                                THEN ci.quantity ELSE 0 END),0) AS unpriced_cards,
              COALESCE(SUM(CASE WHEN ci.quantity > 1 THEN ci.quantity - 1 ELSE 0 END),0) AS spare_copies
       ${from}`,
    )
    .get(...params) as {
    rows_matched: number; total_cards: number; graded_cards: number;
    unpriced_cards: number; spare_copies: number;
  };

  // Condition adjustment and the graded exclusion live in `decorate`, so value
  // totals are summed in JS over the matched rows rather than duplicated in SQL.
  const valueRows = db
    .prepare(`SELECT ci.condition, ci.quantity, ci.grade_company, p.market_cents, p.mid_cents, p.low_cents ${from}`)
    .all(...params) as {
    condition: Condition; quantity: number; grade_company: string | null;
    market_cents: number | null; mid_cents: number | null; low_cents: number | null;
  }[];

  let valueCents = 0;
  let spareValueCents = 0;
  for (const r of valueRows) {
    if (r.grade_company) continue; // graded cards are not valued at raw prices
    const base = r.market_cents ?? r.mid_cents ?? r.low_cents;
    if (base === null) continue;
    const unit = Math.round(base * (CONDITION_MULTIPLIER[r.condition] ?? 1));
    valueCents += unit * r.quantity;
    if (r.quantity > 1) spareValueCents += unit * (r.quantity - 1);
  }

  const pageCount = Math.max(1, Math.ceil(totals.rows_matched / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);

  const rows = db
    .prepare(
      `SELECT ci.id, ci.card_id, ci.variant, ci.condition, ci.quantity, ci.paid_cents,
              ci.acquired_on, ci.for_trade, ci.grade_company, ci.grade_value,
              c.name, c.number, c.number_sort, c.rarity, c.image_small,
              c.set_id, s.name AS set_name, s.release_date,
              p.market_cents, p.mid_cents, p.low_cents, p.observed_on
       ${from}
       ORDER BY ${SORT_CLAUSE[sort]}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as HoldingRow[];

  return {
    rows: rows.map(decorate),
    total: totals.rows_matched,
    page,
    pageSize,
    pageCount,
    totalCards: totals.total_cards,
    valueCents,
    unpricedCards: totals.unpriced_cards,
    gradedCards: totals.graded_cards,
    spareCopies: totals.spare_copies,
    spareValueCents,
  };
}

/**
 * Attaches a value to a holding — or explicitly declines to.
 *
 * Graded cards are deliberately left unvalued. A PSA 10 and a raw copy of the
 * same card are different objects to the market, routinely by one or two orders
 * of magnitude, and SetValue has no graded price source. Quoting the raw price
 * for a slabbed card would be a fabricated number dressed as a real one, so the
 * card is carried in the collection, counted toward completion, and reported as
 * "graded — not valued" everywhere a figure would otherwise appear.
 */
export function decorate(r: HoldingRow): Holding {
  const isGraded = !!(r.grade_company && r.grade_company.trim() !== '');

  let base: number | null = null;
  let basis: Holding['basis'] = null;
  for (const [b, c] of [
    ['market', r.market_cents],
    ['mid', r.mid_cents],
    ['low', r.low_cents],
  ] as const) {
    if (c !== null && c > 0) { base = c; basis = b; break; }
  }

  if (isGraded) {
    return {
      ...r,
      unitValueCents: null,
      valueCents: null,
      conditionAdjusted: false,
      basis: null,
      isGraded: true,
      unvaluedReason: 'graded',
    };
  }

  const mult = CONDITION_MULTIPLIER[r.condition] ?? 1;
  const unit = base === null ? null : Math.round(base * mult);
  return {
    ...r,
    unitValueCents: unit,
    valueCents: unit === null ? null : unit * r.quantity,
    conditionAdjusted: mult !== 1,
    basis,
    isGraded: false,
    unvaluedReason: unit === null ? 'unpriced' : null,
  };
}

export interface PortfolioSummary {
  totalCards: number;
  uniqueCards: number;
  valueCents: number;
  pricedCards: number;
  unpricedCards: number;
  /** Held, counted toward completion, deliberately excluded from valuation. */
  gradedCards: number;
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
  let totalCards = 0, valueCents = 0, priced = 0, unpriced = 0, graded = 0;
  let costBasis = 0, withCost = 0, costValue = 0;
  let dupCopies = 0, dupValue = 0;
  const sets = new Set<string>();

  for (const h of holdings) {
    totalCards += h.quantity;
    sets.add(h.set_id);
    if (h.isGraded) graded += h.quantity;
    else if (h.valueCents === null) unpriced += h.quantity;
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
    gradedCards: graded,
    costBasisCents: costBasis,
    cardsWithCost: withCost,
    gainCents: withCost > 0 ? costValue - costBasis : null,
    duplicateCopies: dupCopies,
    duplicateValueCents: dupValue,
    setsTouched: sets.size,
  };
}
