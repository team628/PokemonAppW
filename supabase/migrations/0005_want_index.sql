-- Want index: how many collectors are missing each printing.
--
-- The SQLite build materialised this with a periodic full recompute on a worker
-- thread, because the driver was synchronous and a multi-second aggregate stalled
-- every request. PostgreSQL changes the trade-off, so the strategy changes with
-- it rather than being ported:
--
--   * A summary table, not a materialized view. REFRESH MATERIALIZED VIEW takes
--     an ACCESS EXCLUSIVE lock (and CONCURRENTLY still rewrites the whole thing),
--     which is the wrong shape for a table that changes on every card logged.
--   * Maintained incrementally by triggers on the two things that actually move
--     the number — collection ownership and tracked goals — so the steady-state
--     cost is proportional to the change, not to the user base.
--   * A full rebuild remains available and is run nightly as a reconciliation
--     backstop, the same way the catalog job reconciles incremental price syncs.
--
-- Reads are a plain indexed lookup, so neither the dashboard nor the partner
-- console ever performs work proportional to total users.

create table if not exists public.want_index (
  card_id      text not null,
  variant      text not null,
  collectors   integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (card_id, variant),
  constraint want_index_non_negative check (collectors >= 0)
);
create index if not exists idx_want_rank on public.want_index (collectors desc) where collectors > 0;

create table if not exists public.want_index_meta (
  id           boolean primary key default true check (id),
  rebuilt_at   timestamptz,
  duration_ms  integer,
  open_wants   integer not null default 0,
  total_demand bigint not null default 0
);
insert into public.want_index_meta (id) values (true) on conflict do nothing;

alter table public.want_index enable row level security;
alter table public.want_index_meta enable row level security;

-- Aggregate counts only — never identities. Readable by anyone (the partner
-- console is public); writable only by service_role and the triggers below,
-- which run as definer.
drop policy if exists want_index_read on public.want_index;
create policy want_index_read on public.want_index
  for select to anon, authenticated, service_role using (true);
drop policy if exists want_index_write on public.want_index;
create policy want_index_write on public.want_index
  for all to service_role using (true) with check (true);
drop policy if exists want_meta_read on public.want_index_meta;
create policy want_meta_read on public.want_index_meta
  for select to anon, authenticated, service_role using (true);
drop policy if exists want_meta_write on public.want_index_meta;
create policy want_meta_write on public.want_index_meta
  for all to service_role using (true) with check (true);

-- Demand is a read-only surface for everyone but the jobs that maintain it.
revoke insert, update, delete on public.want_index, public.want_index_meta
  from anon, authenticated;

-- ------------------------------------------------------ the shared rule ----

-- Slots a single goal requires. Mirrors requirementsForMode and the
-- set_requirements predicate exactly.
create or replace function public.goal_required_slots(p_set_id text, p_mode public.goal_mode)
returns table (card_id text, variant text)
language sql stable parallel safe
as $$
  select c.id, v.variant
  from public.cards c
  join public.card_variants v on v.card_id = c.id
  where c.set_id = p_set_id
    and (
      p_mode = 'master'
      or (v.is_primary and (p_mode = 'complete' or not c.is_secret))
    )
$$;

-- Does this user want this printing right now? (tracked by a goal, not owned)
create or replace function public.user_wants_slot(p_user uuid, p_card text, p_variant text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.set_goals g
    join public.cards c on c.id = p_card and c.set_id = g.set_id
    join public.card_variants v on v.card_id = c.id and v.variant = p_variant
    where g.user_id = p_user
      and (g.mode = 'master' or (v.is_primary and (g.mode = 'complete' or not c.is_secret)))
  )
  and not exists (
    select 1 from public.collection_items ci
    where ci.user_id = p_user and ci.card_id = p_card
      and ci.variant = p_variant and ci.quantity > 0
  )
$$;

create or replace function public.want_index_bump(p_card text, p_variant text, p_delta integer)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.want_index (card_id, variant, collectors, updated_at)
  values (p_card, p_variant, greatest(p_delta, 0), now())
  on conflict (card_id, variant) do update
    set collectors = greatest(public.want_index.collectors + p_delta, 0),
        updated_at = now()
