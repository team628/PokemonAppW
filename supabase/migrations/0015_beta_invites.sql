-- Invite-only private beta.
--
-- Account creation is gated at the database, not the application. GoTrue (public
-- /auth/v1/signup, the Admin API, and the dashboard "Add user" button) creates
-- accounts by INSERTing into auth.users; a BEFORE INSERT trigger there is the
-- one choke point every path funnels through. Enforcing it here means a stranger
-- who POSTs straight to /auth/v1/signup with the public anon key is refused by
-- Postgres itself — there is no application code in that path to rely on, and no
-- client-side check to bypass.
--
-- Existing users are untouched: the trigger fires only on INSERT, so anyone
-- already in auth.users keeps signing in, recovering, and confirming exactly as
-- before. Email confirmation, Supabase Auth, and all RLS remain in force.
--
-- The gate is switched by a single flag (public.app_flags.beta_invite_only),
-- OFF by default. A fresh database — local development, the test suite, CI —
-- therefore behaves exactly as it always did, with no changes to fixtures or
-- setup. Production turns the flag ON explicitly (see set_beta_invite_only),
-- and re-running this migration never resets an already-enabled flag.

-- ---------------------------------------------------------------------------
-- 1. The invite list
-- ---------------------------------------------------------------------------
create table if not exists public.beta_invites (
  email      citext primary key,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid,
  revoked_at timestamptz
);

comment on table public.beta_invites is
  'Allow-list for invite-only signup. An invite is active when revoked_at is null.';

-- RLS on, and deliberately no policies: anon and authenticated get nothing
-- through PostgREST. Only the owner (migrations / SQL editor) and service_role
-- — both of which bypass RLS — and the SECURITY DEFINER functions below ever
-- touch this table.
alter table public.beta_invites enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The switch
-- ---------------------------------------------------------------------------
create table if not exists public.app_flags (
  key        text primary key,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.app_flags enable row level security;

-- Seed the flag OFF, and only if absent: re-applying the migration must never
-- flip a production-enabled gate back off.
insert into public.app_flags (key, enabled)
values ('beta_invite_only', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The gate
-- ---------------------------------------------------------------------------
create or replace function public.enforce_beta_invite()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Off unless production has switched it on. A fresh/local database seeds the
  -- flag false, so development and tests create users exactly as before.
  if not coalesce((select enabled from public.app_flags where key = 'beta_invite_only'), false) then
    return new;
  end if;

  -- Email-only beta. A null email cannot be matched to an invite.
  if new.email is null then
    raise exception 'SetValue is currently invite-only.' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.beta_invites b
     where b.email = new.email
       and b.revoked_at is null
  ) then
    raise exception 'SetValue is currently invite-only.' using errcode = 'P0001';
  end if;

  return new;
end $$;

comment on function public.enforce_beta_invite() is
  'BEFORE INSERT gate on auth.users: when beta_invite_only is on, only emails with an active invite may create an account.';

-- BEFORE INSERT so it runs ahead of the AFTER INSERT profile hook: a rejected
-- signup never reaches handle_new_user and leaves no profile behind.
drop trigger if exists on_auth_user_enforce_invite on auth.users;
create trigger on_auth_user_enforce_invite
  before insert on auth.users
  for each row execute function public.enforce_beta_invite();

-- ---------------------------------------------------------------------------
-- 4. Owner controls (run from the Supabase SQL editor — no code changes)
-- ---------------------------------------------------------------------------
--   select public.set_beta_invite_only(true);                          -- arm the gate (do this once)
--   select public.grant_beta_invite('friend@example.com');             -- invite
--   select public.grant_beta_invite('friend@example.com', 'cohort 1');  -- with a note
--   select public.revoke_beta_invite('friend@example.com');            -- revoke
--   select * from public.list_beta_invites();                           -- review
--   select public.set_beta_invite_only(false);                         -- open signups (end of beta)
--
-- Re-granting a revoked email reactivates it. Revoking does not delete history.

create or replace function public.set_beta_invite_only(p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.app_flags (key, enabled, updated_at)
  values ('beta_invite_only', p_on, now())
  on conflict (key) do update set enabled = excluded.enabled, updated_at = now();
  return p_on;
end $$;

create or replace function public.grant_beta_invite(p_email text, p_note text default null)
returns public.beta_invites
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  row public.beta_invites;
begin
  insert into public.beta_invites (email, note, created_by)
  values (p_email::citext, p_note, auth.uid())
  on conflict (email) do update
    set revoked_at = null,
        note       = coalesce(excluded.note, public.beta_invites.note)
  returning * into row;
  return row;
end $$;

create or replace function public.revoke_beta_invite(p_email text)
returns public.beta_invites
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  row public.beta_invites;
begin
  update public.beta_invites
     set revoked_at = now()
   where email = p_email::citext
  returning * into row;
  return row;
end $$;

create or replace function public.list_beta_invites()
returns setof public.beta_invites
language sql
security definer
set search_path = public, auth
as $$
  select * from public.beta_invites order by created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 5. Privilege lockdown (hosted Supabase grants EXECUTE to anon/authenticated
--    on every new function by default — see migration 0014). None of these may
--    be reachable by the API roles. The trigger function needs no grant: a
--    trigger fires regardless of the invoking role's EXECUTE privilege, and it
--    should never be callable directly.
-- ---------------------------------------------------------------------------
revoke all on function public.enforce_beta_invite()            from public, anon, authenticated;
revoke all on function public.set_beta_invite_only(boolean)    from public, anon, authenticated;
revoke all on function public.grant_beta_invite(text, text)    from public, anon, authenticated;
revoke all on function public.revoke_beta_invite(text)         from public, anon, authenticated;
revoke all on function public.list_beta_invites()              from public, anon, authenticated;

-- service_role may manage the beta programmatically (used by tooling/tests);
-- the owner in the SQL editor runs as a superuser and needs no grant.
grant execute on function public.set_beta_invite_only(boolean) to service_role;
grant execute on function public.grant_beta_invite(text, text) to service_role;
grant execute on function public.revoke_beta_invite(text)      to service_role;
grant execute on function public.list_beta_invites()           to service_role;
