-- User-owned domain.
--
-- Every table here is keyed to auth.users(id) and protected by RLS. The policies
-- are the authorization boundary: a collector calling PostgREST directly with
-- their own JWT still cannot read another collector's rows. The application is
-- not trusted to filter.

-- ------------------------------------------------------------- profiles ----

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  handle        citext not null unique
                  check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null,
  avatar_color  text not null default '#2DD4A7',
  -- Private by default. Publishing a collection's value is a decision the
  -- collector makes, not one the product makes for them.
  share_public  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------- collection ----

do $$ begin
  create type public.card_condition as enum ('NM', 'LP', 'MP', 'HP', 'DMG');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.goal_mode as enum ('main', 'complete', 'master');
exception when duplicate_object then null; end $$;

create table if not exists public.collection_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  card_id        text not null references public.cards (id) on delete cascade,
  variant        text not null,
  condition      public.card_condition not null default 'NM',
  grade_company  text,
  grade_value    text,
  quantity       integer not null default 1 check (quantity >= 0),
  paid_cents     integer check (paid_cents is null or paid_cents >= 0),
  acquired_on    date,
  source_note    text,
  for_trade      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- NULLs are distinct in a normal UNIQUE, which would let duplicate ungraded
  -- rows accumulate. NULLS NOT DISTINCT makes the stack identity exact.
  constraint collection_items_identity
    unique nulls not distinct (user_id, card_id, variant, condition, grade_company, grade_value)
);
create index if not exists idx_ci_user      on public.collection_items (user_id);
create index if not exists idx_ci_slot      on public.collection_items (user_id, card_id, variant) where quantity > 0;
create index if not exists idx_ci_card      on public.collection_items (card_id, variant) where for_trade;
create index if not exists idx_ci_dupes     on public.collection_items (user_id) where quantity > 1;

create table if not exists public.set_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  set_id       text not null references public.sets (id) on delete cascade,
  mode         public.goal_mode not null,
  pinned       boolean not null default false,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  -- Denormalised snapshot of the last computed completion, so list screens and
  -- the "completed set values" reporting requirement do not recompute.
  owned_count      integer not null default 0,
  required_count   integer not null default 0,
  have_cents       bigint  not null default 0,
  need_cents       bigint  not null default 0,
  complete_cents   bigint  not null default 0,
  metrics_stale    boolean not null default true,
  metrics_updated_at timestamptz,
  unique (user_id, set_id, mode)
);
create index if not exists idx_goals_user on public.set_goals (user_id);
create index if not exists idx_goals_set  on public.set_goals (set_id, mode);
create index if not exists idx_goals_stale on public.set_goals (metrics_stale) where metrics_stale;

create table if not exists public.wishlist_items (
  user_id    uuid not null references auth.users (id) on delete cascade,
  card_id    text not null references public.cards (id) on delete cascade,
  variant    text not null,
  priority   integer not null default 2,
  max_cents  integer,
  created_at timestamptz not null default now(),
  primary key (user_id, card_id, variant)
);

-- -------------------------------------------------------------- journey ----

create table if not exists public.collection_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  type       text not null,
  set_id     text references public.sets (id) on delete set null,
  card_id    text references public.cards (id) on delete set null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_user on public.collection_events (user_id, created_at desc);

create table if not exists public.milestones (
  user_id     uuid not null references auth.users (id) on delete cascade,
  goal_id     uuid not null references public.set_goals (id) on delete cascade,
  kind        text not null,
  achieved_at timestamptz not null default now(),
  payload     jsonb,
  seen        boolean not null default false,
  primary key (user_id, goal_id, kind)
);
create index if not exists idx_milestones_unseen on public.milestones (user_id) where not seen;

-- ------------------------------------------------------------ card show ----

create table if not exists public.show_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  venue        text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  budget_cents integer
);
create index if not exists idx_show_user on public.show_sessions (user_id, started_at desc);
-- At most one hunt open per collector; the app relies on this rather than
-- racing two "start session" requests into two rows.
create unique index if not exists idx_show_one_open
  on public.show_sessions (user_id) where ended_at is null;

create table if not exists public.show_finds (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.show_sessions (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  card_id      text not null references public.cards (id) on delete cascade,
  variant      text not null,
  paid_cents   integer,
  market_cents integer,
  found_at     timestamptz not null default now()
);
create index if not exists idx_finds_session on public.show_finds (session_id, found_at desc);

-- --------------------------------------------- idempotency & rate limits ---

-- Durable replay guard. The unique key is the guard: a replayed Card Show queue
-- conflicts rather than double-counting, and it holds across instances.
create table if not exists public.idempotency_keys (
  user_id    uuid not null references auth.users (id) on delete cascade,
  key        text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists idx_idem_created on public.idempotency_keys (created_at);

-- Fixed-window counters, in the database so a restart cannot hand out a fresh
-- budget and limits hold across horizontally scaled instances.
create table if not exists public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);
create index if not exists idx_rate_window on public.rate_limits (window_start);

-- ---------------------------------------------------------------- RLS ------

alter table public.profiles           enable row level security;
alter table public.collection_items   enable row level security;
alter table public.set_goals          enable row level security;
alter table public.wishlist_items     enable row level security;
alter table public.collection_events  enable row level security;
alter table public.milestones         enable row level security;
alter table public.show_sessions      enable row level security;
alter table public.show_finds         enable row level security;
alter table public.idempotency_keys   enable row level security;
alter table public.rate_limits        enable row level security;

-- Profiles: a collector manages their own row. Others may read it only when the
-- collector has explicitly opted into public sharing — this single policy is
-- what makes the public page opt-in at the database layer rather than in a
-- page component.
drop policy if exists profiles_self_all on public.profiles;
create policy profiles_self_all on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profiles_public_read on public.profiles;
create policy profiles_public_read on public.profiles
  for select to anon, authenticated
  using (share_public);

drop policy if exists profiles_service on public.profiles;
create policy profiles_service on public.profiles
  for all to service_role using (true) with check (true);

-- Owner-only tables. Written out per table rather than generated, so each
-- policy is greppable and reviewable.
do $$
declare t text;
begin
  foreach t in array array[
    'collection_items','set_goals','wishlist_items','collection_events',
    'milestones','show_sessions','show_finds','idempotency_keys'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner', t);
    execute format('drop policy if exists %I on public.%I', t || '_service', t);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      t || '_service', t);
  end loop;
end $$;

-- Rate limits are infrastructure: no user-facing role may read or write them.
-- They are maintained through a security-definer function instead.
drop policy if exists rate_limits_service on public.rate_limits;
create policy rate_limits_service on public.rate_limits
  for all to service_role using (true) with check (true);

revoke all on public.rate_limits from anon, authenticated;

-- --------------------------------------------------------- profile hook ----

-- Every authenticated user gets a profile row. Runs as definer so it can insert
-- for a user who has no rows yet, and derives a unique handle deterministically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  base       text;
  new_handle text;
  n          integer := 0;
begin
  base := regexp_replace(
            lower(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), 'collector')),
            '[^a-z0-9_]', '_', 'g');
  base := left(nullif(base, ''), 20);
  if base is null or length(base) < 3 then
    base := 'collector';
  end if;

  new_handle := base;
  while exists (select 1 from public.profiles p where p.handle = new_handle) loop
    n := n + 1;
    new_handle := left(base, 18) || '_' || n::text;
  end loop;

  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    new_handle,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1), 'Collector')
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
