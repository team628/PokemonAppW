-- The completion engine, in the database.
--
-- HAVE, NEED and COMPLETE are computed here rather than by fetching rows into
-- JavaScript. The arithmetic identity the whole product rests on
--
--     COMPLETE = HAVE + NEED
--
-- holds by construction: both sides are summed from the same per-slot value in
-- the same pass, in integer cents, so it is exact rather than approximately
-- equal. `bigint` accumulators avoid any overflow on a master set of expensive
-- cards.
--
-- The goal-mode predicate must stay in lockstep with `requirementsForMode` in
-- src/lib/domain/goals.ts. tests/pg/parity.test.ts asserts the two agree.

-- Market → mid → low ladder. Zero and negative figures are not prices.
create or replace function public.slot_market_cents(
  p_market integer, p_mid integer, p_low integer
) returns integer
language sql immutable parallel safe
as $$
  select case
    when p_market is not null and p_market > 0 then p_market
    when p_mid    is not null and p_mid    > 0 then p_mid
    when p_low    is not null and p_low    > 0 then p_low
  end
$$;

-- Cheapest credible acquisition route.
create or replace function public.slot_acquisition_cents(
  p_direct integer, p_low integer, p_market integer, p_mid integer
) returns integer
language sql immutable parallel safe
as $$
  select min(v) from unnest(array[p_direct, p_low, p_market, p_mid]) as v
  where v is not null and v > 0
$$;

-- Which basis produced the market figure, for provenance in the UI.
create or replace function public.slot_basis(
  p_market integer, p_mid integer, p_low integer
) returns text
language sql immutable parallel safe
as $$
  select case
    when p_market is not null and p_market > 0 then 'market'
    when p_mid    is not null and p_mid    > 0 then 'mid'
    when p_low    is not null and p_low    > 0 then 'low'
  end
$$;

-- Every (card, printing) slot a goal mode requires, with its USD market data.
-- Single definition of "what this slot is worth" for the whole product.
create or replace function public.set_requirements(p_set_id text, p_mode public.goal_mode)
returns table (
  card_id text,
  variant text,
  number text,
  number_sort integer,
  number_suffix text,
  name text,
  rarity text,
  image_small text,
  is_secret boolean,
  variant_source public.variant_source,
  market_cents integer,
  acquisition_cents integer,
  basis text,
  observed_on date
)
language sql stable parallel safe
as $$
  select
    c.id, v.variant, c.number, c.number_sort, c.number_suffix, c.name, c.rarity,
    c.image_small, c.is_secret, v.source,
    public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents),
    public.slot_acquisition_cents(p.direct_cents, p.low_cents, p.market_cents, p.mid_cents),
    public.slot_basis(p.market_cents, p.mid_cents, p.low_cents),
    p.observed_on
  from public.cards c
  join public.card_variants v on v.card_id = c.id
  left join public.prices p
         on p.card_id = c.id and p.variant = v.variant and p.provider = 'tcgplayer'
  where c.set_id = p_set_id
    and (
      p_mode = 'master'
      or (v.is_primary and (p_mode = 'complete' or not c.is_secret))
    )
$$;

-- Metrics for one goal, for the calling user.
--
-- SECURITY INVOKER: ownership is resolved through RLS on collection_items, so
-- this cannot be used to read another collector's progress even if called
-- directly over PostgREST.
create or replace function public.goal_metrics(p_set_id text, p_mode public.goal_mode)
returns table (
  required_count integer,
  owned_count integer,
  missing_count integer,
  have_cents bigint,
  need_cents bigint,
  complete_cents bigint,
  need_acquisition_cents bigint,
  priced_owned integer,
  priced_missing integer,
  unpriced_missing integer,
  oldest_observation date,
  market_data_slots integer
)
language sql stable security invoker
as $$
  with req as (
    select r.*,
           exists (
             select 1 from public.collection_items ci
             where ci.card_id = r.card_id
               and ci.variant = r.variant
               and ci.quantity > 0
           ) as owned
    from public.set_requirements(p_set_id, p_mode) r
  )
  select
    count(*)::int,
    count(*) filter (where owned)::int,
    count(*) filter (where not owned)::int,
    coalesce(sum(market_cents) filter (where owned), 0)::bigint,
    coalesce(sum(market_cents) filter (where not owned), 0)::bigint,
    coalesce(sum(market_cents), 0)::bigint,
    coalesce(sum(acquisition_cents) filter (where not owned), 0)::bigint,
    count(*) filter (where owned and market_cents is not null)::int,
    count(*) filter (where not owned and market_cents is not null)::int,
    count(*) filter (where not owned and market_cents is null)::int,
    min(observed_on),
    count(*) filter (where variant_source = 'market_data')::int
  from req
$$;

