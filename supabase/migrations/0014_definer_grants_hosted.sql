-- Close the SECURITY DEFINER surface on hosted Supabase specifically.
--
-- Migration 0013 revoked EXECUTE from PUBLIC on every SECURITY DEFINER
-- function, which is the whole story on a bare PostgreSQL instance: PUBLIC is
-- the only grantee a new function has. It is NOT the whole story on hosted
-- Supabase.
--
-- A Supabase project ships with default privileges on the `public` schema that
-- grant EXECUTE to `anon`, `authenticated` and `service_role` on every function
-- created there. Those are explicit per-role grants, entirely separate from
-- PUBLIC, so 0013's `revoke ... from public` does not touch them. The result,
-- observed on the real project before this migration: `anon` could execute all
-- seventeen SECURITY DEFINER functions — the price writer, the sync-run
-- bookkeeping, the rate-limit sweep, the want-index writer — exactly the
-- escalation 0013 set out to prevent, reintroduced by the platform's defaults.
--
-- The safety gate (`npm run verify`) caught this against the live database and
-- refused to certify it. This migration is the fix, written as a whitelist
-- rather than a list of holes: revoke EXECUTE from the API roles on *every*
-- SECURITY DEFINER function in `public`, then grant back, by name, only the ones
-- each role is meant to reach. A definer function added by a future migration is
-- therefore closed by default until it is deliberately named here.
--
-- Grants are applied by matching function name against a whitelist and reading
-- the real signature from the catalog, so this cannot drift from the actual
-- argument types the way a hand-written signature would.

do $$
declare
  r record;
  -- name -> roles that may execute it. Anything not present is owner-only.
  grants jsonb := jsonb_build_object(
    'consume_rate_limit',  jsonb_build_array('anon', 'authenticated', 'service_role'),
    'demand_population',    jsonb_build_array('anon', 'authenticated', 'service_role'),
    'public_goal_missing',  jsonb_build_array('anon', 'authenticated', 'service_role'),
    'trade_matches',        jsonb_build_array('authenticated', 'service_role'),
    'apply_price_observation', jsonb_build_array('service_role'),
    'start_sync_run',       jsonb_build_array('service_role'),
    'finish_sync_run',      jsonb_build_array('service_role'),
    'mark_card_synced',     jsonb_build_array('service_role'),
    'price_sync_queue',     jsonb_build_array('service_role'),
    'refresh_sync_priorities', jsonb_build_array('service_role'),
    'rebuild_want_index',   jsonb_build_array('service_role'),
    'sweep_idempotency_keys', jsonb_build_array('service_role'),
    'sweep_rate_limits',    jsonb_build_array('service_role')
  );
  roles text;
begin
  for r in
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    -- Strip the internet-facing roles from every definer function first.
    execute format(
      'revoke all on function public.%I(%s) from public, anon, authenticated',
      r.proname, r.args
    );
    -- Then re-grant exactly the whitelisted roles, if any.
    if grants ? r.proname then
      select string_agg(value::text, ', ') into roles
      from jsonb_array_elements_text(grants -> r.proname);
      execute format(
        'grant execute on function public.%I(%s) to %s',
        r.proname, r.args, roles
      );
    end if;
  end loop;
end $$;

-- handle_new_user and the three want-index functions are named nowhere above,
-- so they are now reachable by no API role at all. They run as triggers or from
-- inside other SECURITY DEFINER functions, in the owner's context, and need no
-- grant to work; see the notes in 0013.
