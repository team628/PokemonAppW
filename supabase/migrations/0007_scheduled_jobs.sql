-- Scheduled work.
--
-- Two distinct responsibilities, deliberately not merged:
--
--   hourly   — refresh market prices for the cards collectors actually care
--              about, prioritised so a provider rate limit degrades coverage
--              rather than breaking the job.
--   nightly  — reconcile the catalog (new sets, cards, printings), repair
--              anything the incremental job missed, and rebuild the want index
--              from first principles as a backstop against trigger drift.
--
-- Scheduling is pg_cron calling an Edge Function over pg_net. Both extensions
-- are provided by Supabase and are not installable on a plain PostgreSQL
-- instance, so the schedule block is guarded and skipped locally; the functions
-- it calls are plain SQL and are exercised directly by the tests.

-- Priority for the hourly queue: how many collectors need this card, plus a
-- floor for anything held by anyone, so owned cards stay valued too.
create or replace function public.refresh_sync_priorities()
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  touched integer;
begin
  insert into public.card_sync_state (card_id, priority)
  select c.id,
         coalesce(w.demand, 0) * 10 + coalesce(h.holders, 0)
  from public.cards c
  left join (
    select card_id, sum(collectors)::int as demand
    from public.want_index where collectors > 0 group by card_id
  ) w on w.card_id = c.id
  left join (
    select card_id, count(distinct user_id)::int as holders
    from public.collection_items where quantity > 0 group by card_id
  ) h on h.card_id = c.id
  where coalesce(w.demand, 0) > 0 or coalesce(h.holders, 0) > 0
  on conflict (card_id) do update set priority = excluded.priority;

  get diagnostics touched = row_count;
  return touched;
end $$;

-- The work list for one hourly slice: highest intent first, least recently
-- synced next, skipping cards that keep failing (exponential-ish backoff).
create or replace function public.price_sync_queue(p_limit integer default 500)
returns table (card_id text, set_id text, priority integer, last_synced_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select c.id, c.set_id, coalesce(st.priority, 0), st.last_synced_at
  from public.cards c
  left join public.card_sync_state st on st.card_id = c.id
  where st.last_synced_at is null
     or st.last_synced_at < now() - (interval '1 hour' * greatest(power(2, least(coalesce(st.consecutive_failures, 0), 6))::int, 1))
  order by coalesce(st.priority, 0) desc, st.last_synced_at asc nulls first
  limit least(greatest(p_limit, 1), 5000)
$$;

-- Applies one provider observation.
--
-- Keeps the provider's own observation date alongside our fetch time, retains
-- the previous value on a null reading rather than blanking it, and appends to
-- history only when the observation date is new — so a provider that has not
-- repriced a card does not accumulate meaningless duplicate rows.
create or replace function public.apply_price_observation(
  p_card_id text,
  p_variant text,
  p_provider text,
  p_currency text,
  p_low integer,
  p_mid integer,
  p_high integer,
  p_market integer,
  p_direct integer,
  p_observed_on date
)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.prices as pr
    (card_id, variant, provider, currency, low_cents, mid_cents, high_cents,
     market_cents, direct_cents, observed_on, fetched_at)
  values
    (p_card_id, p_variant, p_provider, p_currency, p_low, p_mid, p_high,
     p_market, p_direct, p_observed_on, now())
  on conflict (card_id, variant, provider) do update
    set currency     = excluded.currency,
        -- last-known-good: a null reading never destroys a real figure
        low_cents    = coalesce(excluded.low_cents,    pr.low_cents),
        mid_cents    = coalesce(excluded.mid_cents,    pr.mid_cents),
        high_cents   = coalesce(excluded.high_cents,   pr.high_cents),
        market_cents = coalesce(excluded.market_cents, pr.market_cents),
        direct_cents = coalesce(excluded.direct_cents, pr.direct_cents),
        observed_on  = greatest(excluded.observed_on, pr.observed_on),
        fetched_at   = now();

  if p_market is not null or p_low is not null then
    insert into public.price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
    values (p_card_id, p_variant, p_provider, p_observed_on, p_market, p_low)
    on conflict (card_id, variant, provider, observed_on) do update
      set market_cents = coalesce(excluded.market_cents, public.price_points.market_cents),
          low_cents    = coalesce(excluded.low_cents,    public.price_points.low_cents);
  end if;
end $$;

create or replace function public.mark_card_synced(p_card_id text, p_ok boolean)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.card_sync_state (card_id, last_synced_at, last_success_at, consecutive_failures)
  values (p_card_id, now(), case when p_ok then now() end, case when p_ok then 0 else 1 end)
  on conflict (card_id) do update
    set last_synced_at = now(),
        last_success_at = case when p_ok then now() else public.card_sync_state.last_success_at end,
        consecutive_failures = case when p_ok then 0 else public.card_sync_state.consecutive_failures + 1 end
$$;

-- ------------------------------------------------------------ run logs -----

create or replace function public.start_sync_run(p_kind public.sync_kind, p_source text)
returns bigint
language sql security definer
set search_path = public
as $$
  insert into public.sync_runs (kind, source) values (p_kind, p_source) returning id
$$;

create or replace function public.finish_sync_run(
  p_id bigint,
  p_status public.sync_status,
  p_rows integer default 0,
  p_ok integer default 0,
  p_failed integer default 0,
  p_notes text default null,
  p_error text default null
)
returns void
language sql security definer
set search_path = public
as $$
  update public.sync_runs
     set status = p_status, finished_at = now(), rows_written = p_rows,
         items_ok = p_ok, items_failed = p_failed, notes = p_notes, error = p_error
   where id = p_id
$$;

-- Freshness, surfaced honestly in the app rather than assumed.
create or replace function public.data_freshness()
returns table (
  kind public.sync_kind,
  last_success timestamptz,
  last_status public.sync_status,
  age_seconds integer
)
language sql stable
as $$
  select distinct on (r.kind)
         r.kind, r.finished_at, r.status,
         extract(epoch from now() - r.finished_at)::int
  from public.sync_runs r
  where r.finished_at is not null
  order by r.kind, r.finished_at desc
$$;

grant execute on function public.data_freshness() to anon, authenticated, service_role;
grant execute on function
  public.refresh_sync_priorities(),
  public.price_sync_queue(integer),
  public.apply_price_observation(text, text, text, text, integer, integer, integer, integer, integer, date),
  public.mark_card_synced(text, boolean),
  public.start_sync_run(public.sync_kind, text),
  public.finish_sync_run(bigint, public.sync_status, integer, integer, integer, text, text)
to service_role;

-- --------------------------------------------------------- pg_cron -------

-- Supabase provides pg_cron and pg_net. On a plain PostgreSQL instance they do
-- not exist, so this block is skipped and the schedule is applied by
-- supabase/schedule.sql at deploy time instead.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    raise notice 'pg_cron available — apply supabase/schedule.sql to register jobs';
  else
    raise notice 'pg_cron unavailable (expected outside Supabase); schedules not registered';
  end if;
end $$;
