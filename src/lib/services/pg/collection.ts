import { withIdentity, type Tx } from '../../db/pg';
import { CONDITION_MULTIPLIER, type Condition } from '../../domain/conditions';

/**
 * Collection reads and writes, in PostgreSQL.
 *
 * Every function opens a transaction bound to the caller's identity, so RLS —
 * not a WHERE clause here — decides what is visible. That is why none of these
 * queries filter on user_id: if one forgot to, the database would still return
 * nothing.
 */

export type HoldingsView = 'all' | 'duplicates' | 'trade' | 'valuable' | 'graded';
export type HoldingsSort = 'value' | 'recent' | 'name' | 'set';

export interface HoldingRow {
  id: string;
  card_id: string;
  variant: string;
  condition: Condition;
  quantity: number;
  paid_cents: number | null;
  for_trade: boolean;
  grade_company: string | null;
  grade_value: string | null;
  name: string;
  number: string;
  image_small: string | null;
  set_id: string;
  set_name: string;
  base_cents: number | null;
}

export interface Holding extends HoldingRow {
  /**
   * Provider-backed market value for the printing, before any adjustment.
   * This is the observed figure and is never modified.
   */
  observedMarketCents: number | null;
  /**
   * Condition-adjusted estimate: observedMarketCents × the band multiplier.
   * A model output, not a quoted price. Null for graded cards, which are not
   * valued at all.
   */
  estimatedValueCents: number | null;
  conditionMultiplier: number;
  conditionAdjusted: boolean;
  isGraded: boolean;
  unvaluedReason: 'graded' | 'unpriced' | null;
}

/**
 * Splits the provider-backed figure from the heuristic adjustment.
 *
 * The observed market value is carried through untouched so a screen can show
 * it as sourced data; the condition multiplier is applied separately and
 * labelled as an estimate. Nothing merges the two into one unattributed number.
 */
export function decorate(r: HoldingRow, applyCondition = true): Holding {
  const isGraded = !!(r.grade_company && r.grade_company.trim() !== '');
  const observed = r.base_cents ?? null;
  const multiplier = CONDITION_MULTIPLIER[r.condition] ?? 1;

  if (isGraded) {
    // Both figures are null, not just the estimate. The raw printing's price is
    // an observation about a different object: a slab and a raw copy trade
    // apart, and SetValue has no graded price source. Carrying the raw number
    // on a graded holding would leave a trap for the next caller that reads it.
    return {
      ...r,
      observedMarketCents: null,
      estimatedValueCents: null,
      conditionMultiplier: 1,
      conditionAdjusted: false,
      isGraded: true,
      unvaluedReason: 'graded',
    };
  }

  const unit = observed === null ? null : applyCondition ? Math.round(observed * multiplier) : observed;
  return {
    ...r,
    observedMarketCents: observed,
    estimatedValueCents: unit === null ? null : unit * r.quantity,
    conditionMultiplier: applyCondition ? multiplier : 1,
    conditionAdjusted: applyCondition && multiplier !== 1,
    isGraded: false,
    unvaluedReason: unit === null ? 'unpriced' : null,
  };
}

const VIEW_CLAUSE: Record<HoldingsView, string> = {
  all: '',
  duplicates: ' and ci.quantity > 1',
  trade: ' and ci.for_trade',
  valuable: ' and public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) >= 1000',
  graded: " and coalesce(ci.grade_company, '') <> ''",
};

const SORT_CLAUSE: Record<HoldingsSort, string> = {
  value: 'public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) desc nulls last, c.name',
  recent: 's.release_date desc nulls last, c.number_sort',
  name: 'c.name, s.release_date desc nulls last',
  set: 's.name, c.number_sort, c.number_suffix',
};

