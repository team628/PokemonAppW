-- SetValue — foundation: extensions, roles, and the local Supabase shim.
--
-- On a hosted Supabase project the `auth` schema, the anon/authenticated/
-- service_role roles and auth.uid() already exist. This migration creates them
-- only if absent, so the same migration set runs unchanged against a plain
-- PostgreSQL instance used for local development and CI.

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create extension if not exists citext;

-- ---------------------------------------------------------------- roles ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- ----------------------------------------------------------- auth schema ---
create schema if not exists auth;

-- Hosted Supabase owns auth.users. Locally we create a compatible subset so
-- foreign keys and RLS policies are identical in both environments.
create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         citext unique,
  created_at    timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- auth.uid() reads the verified JWT claims the connection is running under.
-- Identical semantics to Supabase: null when unauthenticated.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  )
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated;
-- On hosted Supabase, identities are managed through the Auth Admin API rather
-- than SQL. Locally the same role needs direct access so the development
-- sign-in shim and the test suite can create identities.
grant select, insert, update, delete on auth.users to service_role;

-- New objects created by migrations should be reachable by the API roles;
-- RLS, not table grants, is the authorization boundary.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