$$;

-- ------------------------------------------------------------- triggers ----

-- Ownership changes: a slot stops being wanted when the first copy lands and
-- becomes wanted again if the last copy leaves.
create or replace function public.want_index_on_collection()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  had boolean;
  has boolean;
  uid uuid;
  cid text;
  vrt text;
begin
  uid := coalesce(new.user_id, old.user_id);
  cid := coalesce(new.card_id, old.card_id);
  vrt := coalesce(new.variant, old.variant);

  -- Only the transition between "owns none" and "owns some" matters.
  had := (tg_op <> 'INSERT') and coalesce(old.quantity, 0) > 0;
  has := (tg_op <> 'DELETE') and coalesce(new.quantity, 0) > 0;

  -- Another row for the same slot (different condition or grade) can keep the
  -- slot owned, so re-check rather than trusting this row alone.
  if had <> has then
    has := exists (
      select 1 from public.collection_items ci
      where ci.user_id = uid and ci.card_id = cid and ci.variant = vrt and ci.quantity > 0
    );
    if had and not has then
      if exists (
        select 1 from public.set_goals g
        join public.cards c on c.id = cid and c.set_id = g.set_id
        join public.card_variants v on v.card_id = c.id and v.variant = vrt
        where g.user_id = uid
          and (g.mode = 'master' or (v.is_primary and (g.mode = 'complete' or not c.is_secret)))
      ) then
        perform public.want_index_bump(cid, vrt, 1);
      end if;
    elsif has and not had then
      if exists (
        select 1 from public.set_goals g
        join public.cards c on c.id = cid and c.set_id = g.set_id
        join public.card_variants v on v.card_id = c.id and v.variant = vrt
        where g.user_id = uid
          and (g.mode = 'master' or (v.is_primary and (g.mode = 'complete' or not c.is_secret)))
      ) then
        perform public.want_index_bump(cid, vrt, -1);
      end if;
    end if;
  end if;

  -- Any ownership change invalidates the cached completion snapshot.
  update public.set_goals g
     set metrics_stale = true
    from public.cards c
   where c.id = cid and g.set_id = c.set_id and g.user_id = uid and not g.metrics_stale;

  return null;
end $$;

drop trigger if exists trg_want_index_collection on public.collection_items;
create trigger trg_want_index_collection
  after insert or update of quantity or delete on public.collection_items
  for each row execute function public.want_index_on_collection();

-- Goal changes: tracking a set adds every unowned slot to the index; untracking
-- removes them. Bounded by the set, not by the user base.
create or replace function public.want_index_on_goal()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := coalesce(new.user_id, old.user_id);
  sid text := coalesce(new.set_id, old.set_id);
  md  public.goal_mode := coalesce(new.mode, old.mode);
  dir integer := case when tg_op = 'INSERT' then 1 else -1 end;
begin
  -- A second goal on the same set must not double-count a printing both modes
  -- require, so only slots not already required by another of this user's goals
  -- are moved.
  insert into public.want_index (card_id, variant, collectors, updated_at)
  select s.card_id, s.variant, greatest(dir, 0), now()
  from public.goal_required_slots(sid, md) s
  where not exists (
      select 1 from public.collection_items ci
      where ci.user_id = uid and ci.card_id = s.card_id
        and ci.variant = s.variant and ci.quantity > 0
    )
    and not exists (
      select 1
      from public.set_goals g2
      join public.goal_required_slots(g2.set_id, g2.mode) s2
        on s2.card_id = s.card_id and s2.variant = s.variant
      where g2.user_id = uid
        and g2.id <> coalesce(new.id, old.id)
    )
  on conflict (card_id, variant) do update
    set collectors = greatest(public.want_index.collectors + dir, 0),
        updated_at = now();

  return null;
end $$;

drop trigger if exists trg_want_index_goal on public.set_goals;
create trigger trg_want_index_goal
  after insert or delete on public.set_goals
  for each row execute function public.want_index_on_goal();

-- ------------------------------------------------------- full rebuild ------