export interface HoldingsPage {
  rows: Holding[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  totalCards: number;
  observedValueCents: number;
  estimatedValueCents: number;
  unpricedCards: number;
  gradedCards: number;
  spareCopies: number;
  spareValueCents: number;
}

/**
 * A page of holdings with totals over the whole filtered set.
 *
 * Both the page and the totals are computed in SQL; nothing streams a whole
 * collection into the application. A 15,000-card collector costs the same as a
 * 50-card one.
 */
export async function listHoldingsPage(
  userId: string,
  query: {
    view?: HoldingsView;
    sort?: HoldingsSort;
    q?: string;
    page?: number;
    pageSize?: number;
    applyCondition?: boolean;
  } = {},
): Promise<HoldingsPage> {
  const view = query.view ?? 'all';
  const sort = query.sort ?? 'value';
  const pageSize = Math.min(Math.max(query.pageSize ?? 100, 10), 200);
  const term = (query.q ?? '').trim();
  const applyCondition = query.applyCondition ?? true;

  return withIdentity(userId, async (tx) => {
    const params: unknown[] = [];
    let search = '';
    if (term) {
      params.push(`%${term}%`, term);
      search = ` and (c.name ilike $1 or s.name ilike $1 or c.number = $2)`;
    }

    const from = `
      from public.collection_items ci
      join public.cards c on c.id = ci.card_id
      join public.sets  s on s.id = c.set_id
      left join public.prices p
             on p.card_id = ci.card_id and p.variant = ci.variant and p.provider = 'tcgplayer'
      where true${search}${VIEW_CLAUSE[view]}`;

    // One pass for every aggregate, including the value totals. The condition
    // multiplier is applied in SQL here purely so the total matches what the
    // rows show; the two components stay separable per row.
    const totals = (await tx.one<{
      matched: number; total_cards: number; graded_cards: number; unpriced_cards: number;
      spare_copies: number; observed_value: number; estimated_value: number; spare_value: number;
    }>(
      `select count(*)::int as matched,
              coalesce(sum(ci.quantity), 0)::int as total_cards,
              coalesce(sum(ci.quantity) filter (where coalesce(ci.grade_company,'') <> ''), 0)::int as graded_cards,
              coalesce(sum(ci.quantity) filter (
                where coalesce(ci.grade_company,'') = ''
                  and public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) is null), 0)::int as unpriced_cards,
              coalesce(sum(greatest(ci.quantity - 1, 0)), 0)::int as spare_copies,
              coalesce(sum(
                case when coalesce(ci.grade_company,'') = ''
                     then public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) * ci.quantity end
              ), 0)::bigint as observed_value,
              coalesce(sum(
                case when coalesce(ci.grade_company,'') = ''
                     then round(public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents)
                                * case ci.condition
                                    when 'NM' then 1.0 when 'LP' then 0.85 when 'MP' then 0.70
                                    when 'HP' then 0.50 else 0.30 end) * ci.quantity end
              ), 0)::bigint as estimated_value,
              coalesce(sum(
                case when coalesce(ci.grade_company,'') = '' and ci.quantity > 1
                     then round(public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents)
                                * case ci.condition
                                    when 'NM' then 1.0 when 'LP' then 0.85 when 'MP' then 0.70
                                    when 'HP' then 0.50 else 0.30 end) * (ci.quantity - 1) end
              ), 0)::bigint as spare_value
       ${from}`,
      params,
    ))!;

    const pageCount = Math.max(1, Math.ceil(totals.matched / pageSize));
    const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);

    const rows = await tx.rows<HoldingRow>(
      `select ci.id, ci.card_id, ci.variant, ci.condition, ci.quantity, ci.paid_cents,
              ci.for_trade, ci.grade_company, ci.grade_value,
              c.name, c.number, c.image_small, c.set_id, s.name as set_name,
              public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) as base_cents
       ${from}
       order by ${SORT_CLAUSE[sort]}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return {
      rows: rows.map((r) => decorate(r, applyCondition)),
      total: totals.matched,
      page,
      pageSize,
      pageCount,
      totalCards: totals.total_cards,
      observedValueCents: totals.observed_value,
      estimatedValueCents: applyCondition ? totals.estimated_value : totals.observed_value,
      unpricedCards: totals.unpriced_cards,
      gradedCards: totals.graded_cards,
      spareCopies: totals.spare_copies,
      spareValueCents: totals.spare_value,
    };
  });
}

export interface PortfolioSummary {
  totalCards: number;
  uniqueCards: number;
  observedValueCents: number;
  estimatedValueCents: number;
  pricedCards: number;
  unpricedCards: number;
  gradedCards: number;
  costBasisCents: number;
  cardsWithCost: number;
  gainCents: number | null;
  duplicateCopies: number;
  setsTouched: number;
}

export async function portfolioSummary(userId: string): Promise<PortfolioSummary> {
  return withIdentity(userId, async (tx) => {
    const r = (await tx.one<Record<string, number>>(
      `select
         coalesce(sum(ci.quantity), 0)::int as total_cards,
         count(*)::int as unique_cards,
         coalesce(sum(case when coalesce(ci.grade_company,'') = ''
                      then public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) * ci.quantity end), 0)::bigint as observed_value,
         coalesce(sum(case when coalesce(ci.grade_company,'') = ''
                      then round(public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents)
                           * case ci.condition when 'NM' then 1.0 when 'LP' then 0.85 when 'MP' then 0.70
                                               when 'HP' then 0.50 else 0.30 end) * ci.quantity end), 0)::bigint as estimated_value,
         coalesce(sum(ci.quantity) filter (where coalesce(ci.grade_company,'') = ''
                      and public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) is not null), 0)::int as priced_cards,
         coalesce(sum(ci.quantity) filter (where coalesce(ci.grade_company,'') = ''
                      and public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) is null), 0)::int as unpriced_cards,
         coalesce(sum(ci.quantity) filter (where coalesce(ci.grade_company,'') <> ''), 0)::int as graded_cards,
         coalesce(sum(ci.paid_cents * ci.quantity) filter (where ci.paid_cents is not null), 0)::bigint as cost_basis,
         coalesce(sum(ci.quantity) filter (where ci.paid_cents is not null), 0)::int as cards_with_cost,
         coalesce(sum(case when ci.paid_cents is not null and coalesce(ci.grade_company,'') = ''
                      then round(public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents)
                           * case ci.condition when 'NM' then 1.0 when 'LP' then 0.85 when 'MP' then 0.70
                                               when 'HP' then 0.50 else 0.30 end) * ci.quantity end), 0)::bigint as cost_value,
         coalesce(sum(greatest(ci.quantity - 1, 0)), 0)::int as duplicate_copies,
         count(distinct c.set_id)::int as sets_touched
       from public.collection_items ci
       join public.cards c on c.id = ci.card_id
       left join public.prices p
              on p.card_id = ci.card_id and p.variant = ci.variant and p.provider='tcgplayer'`,
    ))!;

    return {
      totalCards: r.total_cards,
      uniqueCards: r.unique_cards,
      observedValueCents: r.observed_value,
      estimatedValueCents: r.estimated_value,
      pricedCards: r.priced_cards,
      unpricedCards: r.unpriced_cards,
      gradedCards: r.graded_cards,
      costBasisCents: r.cost_basis,
      cardsWithCost: r.cards_with_cost,
      gainCents: r.cards_with_cost > 0 ? r.cost_value - r.cost_basis : null,
      duplicateCopies: r.duplicate_copies,
      setsTouched: r.sets_touched,
    };
  });
}

export interface AddInput {
  // A stored printing token: a base finish, or `finish__treatment` (migration
  // 0021). The database is authoritative for which tokens a given card has.
  cardId: string;
  variant: string;
  quantity?: number;
  condition?: Condition;
  paidCents?: number | null;
  acquiredOn?: string | null;
  sourceNote?: string | null;
  gradeCompany?: string | null;
  gradeValue?: string | null;
}

export async function addToCollection(userId: string, input: AddInput) {
  return withIdentity(userId, async (tx) => {
    // Authoritative check: only a printing the catalog actually lists for this
    // card can be owned. This is what keeps the ownership layer from ever
    // falling behind the identity model — no second hardcoded allow-list.
    const exists = await tx.one<{ ok: boolean }>(
      `select exists(select 1 from public.card_variants where card_id = $1 and variant = $2) as ok`,
      [input.cardId, input.variant],
    );
    if (!exists?.ok) throw new Error('unknown printing for this card');
    return addWithin(tx, input);
  });
}

/** Add inside an existing transaction — used by the bulk import path. */
export async function addWithin(tx: Tx, input: AddInput) {
  return (await tx.one<{ item_id: string; quantity: number; set_id: string; first_copy: boolean }>(
    `select * from public.add_to_collection($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.cardId, input.variant, input.quantity ?? 1, input.condition ?? 'NM',
      input.paidCents ?? null, input.acquiredOn ?? null, input.sourceNote ?? null,
      input.gradeCompany ?? null, input.gradeValue ?? null,
    ],
  ))!;
}

