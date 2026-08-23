-- "Can't find my card" — a narrow, owner-facing catalog-gap feedback path.
--
-- Purpose is deliberately singular: when a collector searches for a card the
-- app cannot surface, record the exact term they typed (and the set they had
-- selected, and how many results the search returned) so the owner can review
-- real catalog/search gaps later. This is NOT a general feedback system — it
-- has one shape and one use.
--
-- A result_count of 0 is a true miss (nothing surfaced). A small non-zero count
-- still matters: the collector looked, did not see their card among the hits,
-- and asked for help — that is the search-terminology failure this pass is
-- about (e.g. "gold star", "delta", a promo number, an un-accented name).

create table if not exists public.catalog_gap_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Exactly what the collector typed, preserved verbatim for the owner to read.
  term         text not null check (length(term) between 1 and 120),
  -- A lower/trim/whitespace-collapsed form the app computes, so the owner can
  -- group many spellings of the same miss together. Honest about its limits:
  -- it is not accent-folded (no unaccent extension here yet).
  normalized   text not null check (length(normalized) between 1 and 120),
  -- The set filter that was active, if any. Free of the card catalog on delete.
  set_id       text references public.sets (id) on delete set null,
  -- How many results the search returned when they gave up. 0 = surfaced nothing.
  result_count integer not null default 0 check (result_count >= 0),
  status       text not null default 'open'
                 check (status in ('open', 'reviewed', 'resolved', 'dismissed')),
  note         text,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

comment on table public.catalog_gap_reports is
  'Owner-facing "Can''t find my card" reports: the search term a collector could not resolve. Scoped to this one use, not a generic feedback store.';

create index if not exists idx_gap_normalized on public.catalog_gap_reports (normalized);
create index if not exists idx_gap_created    on public.catalog_gap_reports (created_at desc);
create index if not exists idx_gap_open       on public.catalog_gap_reports (status) where status = 'open';

-- ---------------------------------------------------------------- RLS -------
-- Owner-of-the-row model, identical to the rest of the user-owned domain: a
-- collector may write and read only their own reports; nobody but service_role
-- (the owner, via the Supabase SQL editor / admin) sees across collectors.
alter table public.catalog_gap_reports enable row level security;

drop policy if exists catalog_gap_owner on public.catalog_gap_reports;
create policy catalog_gap_owner on public.catalog_gap_reports
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists catalog_gap_service on public.catalog_gap_reports;
create policy catalog_gap_service on public.catalog_gap_reports
  for all to service_role using (true) with check (true);

-- ------------------------------------------------- owner review (no code) ---
-- Review the gaps grouped by normalized term, most-reported first. Runs as
-- definer so the owner can read across all collectors from the SQL editor:
--   select * from public.list_catalog_gaps();          -- top 100 gaps
--   select public.set_catalog_gap_status('gold star', 'resolved');
create or replace function public.list_catalog_gaps(p_limit integer default 100)
returns table (
  normalized     text,
  reports        bigint,
  reporters      bigint,
  avg_results    numeric,
  example_term   text,
  last_reported  timestamptz,
  open_reports   bigint
)
language sql
security definer
set search_path = public, auth
as $$
  select normalized,
         count(*)                               as reports,
         count(distinct user_id)                as reporters,
         round(avg(result_count), 2)            as avg_results,
         (array_agg(term order by created_at desc))[1] as example_term,
         max(created_at)                        as last_reported,
         count(*) filter (where status = 'open') as open_reports
  from public.catalog_gap_reports
  group by normalized
  order by count(*) desc, max(created_at) desc
  limit p_limit;
$$;

create or replace function public.set_catalog_gap_status(p_normalized text, p_status text)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n integer;
begin
  if p_status not in ('open', 'reviewed', 'resolved', 'dismissed') then
    raise exception 'invalid status %', p_status using errcode = 'P0001';
  end if;
  update public.catalog_gap_reports
     set status = p_status,
         reviewed_at = case when p_status = 'open' then null else now() end
   where normalized = lower(btrim(p_normalized));
  get diagnostics n = row_count;
  return n;
end $$;

-- Privilege lockdown (see 0014/0016): admin surface, unreachable by API roles.
revoke all on function public.list_catalog_gaps(integer)          from public, anon, authenticated;
revoke all on function public.set_catalog_gap_status(text, text)  from public, anon, authenticated;
grant execute on function public.list_catalog_gaps(integer)         to service_role;
grant execute on function public.set_catalog_gap_status(text, text) to service_role;
