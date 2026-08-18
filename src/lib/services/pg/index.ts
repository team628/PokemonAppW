import { withIdentity, withServiceRole } from '../../db/pg';
import type { GoalMode } from '../../domain/goals';
import { computeMoves, type DupeInput, type Move, type PriceDropInput, type TradeMatchInput } from '../../domain/nextBestMove';
import { milestonesFor, type MilestoneKind } from '../../domain/goals';
import { CONDITION_MULTIPLIER } from '../../domain/conditions';
import type { Variant } from '../../catalog/variants';

/**
 * Read models and orchestration on PostgreSQL.
 *
 * Everything user-scoped runs under the caller's identity so RLS is the
 * boundary; the aggregates live in SQL functions (see migration 0004/0005) so
 * no request performs work proportional to the number of collectors.
 */

// ------------------------------------------------------------------ goals ---

export interface GoalView {
  goalId: string;
  setId: string;
  setName: string;
  series: string;
  logoUrl: string | null;
  symbolUrl: string | null;
  releaseDate: string | null;
  printedTotal: number;
  mode: GoalMode;
  pinned: boolean;
  completedAt: string | null;
  requiredCount: number;
  ownedCount: number;
  missingCount: number;
  haveCents: number;
  needCents: number;
  completeCents: number;
  needAcquisitionCents: number;
  pricedMissing: number;
  unpricedMissing: number;
  oldestObservation: string | null;
  marketDataSlots: number;
  percent: number;
  needIsFloor: boolean;
  variantConfidence: number;
}

interface GoalRow {
  goal_id: string; set_id: string; set_name: string; series: string;
  logo_url: string | null; symbol_url: string | null; release_date: string | null;
  printed_total: number; mode: GoalMode; pinned: boolean; completed_at: string | null;
  required_count: number; owned_count: number; missing_count: number;
  have_cents: number; need_cents: number; complete_cents: number;
  need_acquisition_cents: number; priced_missing: number; unpriced_missing: number;
  oldest_observation: string | null; market_data_slots: number;
}

const toGoalView = (r: GoalRow): GoalView => ({
  goalId: r.goal_id,
  setId: r.set_id,
  setName: r.set_name,
  series: r.series,
  logoUrl: r.logo_url,
  symbolUrl: r.symbol_url,
  releaseDate: r.release_date,
  printedTotal: r.printed_total,
  mode: r.mode,
  pinned: r.pinned,
  completedAt: r.completed_at,
  requiredCount: r.required_count,
  ownedCount: r.owned_count,
  missingCount: r.missing_count,
  haveCents: r.have_cents,
  needCents: r.need_cents,
  completeCents: r.complete_cents,
  needAcquisitionCents: r.need_acquisition_cents,
  pricedMissing: r.priced_missing,
  unpricedMissing: r.unpriced_missing,
  oldestObservation: r.oldest_observation,
  marketDataSlots: r.market_data_slots,
  percent: r.required_count ? r.owned_count / r.required_count : 0,
  needIsFloor: r.unpriced_missing > 0,
  variantConfidence: r.required_count ? r.market_data_slots / r.required_count : 1,
});

export async function myGoals(userId: string): Promise<GoalView[]> {
  return withIdentity(userId, async (tx) =>
    (await tx.rows<GoalRow>('select * from public.my_goals()')).map(toGoalView),
  );
}

export async function goalMetrics(userId: string, setId: string, mode: GoalMode) {
  return withIdentity(userId, async (tx) =>
    (await tx.one<Omit<GoalRow, 'goal_id' | 'set_id' | 'set_name' | 'series' | 'logo_url' | 'symbol_url' | 'release_date' | 'printed_total' | 'mode' | 'pinned' | 'completed_at'>>(
      'select * from public.goal_metrics($1, $2)',
      [setId, mode],
    ))!,
  );
}

export async function addGoal(userId: string, setId: string, mode: GoalMode): Promise<string> {
  return withIdentity(userId, async (tx) => {
    const row = await tx.one<{ id: string }>(
      `insert into public.set_goals (user_id, set_id, mode) values ($1::uuid, $2, $3)
       on conflict (user_id, set_id, mode) do update set set_id = excluded.set_id
       returning id`,
      [userId, setId, mode],
    );
    await tx.exec(
      `insert into public.collection_events (user_id, type, set_id, payload)
       values ($1::uuid, 'goal_added', $2, jsonb_build_object('mode', $3::text))`,
      [userId, setId, mode],
    );
    return row!.id;
  });
}