-- The missing list — the same rows NEED is summed from, so the list and the
-- number can never disagree. Paged in SQL.
create or replace function public.goal_missing(
  p_set_id text,
  p_mode public.goal_mode,
  p_limit integer default 500,
  p_offset integer default 0
)
returns table (
  card_id text,
  variant text,
  number text,
  number_sort integer,
  name text,
  rarity text,
  image_small text,
  market_cents integer,
  acquisition_cents integer,
  basis text,
  observed_on date,
  variant_source public.variant_source
)
language sql stable security invoker
as $$
  select r.card_id, r.variant, r.number, r.number_sort, r.name, r.rarity, r.image_small,
         r.market_cents, r.acquisition_cents, r.basis, r.observed_on, r.variant_source
  from public.set_requirements(p_set_id, p_mode) r
  where not exists (
    select 1 from public.collection_items ci
    where ci.card_id = r.card_id and ci.variant = r.variant and ci.quantity > 0
  )
  order by r.number_sort, r.number_suffix, r.variant
  limit least(greatest(p_limit, 1), 2000) offset greatest(p_offset, 0)
$$;

-- Owned/missing state for a whole set, for the set grid. One round trip.
create or replace function public.set_grid(p_set_id text, p_mode public.goal_mode)
returns table (
  card_id text,
  variant text,
  number text,
  number_sort integer,
  name text,
  rarity text,
  image_small text,
  is_secret boolean,
  market_cents integer,
  acquisition_cents integer,
  basis text,
  observed_on date,
  variant_source public.variant_source,
  quantity integer
)
language sql stable security invoker
as $$
  select r.card_id, r.variant, r.number, r.number_sort, r.name, r.rarity, r.image_small,
         r.is_secret, r.market_cents, r.acquisition_cents, r.basis, r.observed_on,
         r.variant_source,
         coalesce((
           select sum(ci.quantity)::int from public.collection_items ci
           where ci.card_id = r.card_id and ci.variant = r.variant
         ), 0)
  from public.set_requirements(p_set_id, p_mode) r
  order by r.number_sort, r.number_suffix, r.variant
$$;

-- Every tracked goal with live metrics, for the dashboard. Bounded by the
-- collector's own goal count — never by the size of the user base.
create or replace function public.my_goals()
returns table (
  goal_id uuid,
  set_id text,
  set_name text,
  series text,
  logo_url text,
  symbol_url text,
  release_date date,
  printed_total integer,
  mode public.goal_mode,
  pinned boolean,
  completed_at timestamptz,
  required_count integer,
  owned_count integer,
  missing_count integer,
  have_cents bigint,
  need_cents bigint,
  complete_cents bigint,
  need_acquisition_cents bigint,
  priced_missing integer,
  unpriced_missing integer,
  oldest_observation date,
  market_data_slots integer
)
language sql stable security invoker
as $$
  select g.id, s.id, s.name, s.series, s.logo_url, s.symbol_url, s.release_date, s.printed_total,
         g.mode, g.pinned, g.completed_at,
         m.required_count, m.owned_count, m.missing_count,
         m.have_cents, m.need_cents, m.complete_cents, m.need_acquisition_cents,
         m.priced_missing, m.unpriced_missing, m.oldest_observation, m.market_data_slots
  from public.set_goals g
  join public.sets s on s.id = g.set_id
  cross join lateral public.goal_metrics(g.set_id, g.mode) m
  where g.user_id = auth.uid()
  order by g.pinned desc, g.created_at
$$;

-- Persist the computed metrics onto the goal row. This is what satisfies the
-- "completed set values" reporting requirement without recomputation, and what
-- public share pages read (they cannot call goal_metrics, which is scoped to
-- the caller).
create or replace function public.refresh_goal_metrics(p_goal_id uuid)
returns void
language plpgsql security invoker
as $$
declare
  g record;
  m record;
begin
  select * into g from public.set_goals where id = p_goal_id;
  if not found then return; end if;

  select * into m from public.goal_metrics(g.set_id, g.mode);

  update public.set_goals
     set owned_count = m.owned_count,
         required_count = m.required_count,
         have_cents = m.have_cents,
         need_cents = m.need_cents,
         complete_cents = m.complete_cents,
         metrics_stale = false,
         metrics_updated_at = now(),
         completed_at = case
           when m.required_count > 0 and m.missing_count = 0 then coalesce(completed_at, now())
           else completed_at
         end
   where id = p_goal_id;
end $$;

grant execute on function
  public.slot_market_cents(integer, integer, integer),
  public.slot_acquisition_cents(integer, integer, integer, integer),
  public.slot_basis(integer, integer, integer),
  public.set_requirements(text, public.goal_mode),
  public.goal_metrics(text, public.goal_mode),
  public.goal_missing(text, public.goal_mode, integer, integer),
  public.set_grid(text, public.goal_mode),
  public.my_goals(),
  public.refresh_goal_metrics(uuid)
to authenticated, service_role;

grant execute on function
  public.set_requirements(text, public.goal_mode),
  public.slot_market_cents(integer, integer, integer)
to anon;