export async function removeFromCollection(
  userId: string,
  input: { cardId: string; variant: string; quantity?: number; condition?: Condition },
) {
  return withIdentity(userId, async (tx) =>
    (await tx.one<{ remaining: number; set_id: string }>(
      `select * from public.remove_from_collection($1,$2,$3,$4)`,
      [input.cardId, input.variant, input.quantity ?? 1, input.condition ?? null],
    ))!,
  );
}

export async function updateItem(
  userId: string,
  itemId: string,
  patch: { quantity?: number; condition?: Condition; paidCents?: number | null; forTrade?: boolean },
): Promise<boolean> {
  return withIdentity(userId, async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.quantity !== undefined) { params.push(patch.quantity); sets.push(`quantity = $${params.length}`); }
    if (patch.condition !== undefined) { params.push(patch.condition); sets.push(`condition = $${params.length}`); }
    if (patch.paidCents !== undefined) { params.push(patch.paidCents); sets.push(`paid_cents = $${params.length}`); }
    if (patch.forTrade !== undefined) { params.push(patch.forTrade); sets.push(`for_trade = $${params.length}`); }
    if (!sets.length) return false;

    params.push(itemId);
    // RLS scopes this to the caller: another collector's id simply matches
    // nothing, and the caller is told so rather than handed a false success.
    const n = await tx.exec(
      `update public.collection_items set ${sets.join(', ')}, updated_at = now()
       where id = $${params.length}::uuid`,
      params,
    );
    await tx.exec('delete from public.collection_items where id = $1::uuid and quantity <= 0', [itemId]);
    return n > 0;
  });
}