export async function removeGoal(userId: string, goalId: string): Promise<void> {
  await withIdentity(userId, (tx) =>
    tx.exec('delete from public.set_goals where id = $1::uuid', [goalId]),
  );
}

export async function togglePin(userId: string, goalId: string): Promise<void> {
  await withIdentity(userId, (tx) =>
    tx.exec('update public.set_goals set pinned = not pinned where id = $1::uuid', [goalId]),
  );
}

// ------------------------------------------------------------- milestones ---

export interface MilestoneRow {
  goal_id: string;
  kind: MilestoneKind;
  achieved_at: string;
  set_id: string;
  set_name: string;
  series: string | null;
  logo_url: string | null;
  mode: GoalMode;
  completed_at: string | null;
  collector: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Records any milestone newly reached for the sets a change touched.
 *
 * Write-once by primary key: a collection that dips below a threshold and
 * climbs back does not re-fire the moment.
 */
export async function syncMilestonesForSet(userId: string, setId: string): Promise<MilestoneKind[]> {
  return withIdentity(userId, async (tx) => {
    const goals = await tx.rows<{ id: string; mode: GoalMode }>(
      'select id, mode from public.set_goals where set_id = $1',
      [setId],
    );
    const fired: MilestoneKind[] = [];

    for (const g of goals) {
      const m = (await tx.one<{
        required_count: number; owned_count: number; missing_count: number;
        have_cents: number; need_cents: number; complete_cents: number;
      }>('select * from public.goal_metrics($1, $2)', [setId, g.mode]))!;

      const reached = milestonesFor({
        mode: g.mode,
        requiredCount: m.required_count,
        ownedCount: m.owned_count,
        missingCount: m.missing_count,
        percent: m.required_count ? m.owned_count / m.required_count : 0,
        haveCents: m.have_cents,
        needCents: m.need_cents,
        completeCents: m.complete_cents,
        needAcquisitionCents: 0,
        pricedOwned: 0, unpricedOwned: 0, pricedMissing: 0, unpricedMissing: 0,
        needIsFloor: false, oldestObservation: null, variantConfidence: 1,
        missing: [], owned: [],
      });

      for (const kind of reached) {
        const n = await tx.exec(
          `insert into public.milestones (user_id, goal_id, kind, payload)
           values ($1::uuid, $2::uuid, $3, $4::jsonb) on conflict do nothing`,
          [userId, g.id, kind,
           JSON.stringify({ setId, mode: g.mode, ownedCount: m.owned_count,
                            requiredCount: m.required_count, completeCents: m.complete_cents })],
        );
        if (n > 0) fired.push(kind);
      }

      await tx.exec('select public.refresh_goal_metrics($1::uuid)', [g.id]);
    }
    return fired;
  });
}

export async function unseenMilestones(userId: string): Promise<MilestoneRow[]> {
  return withIdentity(userId, (tx) =>
    tx.rows<MilestoneRow>(
      // Enough set identity to draw a completion card without a second read:
      // a finished set has to be nameable out of context.
      `select m.goal_id, m.kind, m.achieved_at::text, m.payload,
              s.id as set_id, s.name as set_name, s.series, s.logo_url,
              g.mode::text, g.completed_at::text,
              (select display_name from public.profiles p where p.id = g.user_id) as collector
       from public.milestones m
       join public.set_goals g on g.id = m.goal_id
       join public.sets s on s.id = g.set_id
       where not m.seen
       -- Significance first, then recency. A set finishing fires eight
       -- milestones in the same instant, and a plain "newest five" ordering
       -- could drop the completion — the one moment that must never be lost —
       -- because the timestamps tie.
       order by case m.kind
                  when 'complete' then 0
                  when 'one_left' then 1
                  when 'final_five' then 2
                  else 3
                end,
                m.achieved_at desc
       limit 5`,
    ),
  );
}

export async function markMilestonesSeen(userId: string): Promise<void> {
  await withIdentity(userId, (tx) =>
    tx.exec('update public.milestones set seen = true where not seen'),
  );
}

// ---------------------------------------------------------------- insights --

/** One card the caller holds spare that the counterpart is missing. */
export interface ReciprocalCard {
  cardId: string;
  name: string;
  number: string;
  imageSmall: string | null;
  valueCents: number | null;
}

export type TradeMatch = TradeMatchInput & {
  spareCopies: number;
  /** Null when the match only runs one way. */
  theirs: ReciprocalCard | null;
};

export interface Insights {
  goals: GoalView[];
  moves: Move[];
  trades: TradeMatch[];
  dupes: DupeInput[];
  drops: PriceDropInput[];
  historyTooShallow: boolean;
  /**
   * The missing printings behind each goal, keyed by goal id, already loaded
   * for the move engine. Exposed so callers that want to *show* those cards —
   * the dashboard rail, for one — read the list that is already in memory
   * instead of asking the database the same question a second time.
   */
  missingByGoal: Map<string, MissingSlot[]>;
}

export type MissingSlot = Awaited<ReturnType<typeof loadMissing>>[number];

/**
 * Everything the dashboard, the move engine and the trade screen need.
 *
 * The reads fall into three groups that do not depend on one another, so they
 * run as three concurrent transactions rather than one serial one. Each opens
 * its own connection and sets its own identity, so RLS is applied exactly as it
 * would be for a single-statement read — the parallelism is in the client, not
 * in the authorization model.
 *
 *   A. the goals, then the missing printings behind them (ordered: the missing
 *      query is driven by the goal rows)
 *   B. spare copies, real price movement, and whether any history exists to
 *      compare against
 *   C. cross-collector trade matches, the one audited SECURITY DEFINER read
 *
 * Nothing in B or C needs a value from A. The old code ran all of it in one
 * transaction, so the page waited for the sum; it now waits for the slowest.
 */
export async function buildInsights(userId: string, budgetCents?: number | null): Promise<Insights> {
  const [{ goals, missingByGoal }, { dupes, drops, shallow }, trades] = await Promise.all([
    loadGoalsAndMissing(userId),
    loadMarketContext(userId),
    withIdentity(userId, (tx) => loadTradeMatches(tx)),
  ]);

  const moves = computeMoves({
    goals: goals
      .filter((g) => g.missingCount > 0)
      .map((g) => ({
        goalId: g.goalId,
        setId: g.setId,
        setName: g.setName,
        mode: g.mode,
        metrics: {
          mode: g.mode,
          requiredCount: g.requiredCount,
          ownedCount: g.ownedCount,
          missingCount: g.missingCount,
          percent: g.percent,
          haveCents: g.haveCents,
          needCents: g.needCents,
          completeCents: g.completeCents,
          needAcquisitionCents: g.needAcquisitionCents,
          pricedOwned: 0,
          unpricedOwned: 0,
          pricedMissing: g.pricedMissing,
          unpricedMissing: g.unpricedMissing,
          needIsFloor: g.needIsFloor,
          oldestObservation: g.oldestObservation,
          variantConfidence: g.variantConfidence,
          missing: missingByGoal.get(g.goalId) ?? [],
          owned: [],
        },
      })),
    dupes,
    tradeMatches: trades,
    priceDrops: drops,
    budgetCents,
  });

  return { goals, moves, trades, dupes, drops, historyTooShallow: shallow, missingByGoal };
}

/**
 * The tracked sets and, in one further round trip, every printing still missing
 * from each of them.
 *
 * The missing lists used to be fetched one query per goal. A collector chasing
 * eight sets paid eight round trips for a question the database can answer in
 * one lateral — the per-goal cap still applies inside the lateral, so the
 * result is row-for-row identical.
 */
async function loadGoalsAndMissing(userId: string) {
  return withIdentity(userId, async (tx) => {
    const goals = (await tx.rows<GoalRow>('select * from public.my_goals()')).map(toGoalView);
    const missingByGoal = new Map<string, MissingSlot[]>();
    if (goals.some((g) => g.missingCount > 0)) {
      for (const row of await loadMissing(tx)) {
        const list = missingByGoal.get(row.goalId);
        if (list) list.push(row);
        else missingByGoal.set(row.goalId, [row]);
      }
    }
    return { goals, missingByGoal };
  });
}

/** Spares, observed price movement, and whether any history exists at all. */
async function loadMarketContext(userId: string) {
  return withIdentity(userId, async (tx) => {
    const dupes = (await tx.rows<{
      card_id: string; variant: string; name: string; number: string;
      image_small: string | null; spare: number; base_cents: number | null; condition: keyof typeof CONDITION_MULTIPLIER;
    }>(
      `select ci.card_id, ci.variant, c.name, c.number, c.image_small,
              (ci.quantity - 1)::int as spare, ci.condition,
              public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) as base_cents
       from public.collection_items ci
       join public.cards c on c.id = ci.card_id
       left join public.prices p on p.card_id = ci.card_id and p.variant = ci.variant and p.provider='tcgplayer'
       where ci.quantity > 1 and coalesce(ci.grade_company,'') = ''
       order by base_cents desc nulls last limit 500`,
    )).map((d) => ({
      cardId: d.card_id, name: d.name, number: d.number, variant: d.variant,
      imageSmall: d.image_small, spareCopies: d.spare,
      unitValueCents: d.base_cents === null ? null
        : Math.round(d.base_cents * (CONDITION_MULTIPLIER[d.condition] ?? 1)),
    }));

    const drops = await loadPriceDrops(tx);

    const shallow = (await tx.one<{ comparable: boolean }>(
      `select exists (
         select 1 from public.price_points where provider = 'tcgplayer'
         group by card_id, variant having count(distinct observed_on) > 1
       ) as comparable`,
    ))!.comparable !== true;

    return { dupes, drops, shallow };
  });
}

/**
 * Every printing still missing from every goal the caller tracks, in one query.
 *
 * The per-goal cap lives inside the lateral, so each goal contributes at most
 * the same 2,000 rows the per-goal call returned, in the same order. `set_goals`
 * is owner-scoped by RLS, so the lateral can only ever expand the caller's own
 * goals.
 */
async function loadMissing(tx: { rows: <T>(s: string, p?: readonly unknown[]) => Promise<T[]> }) {
  const rows = await tx.rows<{
    goal_id: string;
    card_id: string; variant: string; number: string; number_sort: number; name: string;
    rarity: string | null; image_small: string | null; market_cents: number | null;
    acquisition_cents: number | null; basis: string | null; observed_on: string | null;
    variant_source: 'market_data' | 'inferred';
  }>(
    `select g.id as goal_id, m.*
     from public.set_goals g
     cross join lateral public.goal_missing(g.set_id, g.mode, 2000, 0) m
     where g.user_id = auth.uid()`,
  );

  return rows.map((r) => ({
    goalId: r.goal_id,
    cardId: r.card_id,
    variant: r.variant as Variant,
    number: r.number,
    numberSort: r.number_sort,
    name: r.name,
    rarity: r.rarity,
    imageSmall: r.image_small,
    isSecret: false,
    marketCents: r.market_cents,
    acquisitionCents: r.acquisition_cents,
    basis: r.basis as 'market' | 'mid' | 'low' | null,
    observedOn: r.observed_on,
    variantSource: r.variant_source,
  }));
}

/**
 * Trade matches: other collectors' spare copies that fill this collector's
 * holes.
 *
 * Goes through `public.trade_matches()` because `collection_items` is
 * owner-only under RLS — a plain query here returns nothing at all. That
 * function is the single audited cross-collector read: opt-in rows only,
 * narrowed to the caller's own missing printings, projecting card identity and
 * a public handle and nothing else. See migration 0009.
 */
async function loadTradeMatches(
  tx: { rows: <T>(s: string, p?: readonly unknown[]) => Promise<T[]> },
) {
  return (await tx.rows<{
    card_id: string; variant: string; name: string; number: string;
    image_small: string | null; market_cents: number | null;
    handle: string | null; display_name: string | null; spare_copies: number; mutual: boolean;
    my_card_id: string | null; my_name: string | null; my_number: string | null;
    my_image_small: string | null; my_market_cents: number | null;
  }>('select * from public.trade_matches($1)', [60])).map((r) => ({
    cardId: r.card_id,
    name: r.name,
    number: r.number,
    variant: r.variant,
    imageSmall: r.image_small,
    valueCents: r.market_cents,
    counterpartHandle: r.handle ?? 'a collector',
    counterpartDisplayName: r.display_name ?? 'A collector',
    mutual: r.mutual,
    spareCopies: r.spare_copies,
    // The card of mine that fills a hole for them — the other half of the trade.
    theirs: r.my_card_id
      ? {
          cardId: r.my_card_id,
          name: r.my_name ?? '',
          number: r.my_number ?? '',
          imageSmall: r.my_image_small,
          valueCents: r.my_market_cents,
        }
      : null,
  }));
}

/** Real, observed price movement — two dated readings of the same printing. */
async function loadPriceDrops(
  tx: { rows: <T>(s: string, p?: readonly unknown[]) => Promise<T[]> },
): Promise<PriceDropInput[]> {
  return (await tx.rows<{
    card_id: string; variant: string; name: string; number: string; set_id: string;
    image_small: string | null; current_cents: number; previous_cents: number;
    current_on: string; previous_on: string;
  }>(
    // The previous reading comes from `lead()` over the same window rather than
    // a second pass joined back to the first. The self-join was quadratic in the
    // number of missing printings — 1,265 open holes meant 1.6M row comparisons
    // — and produced exactly the row this does.
    `with missing as (
       select distinct s.card_id, s.variant, g.set_id
       from public.set_goals g
       cross join lateral public.goal_required_slots(g.set_id, g.mode) s
       where g.user_id = auth.uid()
         and not exists (
           select 1 from public.collection_items ci
           where ci.user_id = auth.uid() and ci.card_id = s.card_id
             and ci.variant = s.variant and ci.quantity > 0)
     ),
     ranked as (
       select pp.card_id, pp.variant, pp.observed_on, pp.market_cents,
              row_number() over w as rn,
              lead(pp.market_cents) over w as previous_cents,
              lead(pp.observed_on) over w as previous_on
       from public.price_points pp
       join missing m on m.card_id = pp.card_id and m.variant = pp.variant
       where pp.provider = 'tcgplayer' and pp.market_cents is not null
       window w as (partition by pp.card_id, pp.variant order by pp.observed_on desc)
     )
     select cur.card_id, cur.variant, c.name, c.number, m.set_id, c.image_small,
            cur.market_cents as current_cents, cur.previous_cents as previous_cents,
            cur.observed_on::text as current_on, cur.previous_on::text as previous_on
     from ranked cur
     join missing m on m.card_id = cur.card_id and m.variant = cur.variant
     join public.cards c on c.id = cur.card_id
     where cur.rn = 1 and cur.previous_cents > 0
       and (cur.previous_cents - cur.market_cents)::numeric / cur.previous_cents >= 0.10
     order by (cur.previous_cents - cur.market_cents) desc
     limit 12`,
  )).map((r) => ({
    cardId: r.card_id,
    name: r.name,
    number: r.number,
    variant: r.variant,
    setId: r.set_id,
    imageSmall: r.image_small,
    currentCents: r.current_cents,
    previousCents: r.previous_cents,
    currentOn: r.current_on,
    previousOn: r.previous_on,
  }));
}

// ---------------------------------------------------------------- catalog ---

export async function listSets(userId: string | null) {
  return withIdentity(userId, (tx) =>
    tx.rows<{
      id: string; name: string; series: string; release_date: string | null;
      printed_total: number; total: number; logo_url: string | null; symbol_url: string | null;
      main_set_cents: number; owned_cards: number; tracked_mode: string | null;
    }>(
      `select s.id, s.name, s.series, s.release_date::text, s.printed_total, s.total,
              s.logo_url, s.symbol_url,
              coalesce(v.cents, 0)::bigint as main_set_cents,
              coalesce(o.owned, 0)::int as owned_cards,
              g.mode::text as tracked_mode
       from public.sets s
       left join (
         select c.set_id, sum(public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents)) as cents
         from public.cards c
         join public.card_variants cv on cv.card_id = c.id and cv.is_primary
         left join public.prices p on p.card_id = c.id and p.variant = cv.variant and p.provider='tcgplayer'
         where not c.is_secret group by c.set_id
       ) v on v.set_id = s.id
       left join (
         select c.set_id, count(distinct ci.card_id) as owned
         from public.collection_items ci join public.cards c on c.id = ci.card_id
         group by c.set_id
       ) o on o.set_id = s.id
       left join public.set_goals g on g.set_id = s.id and g.user_id = auth.uid()
       order by s.release_date desc nulls last, s.name`,
    ),
  );
}

export async function searchCards(userId: string | null, q: string, setId?: string, limit = 30) {
  const term = q.trim();
  if (!term) return [];
  return withIdentity(userId, (tx) => {
    const numeric = /^\d+$/.test(term);
    if (setId && numeric) {
      return tx.rows(
        `select c.id, c.name, c.number, c.set_id, s.name as set_name, c.rarity, c.image_small,
                public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) as market_cents
         from public.cards c join public.sets s on s.id = c.set_id
         left join public.prices p on p.card_id=c.id and p.provider='tcgplayer'
         where c.set_id = $1 and c.number = $2 limit $3`,
        [setId, term, limit],
      );
    }
    return tx.rows(
      `select c.id, c.name, c.number, c.set_id, s.name as set_name, c.rarity, c.image_small,
              public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) as market_cents
       from public.cards c join public.sets s on s.id = c.set_id
       left join public.prices p on p.card_id=c.id and p.provider='tcgplayer'
       where ${setId ? 'c.set_id = $3 and ' : ''}lower(c.name) like lower($1)
       order by s.release_date desc nulls last, c.number_sort limit $2`,
      setId ? [`${term}%`, limit, setId] : [`${term}%`, limit],
    );
  });
}

// --------------------------------------------------------------- partners ---

export async function demandReport(limit = 60, setId?: string) {
  return withIdentity(null, (tx) =>
    tx.rows<{
      card_id: string; variant: string; collectors: number; market_cents: number | null;
      name: string; number: string; rarity: string | null; image_small: string | null;
      set_id: string; set_name: string;
    }>('select * from public.demand_report($1, $2)', [limit, setId ?? null]),
  );
}

export async function demandMeta() {
  return withIdentity(null, async (tx) => ({
    meta: await tx.one<{ rebuilt_at: string | null; duration_ms: number | null; open_wants: number; total_demand: number }>(
      'select rebuilt_at::text, duration_ms, open_wants, total_demand from public.want_index_meta where id',
    ),
    live: await tx.one<{ open_wants: number; total_demand: number; demand_value: number }>(
      `select count(*)::int as open_wants,
              coalesce(sum(w.collectors),0)::bigint as total_demand,
              coalesce(sum(w.collectors * public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents)),0)::bigint as demand_value
       from public.want_index w
       left join public.prices p on p.card_id=w.card_id and p.variant=w.variant and p.provider='tcgplayer'
       where w.collectors > 0`,
    ),
  }));
}

/**
 * Population totals for the partner console.
 *
 * Read under service_role rather than as an anonymous visitor. `profiles` and
 * `set_goals` are owner-scoped by RLS — correctly, since neither should be
 * browsable — so an anonymous count returns zero, and printing "0 collectors"
 * next to seven figures of demand would be a wrong number, not a private one.
 *
 * What crosses the boundary is two integers: how many collectors exist and how
 * many set goals exist. No row, id, handle or holding is read, and nothing here
 * is attributable to anybody. The RLS policies themselves are untouched.
 */
/**
 * How many collectors exist, and how many set goals they are chasing.
 *
 * `profiles` and `set_goals` are owner-scoped under RLS, so an anonymous read
 * of either correctly returns nothing — which is why the partner console
 * reported zero collectors when it counted them directly. The fix is not to
 * hand this code path the service role: that grants a whole region of
 * TypeScript an RLS bypass in order to answer two integers, and every future
 * edit inside it inherits the bypass.
 *
 * `public.demand_population()` is the narrower instrument. It is SECURITY
 * DEFINER, it takes no arguments, and it returns two counts — there is no
 * parameter for a caller to steer towards an individual, and no row of anyone's
 * data crosses the boundary. See migration 0013.
 */
export async function demandPopulation(): Promise<{ collectors: number; tracked: number }> {
  return withIdentity(null, async (tx) =>
    (await tx.one<{ collectors: number; tracked: number }>(
      'select collectors, tracked from public.demand_population()',
    ))!,
  );
}

export async function rebuildWantIndex() {
  return withServiceRole(async (tx) =>
    (await tx.one<{ open_wants: number; total_demand: number; duration_ms: number }>(
      'select * from public.rebuild_want_index()',
    ))!,
  );
}

// ------------------------------------------------------------ rate limits ---

export async function consumeRateLimit(bucket: string, limit: number, windowSeconds: number) {
  return withIdentity(null, async (tx) =>
    (await tx.one<{ allowed: boolean; hits: number; retry_after_seconds: number }>(
      'select * from public.consume_rate_limit($1, $2, $3)',
      [bucket, limit, windowSeconds],
    ))!,
  );
}

export const RULES = {
  signIn: { limit: 10, windowSeconds: 300 },
  signUp: { limit: 5, windowSeconds: 3600 },
  importCommit: { limit: 10, windowSeconds: 3600 },
  publicPage: { limit: 60, windowSeconds: 60 },
} as const;
