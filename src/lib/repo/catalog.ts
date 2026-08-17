import type { DB } from '../db';
import type { Variant } from '../catalog/variants';
import type { Requirement } from '../domain/goals';

export interface SetRow {
  id: string;
  name: string;
  series: string;
  printed_total: number;
  total: number;
  ptcgo_code: string | null;
  release_date: string | null;
  symbol_url: string | null;
  logo_url: string | null;
}

export interface CardRow {
  id: string;
  set_id: string;
  number: string;
  number_sort: number;
  name: string;
  supertype: string | null;
  subtypes: string;
  rarity: string | null;
  artist: string | null;
  hp: string | null;
  types: string;
  flavor_text: string | null;
  image_small: string | null;
  image_large: string | null;
  is_secret: number;
  set_name?: string;
  printed_total?: number;
}

export function getSet(db: DB, setId: string): SetRow | undefined {
  return db.prepare('SELECT * FROM sets WHERE id = ?').get(setId) as SetRow | undefined;
}

export function listSets(db: DB): SetRow[] {
  return db
    .prepare('SELECT * FROM sets ORDER BY release_date DESC, name')
    .all() as SetRow[];
}

export function getCard(db: DB, cardId: string): CardRow | undefined {
  return db
    .prepare(
      `SELECT c.*, s.name AS set_name, s.printed_total, s.logo_url AS set_logo, s.release_date AS set_release
       FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id = ?`,
    )
    .get(cardId) as CardRow | undefined;
}

/**
 * Every (card, printing) slot in a set, with its USD market data attached.
 *
 * This single query is the input to the completion engine — it is deliberately
 * the only place set-level pricing is assembled, so there is exactly one
 * definition of "what this slot is worth" in the product.
 */
export function setRequirements(db: DB, setId: string): Requirement[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.number, c.number_sort, c.number_suffix, c.name, c.rarity,
              c.image_small, c.is_secret,
              v.variant, v.source AS variant_source, v.is_primary,
              p.market_cents, p.mid_cents, p.low_cents, p.direct_cents, p.observed_on
       FROM cards c
       JOIN card_variants v ON v.card_id = c.id
       LEFT JOIN prices p
              ON p.card_id = c.id AND p.variant = v.variant AND p.provider = 'tcgplayer'
       WHERE c.set_id = ?
       ORDER BY c.number_sort, c.number_suffix, v.is_primary DESC, v.variant`,
    )
    .all(setId) as RawReqRow[];

  return rows.map(toRequirement);
}

export interface RawReqRow {
  id: string;
  number: string;
  number_sort: number;
  name: string;
  rarity: string | null;
  image_small: string | null;
  is_secret: number;
  variant: string;
  variant_source: string;
  is_primary: number;
  market_cents: number | null;
  mid_cents: number | null;
  low_cents: number | null;
  direct_cents: number | null;
  observed_on: string | null;
}

/**
 * Applies the market → mid → low ladder, keeping the basis that won.
 *
 * This is where SetValue's valuation policy is enforced, and it turns on three
 * rules:
 *
 *  1. **One currency per number.** Set and portfolio totals are USD from
 *     TCGplayer only. Cardmarket figures are EUR and appear as a secondary
 *     reference on a card, never silently converted — there is no FX feed here,
 *     and inventing a rate would quietly corrupt every total in the product.
 *  2. **Explicit basis.** `market` is transaction-derived; `mid` and `low` are
 *     listing-derived. Which one produced a figure travels with it, so the UI
 *     can soften the claim rather than presenting a listing as a sale.
 *  3. **Absence is a value.** A slot with no quote is not worth $0, it is
 *     unpriced — hence `null` rather than `0`. Unpriced slots are counted
 *     separately downstream, which is what makes NEED a floor rather than a
 *     fiction.
 */
export function toRequirement(r: RawReqRow): Requirement {
  let marketCents: number | null = null;
  let basis: Requirement['basis'] = null;
  for (const [b, c] of [
    ['market', r.market_cents],
    ['mid', r.mid_cents],
    ['low', r.low_cents],
  ] as const) {
    if (c !== null && c > 0) {
      marketCents = c;
      basis = b;
      break;
    }
  }

  const acqCandidates = [r.direct_cents, r.low_cents, r.market_cents, r.mid_cents].filter(
    (c): c is number => c !== null && c > 0,
  );

  return {
    cardId: r.id,
    variant: r.variant as Variant,
    number: r.number,
    numberSort: r.number_sort,
    name: r.name,
    rarity: r.rarity,
    imageSmall: r.image_small,
    isSecret: r.is_secret === 1,
    marketCents,
    acquisitionCents: acqCandidates.length ? Math.min(...acqCandidates) : null,
    basis,
    observedOn: r.observed_on,
    variantSource: r.variant_source === 'market_data' ? 'market_data' : 'inferred',
  };
}

export function primaryVariantMap(db: DB, setId: string): Map<string, Variant> {
  const rows = db
    .prepare(
      `SELECT v.card_id, v.variant FROM card_variants v
       JOIN cards c ON c.id = v.card_id
       WHERE c.set_id = ? AND v.is_primary = 1`,
    )
    .all(setId) as { card_id: string; variant: string }[];
  return new Map(rows.map((r) => [r.card_id, r.variant as Variant]));
}

export interface SearchHit {
  id: string;
  name: string;
  number: string;
  set_id: string;
  set_name: string;
  rarity: string | null;
  image_small: string | null;
  market_cents: number | null;
}

/** Card search used by quick-add, card show mode and the global search bar. */
export function searchCards(
  db: DB,
  q: string,
  opts: { setId?: string; limit?: number } = {},
): SearchHit[] {
  const limit = Math.min(opts.limit ?? 40, 200);
  const term = q.trim();
  if (!term) return [];

  // "base1 4", "4/102" and bare numbers are how collectors actually search
  // while holding a card, so the number path is handled first and exactly.
  const numMatch = term.match(/^(\d+)\s*(?:\/\s*\d+)?$/);
  const params: unknown[] = [];
  let where: string;

  if (numMatch && opts.setId) {
    where = 'c.set_id = ? AND c.number = ?';
    params.push(opts.setId, numMatch[1]);
  } else if (opts.setId) {
    where = 'c.set_id = ? AND (c.name LIKE ? OR c.number = ?)';
    params.push(opts.setId, `%${term}%`, term);
  } else {
    where = '(c.name LIKE ? OR c.id LIKE ?)';
    params.push(`${term}%`, `${term}%`);
  }

  return db
    .prepare(
      `SELECT c.id, c.name, c.number, c.set_id, s.name AS set_name, c.rarity, c.image_small,
              (SELECT p.market_cents FROM prices p
                WHERE p.card_id = c.id AND p.provider='tcgplayer'
                ORDER BY p.market_cents DESC LIMIT 1) AS market_cents
       FROM cards c JOIN sets s ON s.id = c.set_id
       WHERE ${where}
       ORDER BY (c.name = ?) DESC, s.release_date DESC, c.number_sort
       LIMIT ?`,
    )
    .all(...params, term, limit) as SearchHit[];
}
