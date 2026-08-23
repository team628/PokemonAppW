-- Self-serve invite codes for the private beta.
--
-- Extends the invite gate (0015) so a new collector can create their own
-- account — and their own username — by presenting a valid code, without the
-- owner pre-listing their email. The code rides along as signup metadata
-- (raw_user_meta_data.invite_code) and is validated and *consumed atomically*
-- inside the same BEFORE INSERT trigger on auth.users, so it cannot be reused
-- past its limit, cannot be forged (it is checked against this table, which
-- anon/authenticated cannot read), and cannot be bypassed by calling Supabase
-- Auth directly — the check is the database's.
--
-- The email allow-list from 0015 still works, so the owner can whitelist a
-- specific address (e.g. their own) without a code.

-- ---------------------------------------------------------------------------
-- 1. Codes
-- ---------------------------------------------------------------------------
create table if not exists public.invite_codes (
  code       text primary key,          -- stored upper-cased
  max_uses   integer,                    -- null = unlimited
  uses       integer not null default 0,
  expires_at timestamptz,                -- null = never expires
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid,
  revoked_at timestamptz
);

comment on table public.invite_codes is
  'Self-serve beta invite codes. Valid when not revoked, not expired, and uses < max_uses (or unlimited).';

alter table public.invite_codes enable row level security;  -- no policies: anon/authenticated get nothing

-- ---------------------------------------------------------------------------
-- 2. The gate now also accepts a valid code
-- ---------------------------------------------------------------------------
create or replace function public.enforce_beta_invite()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_code text;
  v_ok   boolean := false;
begin
  -- Off unless production has switched it on (fresh/local DB seeds it false).
  if not coalesce((select enabled from public.app_flags where key = 'beta_invite_only'), false) then
    return new;
  end if;

  if new.email is null then
    raise exception 'SetValue is currently invite-only.' using errcode = 'P0001';
  end if;

  -- Path 1: the owner explicitly allow-listed this email (0015).
  if exists (
    select 1 from public.beta_invites b
     where b.email = new.email and b.revoked_at is null
  ) then
    return new;
  end if;

  -- Path 2: a valid, unexhausted invite code, consumed in one atomic step so
  -- concurrent signups cannot overshoot max_uses.
  v_code := upper(nullif(trim(new.raw_user_meta_data ->> 'invite_code'), ''));
  if v_code is not null then
    update public.invite_codes
       set uses = uses + 1
     where code = v_code
       and revoked_at is null
       and (expires_at is null or expires_at > now())
       and (max_uses is null or uses < max_uses)
    returning true into v_ok;
    if v_ok then
      return new;
    end if;
  end if;

  raise exception 'SetValue is currently invite-only.' using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Owner controls (Supabase SQL editor — no code changes)
-- ---------------------------------------------------------------------------
--   select public.create_invite_code('POKEBETA2026', 25);           -- code, 25 uses
--   select public.create_invite_code('FRIENDS', null, now()+interval '30 days'); -- unlimited, expires
--   select public.create_invite_code();                             -- auto-generate a random code
--   select public.revoke_invite_code('POKEBETA2026');               -- kill a code
--   select code, uses, max_uses, expires_at, revoked_at from public.list_invite_codes();

create or replace function public.create_invite_code(
  p_code       text        default null,
  p_max_uses   integer     default null,
  p_expires_at timestamptz default null,
  p_note       text        default null
)
returns public.invite_codes
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_code text;
  row    public.invite_codes;
begin
  v_code := upper(coalesce(nullif(trim(p_code), ''),
                           substr(md5(random()::text || clock_timestamp()::text), 1, 8)));
  insert into public.invite_codes (code, max_uses, expires_at, note, created_by)
  values (v_code, p_max_uses, p_expires_at, p_note, auth.uid())
  on conflict (code) do update
    set max_uses   = excluded.max_uses,
        expires_at = excluded.expires_at,
        note       = coalesce(excluded.note, public.invite_codes.note),
        revoked_at = null
  returning * into row;
  return row;
end $$;

create or replace function public.revoke_invite_code(p_code text)
returns public.invite_codes
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  row public.invite_codes;
begin
  update public.invite_codes
     set revoked_at = now()
   where code = upper(trim(p_code))
  returning * into row;
  return row;
end $$;

create or replace function public.list_invite_codes()
returns setof public.invite_codes
language sql
security definer
set search_path = public, auth
as $$
  select * from public.invite_codes order by created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 4. Privilege lockdown (see 0014): none of these reachable by the API roles.
-- ---------------------------------------------------------------------------
revoke all on function public.create_invite_code(text, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.revoke_invite_code(text)                              from public, anon, authenticated;
revoke all on function public.list_invite_codes()                                   from public, anon, authenticated;

grant execute on function public.create_invite_code(text, integer, timestamptz, text) to service_role;
grant execute on function public.revoke_invite_code(text)                             to service_role;
grant execute on function public.list_invite_codes()                                  to service_role;
