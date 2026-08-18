-- Job registration. Applied against a hosted Supabase project, where pg_cron
-- and pg_net exist.
--
--   supabase db execute --file supabase/schedule.sql
--
-- Requires two Vault secrets, created once per project:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'setvalue_function_url');
--   select vault.create_secret('<service role key>', 'setvalue_service_key');
--
-- Cron runs in UTC. Re-running this file is safe: every job is unscheduled
-- first, and the helper is replaced rather than duplicated.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST to an Edge Function with the service-role key.
--
-- SECURITY DEFINER because it reads Vault, which the calling role cannot. That
-- makes the grant on it load-bearing: this function will attach the project's
-- service-role key to a request, so anyone who can execute it can make the
-- database speak with the project's full authority. PostgreSQL grants EXECUTE
-- to PUBLIC on every new function, so the revoke below is not a precaution —
-- without it this is a privilege escalation reachable by `anon`, of exactly the
-- kind migration 0013 exists to close.
create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  base text := (select decrypted_secret from vault.decrypted_secrets where name = 'setvalue_function_url');
  key  text := (select decrypted_secret from vault.decrypted_secrets where name = 'setvalue_service_key');
begin
  if base is null or key is null then
    raise exception 'vault secrets setvalue_function_url / setvalue_service_key are not set';
  end if;
  return net.http_post(
    url     := base || '/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key),
    body    := p_body,
    timeout_milliseconds := 55000
  );
end $$;

-- Revoked from the API roles as well as PUBLIC: on hosted Supabase, default
-- privileges grant EXECUTE to anon/authenticated on every new public function,
-- so `from public` alone would leave this — which speaks with the project's
-- service-role key — reachable by anonymous traffic. See migration 0014.
revoke all on function public.invoke_edge_function(text, jsonb) from public, anon, authenticated;
-- No grant follows. pg_cron runs these jobs as the role that scheduled them —
-- the owner — which needs no grant. Nothing else has any business calling it.

select cron.unschedule(jobname) from cron.job
 where jobname in ('setvalue-hourly-prices','setvalue-nightly-catalog','setvalue-want-index','setvalue-sweeps');

-- Hourly: refresh prices for the sets collectors are actually chasing.
--
-- `sets` is the number of sets one invocation refreshes, not a card count: the
-- provider serves prices a set at a time. Twelve an hour against a 174-set
-- catalog is 288 set-refreshes a day — every set at least daily, with headroom
-- for the most-wanted to come round more than once. The function itself decides
-- which sets are due and orders them by open demand; see its header.
select cron.schedule('setvalue-hourly-prices', '7 * * * *',
  $$select public.invoke_edge_function('price-sync', jsonb_build_object('sets', 12))$$);

-- Nightly: catalog reconciliation — new sets, new cards, changed metadata.
-- Offset from the hourly slot so the two do not contend for provider budget.
-- Unbounded on purpose: a full pass is one dataset file plus one request per
-- set, and a partial catalog is worse than a slow one.
select cron.schedule('setvalue-nightly-catalog', '20 3 * * *',
  $$select public.invoke_edge_function('catalog-sync', '{}'::jsonb)$$);

-- Nightly: rebuild the want index from first principles.
--
-- catalog-sync already rebuilds it, because cards discovered in that run can
-- create wants and an index built before they existed would be stale. This
-- second pass is deliberate redundancy rather than an oversight: it runs
-- entirely in-database, so it still reconciles on a night when the provider is
-- unreachable and catalog-sync fails. The triggers maintain the index during
-- the day; both of these are backstops.
select cron.schedule('setvalue-want-index', '50 3 * * *',
  $$select public.rebuild_want_index()$$);

-- Housekeeping: expire idempotency keys and rate-limit windows.
select cron.schedule('setvalue-sweeps', '30 4 * * *',
  $$select public.sweep_idempotency_keys(), public.sweep_rate_limits()$$);
