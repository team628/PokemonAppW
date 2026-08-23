-- Tighten the authorization around the partner console's aggregates.
--
-- The partner console is the one public surface that reports on the collector
-- population, so it is the surface where an over-broad privilege turns directly
-- into a leak. An adversarial review of how it obtains its figures, and of every
-- privilege reachable from where it stands, turned up five problems. Four of
-- them were exploitable when this was written, and each was exercised before it
-- was fixed.
--
--   1. The collector and active-hunt counts were read through the service role.
--      That grants a *code region* full RLS bypass in order to answer two
--      integers, and any future edit inside that region inherits the bypass.
--   2. `user_wants_slot(uuid, text, text)` is SECURITY DEFINER and was granted
--      to `authenticated`. It takes an arbitrary user id and answers whether
--      that person is chasing a specific printing and does not already own it —
--      an oracle over another collector's goals and holdings, iterable across
--      the whole catalog. Nothing calls it: the want-index triggers inline the
--      same logic. It is removed rather than narrowed.
--   3. `want_index_bump(text, text, integer)` is SECURITY DEFINER and, having
--      never been revoked, carried PostgreSQL's default PUBLIC execute. Any
--      caller — including `anon` — could write arbitrary counts straight into
--      `want_index`, which is the table every demand figure on the partner
--      console is computed from.
--   4. Ten more SECURITY DEFINER functions still carried PostgreSQL's default
--      PUBLIC execute, because the migrations that created them granted to
--      `service_role` without revoking from PUBLIC first. Anonymous callers
--      could wipe the rate limiter and rewrite market prices. See section 5.
--   5. `my_goals()` had no tiebreak on its ordering, so callers that take "the
--      first goal" got an arbitrary one. See section 4.

-- ---------------------------------------------------------------------------
-- 1. Population counts, as a question rather than a privilege
-- ---------------------------------------------------------------------------
--
-- Two integers, no arguments, no filters, no way to ask about anybody in
-- particular. Because it takes no parameters at all, there is nothing for a
-- caller to steer: it can be invoked, and it returns the same two aggregates to
-- everyone, or it cannot be invoked. `profiles` and `set_goals` stay unreadable
-- row-by-row through RLS exactly as before.

create or replace function public.demand_population()
returns table (collectors integer, tracked integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select count(*) from public.profiles)::int,
         (select count(*) from public.set_goals)::int
$$;

revoke all on function public.demand_population() from public;
grant execute on function public.demand_population() to anon, authenticated, service_role;

comment on function public.demand_population() is
  'Collector and tracked-goal counts for the public partner console. SECURITY '
  'DEFINER because both tables are owner-scoped under RLS. Takes no arguments '
  'by design: there is no parameter to steer it towards an individual.';

-- ---------------------------------------------------------------------------
-- 2. Remove the individual-goal oracle
-- ---------------------------------------------------------------------------
--
-- Proven before removal: signed in as an account with no relationship to the
-- target, `select * from public.set_goals` returns zero rows — RLS holding —
-- while `user_wants_slot('<target>', 'sv3pt5-1', 'normal')` returns true.

drop function if exists public.user_wants_slot(uuid, text, text);

-- ---------------------------------------------------------------------------
-- 3. Stop anyone writing the demand index
-- ---------------------------------------------------------------------------
--
-- `want_index_bump` is only ever called from the two want-index triggers and
-- from `rebuild_want_index()`. All three are SECURITY DEFINER functions owned
-- by the same role that owns this one, so they keep their access as owner; no
-- grant to anon, authenticated or service_role is needed for the index to be
-- maintained.
--
-- The trigger functions get the same treatment. Calling a trigger function
-- directly raises an error, so this is defence in depth rather than a live
-- hole — but a SECURITY DEFINER function should never sit on PUBLIC execute,
-- and leaving three of them there invites the fourth.

revoke all on function public.want_index_bump(text, text, integer) from public;
revoke all on function public.want_index_on_collection() from public;
revoke all on function public.want_index_on_goal() from public;
revoke all on function public.handle_new_user() from public;

-- ---------------------------------------------------------------------------
-- 4. A deterministic goal order
-- ---------------------------------------------------------------------------
--
-- `order by g.pinned desc, g.created_at` has no tiebreak, and goals created in
-- one statement — a CSV import, or onboarding with several sets chosen at once
-- — share a timestamp to the microsecond. Every caller that takes "the first
-- goal" then gets an arbitrary one: the binder opened a different set on
-- successive loads of the same page. Adding the primary key as a final key
-- makes the order stable without changing it for anyone whose goals have
-- distinct timestamps.

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
  order by g.pinned desc, g.created_at, g.id
$$;

-- ---------------------------------------------------------------------------
-- 5. Take PUBLIC off every SECURITY DEFINER function
-- ---------------------------------------------------------------------------
--
-- `want_index_bump` was not an isolated slip. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, and `grant execute ... to service_role` adds a
-- grant without removing that default — so ten definer functions that run as
-- the table owner were reachable by `anon`, whatever the explicit grant beside
-- them said. Two of those are directly exploitable, and both were exercised as
-- `anon` before this migration was written:
--
--   * `sweep_rate_limits('0 seconds')` deletes every counter in
--     `rate_limits`. A bucket that had just refused a fifth sign-in attempt
--     allowed the next one immediately afterwards. The same call disarms the
--     partner page's per-address cap.
--   * `apply_price_observation(...)` writes straight into `prices` and
--     `price_points`. Base Charizard's market price went from $852.43 to $0.01
--     on an anonymous call, which is every valuation in the product and the
--     "open demand at market" headline on the partner console.
--
-- The rest — the sync-run bookkeeping, the sync queue, the idempotency sweep,
-- and a full want-index rebuild on demand — are integrity and denial-of-service
-- surface rather than disclosure, but none of them belong to the public.
--
-- So: revoke PUBLIC from all of them, then re-grant exactly the roles that
-- call them. `consume_rate_limit` is the one genuinely public entry point, and
-- it stays public explicitly instead of by accident.

revoke all on function
  public.apply_price_observation(text, text, text, text, integer, integer, integer, integer, integer, date),
  public.consume_rate_limit(text, integer, integer),
  public.finish_sync_run(bigint, public.sync_status, integer, integer, integer, text, text),
  public.mark_card_synced(text, boolean),
  public.price_sync_queue(integer),
  public.rebuild_want_index(),
  public.refresh_sync_priorities(),
  public.start_sync_run(public.sync_kind, text),
  public.sweep_idempotency_keys(interval),
  public.sweep_rate_limits(interval)
from public;

-- Background jobs run as the service role; nothing else needs any of this.
grant execute on function
  public.apply_price_observation(text, text, text, text, integer, integer, integer, integer, integer, date),
  public.finish_sync_run(bigint, public.sync_status, integer, integer, integer, text, text),
  public.mark_card_synced(text, boolean),
  public.price_sync_queue(integer),
  public.rebuild_want_index(),
  public.refresh_sync_priorities(),
  public.start_sync_run(public.sync_kind, text),
  public.sweep_idempotency_keys(interval),
  public.sweep_rate_limits(interval)
to service_role;

-- The limiter is called before anyone is identified — sign-in, sign-up and the
-- public partner page all consume from it — so it is public on purpose.
grant execute on function public.consume_rate_limit(text, integer, integer)
  to anon, authenticated, service_role;
