-- Job registration. Applied against a hosted Supabase project, where pg_cron
-- and pg_net exist. Requires the service-role key and the project URL to be
-- present in Vault as `setvalue_function_url` and `setvalue_service_key`.
--
--   supabase db execute --file supabase/schedule.sql
--
-- Cron runs in UTC.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST to an Edge Function with the service-role key.
create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  base text := (select decrypted_secret from vault.decrypted_secrets where name = 'setvalue_function_url');
  key  text := (select decrypted_secret from vault.decrypted_secrets where name = 'setvalue_service_key');
begin
  return net.http_post(
    url     := base || '/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key),
    body    := p_body,
    timeout_milliseconds := 55000
  );
end $$;

select cron.unschedule(jobname) from cron.job
 where jobname in ('setvalue-hourly-prices','setvalue-nightly-catalog','setvalue-want-index','setvalue-sweeps');

-- Hourly: refresh prices for the cards collectors actually need.
select cron.schedule('setvalue-hourly-prices', '7 * * * *',
  $$select public.invoke_edge_function('price-sync', jsonb_build_object('limit', 2000))$$);

-- Nightly: catalog reconciliation. Offset from the hourly slot so they do not
-- contend for the same provider budget.
select cron.schedule('setvalue-nightly-catalog', '20 3 * * *',
  $$select public.invoke_edge_function('catalog-sync', '{}'::jsonb)$$);

-- Nightly: rebuild the want index from first principles. The triggers maintain
-- it incrementally; this corrects any drift and runs in-database, so it needs
-- no function invocation.
select cron.schedule('setvalue-want-index', '50 3 * * *',
  $$select public.rebuild_want_index()$$);

-- Housekeeping.
select cron.schedule('setvalue-sweeps', '30 4 * * *',
  $$select public.sweep_idempotency_keys(), public.sweep_rate_limits()$$);