-- Reconciliation backstop, run nightly. Rebuilds from first principles so any
-- drift from a missed trigger (a bulk load with triggers disabled, a restore)
-- is corrected rather than accumulating.
create or replace function public.rebuild_want_index()
returns table (open_wants integer, total_demand bigint, duration_ms integer)
language plpgsql security definer
set search_path = public
as $$
declare
  t0 timestamptz := clock_timestamp();
  ms integer;
begin
  create temp table _want_rebuild on commit drop as
  select s.card_id, s.variant, count(distinct g.user_id)::int as collectors
  from public.set_goals g
  cross join lateral public.goal_required_slots(g.set_id, g.mode) s
  where not exists (
    select 1 from public.collection_items ci
    where ci.user_id = g.user_id and ci.card_id = s.card_id
      and ci.variant = s.variant and ci.quantity > 0
  )
  group by s.card_id, s.variant;

  -- Swap contents in one transaction; readers see the old snapshot until commit.
  delete from public.want_index;
  insert into public.want_index (card_id, variant, collectors)
  select card_id, variant, collectors from _want_rebuild;

  ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;

  update public.want_index_meta
     set rebuilt_at = now(),
         duration_ms = ms,
         open_wants = (select count(*) from public.want_index where collectors > 0),
         total_demand = (select coalesce(sum(collectors), 0) from public.want_index)
   where id;

  return query
    select wm.open_wants, wm.total_demand, ms from public.want_index_meta wm where wm.id;
end $$;

-- Partner-facing demand report. Aggregate counts only, no identities, and a
-- plain indexed read rather than a scan of the population.
create or replace function public.demand_report(p_limit integer default 60, p_set_id text default null)
returns table (
  card_id text,
  variant text,
  collectors integer,
  market_cents integer,
  name text,
  number text,
  rarity text,
  image_small text,
  set_id text,
  set_name text
)
language sql stable
as $$
  select w.card_id, w.variant, w.collectors,
         public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents),
         c.name, c.number, c.rarity, c.image_small, c.set_id, s.name
  from public.want_index w
  join public.cards c on c.id = w.card_id
  join public.sets s on s.id = c.set_id
  left join public.prices p
         on p.card_id = w.card_id and p.variant = w.variant and p.provider = 'tcgplayer'
  where w.collectors > 0
    and (p_set_id is null or c.set_id = p_set_id)
  order by w.collectors desc, 4 desc nulls last
  limit least(greatest(p_limit, 1), 200)
$$;

-- Demand for the printings one collector holds spare. Scoped to their own
-- shelf, so it never scans the population either.
create or replace function public.my_spare_demand(p_limit integer default 50)
returns table (
  item_id uuid,
  card_id text,
  variant text,
  name text,
  number text,
  set_name text,
  image_small text,
  spare_copies integer,
  unit_value_cents integer,
  for_trade boolean,
  wanted_by integer
)
language sql stable security invoker
as $$
  select ci.id, ci.card_id, ci.variant, c.name, c.number, s.name, c.image_small,
         (ci.quantity - 1)::int,
         public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents),
         ci.for_trade,
         coalesce(w.collectors, 0)
  from public.collection_items ci
  join public.cards c on c.id = ci.card_id
  join public.sets s on s.id = c.set_id
  left join public.prices p
         on p.card_id = ci.card_id and p.variant = ci.variant and p.provider = 'tcgplayer'
  left join public.want_index w
         on w.card_id = ci.card_id and w.variant = ci.variant
  where ci.user_id = auth.uid()
    and ci.quantity > 1
    and coalesce(ci.grade_company, '') = ''
  order by coalesce(w.collectors, 0) desc, 9 desc nulls last
  limit least(greatest(p_limit, 1), 200)
$$;

grant execute on function
  public.demand_report(integer, text),
  public.goal_required_slots(text, public.goal_mode)
to anon, authenticated, service_role;

grant execute on function
  public.my_spare_demand(integer),
  public.user_wants_slot(uuid, text, text)
to authenticated, service_role;

grant execute on function public.rebuild_want_index() to service_role;
