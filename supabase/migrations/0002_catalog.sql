-- Catalog: shared, read-mostly reference data.
--
-- Readable by everyone (including anonymous visitors — the landing page and
-- partner console need it). Writable only by service_role, which is what the
-- background sync jobs authenticate as. No user-facing code path can mutate it.

create table if not exists public.sets (
  id             text primary key,
  name           text not null,
  series         text not null,
  printed_total  integer not null default 0,
  total          integer not null default 0,
  ptcgo_code     text,
  release_date   date,
  symbol_url     text,
  logo_url       text,
  provider       text not null default 'pokemontcg',
  provider_updated_at timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists idx_sets_release on public.sets (release_date desc nulls last);
create index if not exists idx_sets_series  on public.sets (series);

create table if not exists public.cards (
  id             text primary key,
  set_id         text not null references public.sets (id) on delete cascade,
  number         text not null,
  number_sort    integer not null,
  number_suffix  text not null default '',
  name           text not null,
  supertype      text,
  subtypes       jsonb not null default '[]'::jsonb,
  rarity         text,
  artist         text,
  hp             text,
  types          jsonb not null default '[]'::jsonb,
  national_dex   jsonb not null default '[]'::jsonb,
  flavor_text    text,
  image_small    text,
  image_large    text,
  is_secret      boolean not null default false,
  provider       text not null default 'pokemontcg',
  synced_at      timestamptz not null default now()
);
create index if not exists idx_cards_set    on public.cards (set_id, number_sort, number_suffix);
create index if not exists idx_cards_name   on public.cards (lower(name));
create index if not exists idx_cards_rarity on public.cards (rarity);
-- Trigram-free prefix search for the quick-add box; text_pattern_ops keeps
-- LIKE 'term%' index-eligible without an extension.
create index if not exists idx_cards_name_prefix on public.cards (lower(name) text_pattern_ops);

-- Which physical printings of a card exist.
-- source = 'market_data' when a price provider quoted it; 'inferred' when
-- derived from set era + rarity rules.
do $$ begin
  create type public.variant_source as enum ('market_data', 'inferred');
exception when duplicate_object then null; end $$;

create table if not exists public.card_variants (
  card_id     text not null references public.cards (id) on delete cascade,
  variant     text not null,
  source      public.variant_source not null,
  is_primary  boolean not null default false,
  primary key (card_id, variant)
);
create index if not exists idx_variants_primary on public.card_variants (card_id) where is_primary;

-- Latest known price per (card, printing, provider).
create table if not exists public.prices (
  card_id      text not null references public.cards (id) on delete cascade,
  variant      text not null,
  provider     text not null,
  currency     text not null,
  low_cents    integer,
  mid_cents    integer,
  high_cents   integer,
  market_cents integer,
  direct_cents integer,
  -- The provider's own observation date, distinct from when we fetched it.
  observed_on  date not null,
  fetched_at   timestamptz not null default now(),
  primary key (card_id, variant, provider)
);
-- Covers the valuation join, which reads exactly these columns for USD.
create index if not exists idx_prices_usd
  on public.prices (card_id, variant)
  include (market_cents, mid_cents, low_cents, direct_cents, observed_on)
  where provider = 'tcgplayer';

-- Append-only history: one row per provider observation date.
create table if not exists public.price_points (
  card_id      text not null references public.cards (id) on delete cascade,
  variant      text not null,
  provider     text not null,
  observed_on  date not null,
  market_cents integer,
  low_cents    integer,
  primary key (card_id, variant, provider, observed_on)
);
create index if not exists idx_pp_card_date on public.price_points (card_id, variant, observed_on desc);

-- ------------------------------------------------------------ sync state ---

do $$ begin
  create type public.sync_kind as enum ('hourly_prices','nightly_catalog','want_index','manual');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.sync_status as enum ('running','succeeded','failed','partial');
exception when duplicate_object then null; end $$;

create table if not exists public.sync_runs (
  id           bigint generated always as identity primary key,
  kind         public.sync_kind not null,
  status       public.sync_status not null default 'running',
  source       text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  rows_written integer not null default 0,
  items_ok     integer not null default 0,
  items_failed integer not null default 0,
  notes        text,
  error        text
);
create index if not exists idx_sync_runs_kind on public.sync_runs (kind, started_at desc);

-- Per-card sync bookkeeping so the hourly job can prioritise and back off
-- rather than re-fetching the whole catalog every hour.
create table if not exists public.card_sync_state (
  card_id          text primary key references public.cards (id) on delete cascade,
  last_synced_at   timestamptz,
  last_success_at  timestamptz,
  consecutive_failures integer not null default 0,
  -- Higher = fetched sooner. Maintained from tracked-set demand.
  priority         integer not null default 0
);
create index if not exists idx_sync_state_queue
  on public.card_sync_state (priority desc, last_synced_at asc nulls first);

-- ---------------------------------------------------------------- RLS ------

alter table public.sets           enable row level security;
alter table public.cards          enable row level security;
alter table public.card_variants  enable row level security;
alter table public.prices         enable row level security;
alter table public.price_points   enable row level security;
alter table public.sync_runs      enable row level security;
alter table public.card_sync_state enable row level security;

-- Catalog is world-readable; only service_role writes it.
do $$
declare t text;
begin
  foreach t in array array['sets','cards','card_variants','prices','price_points']
  loop
    execute format('drop policy if exists %I on public.%I', 'catalog_read_' || t, t);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated, service_role using (true)',
      'catalog_read_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'catalog_write_' || t, t);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      'catalog_write_' || t, t);
  end loop;
end $$;

-- Defence in depth: the policies already deny catalog writes (an UPDATE simply
-- matches zero rows), but revoking the grant turns a silent no-op into an
-- explicit permission error, which is both safer and easier to notice if a
-- future migration adds a policy by mistake.
revoke insert, update, delete on
  public.sets, public.cards, public.card_variants, public.prices, public.price_points
  from anon, authenticated;

-- Sync bookkeeping is operational data: service_role only, plus a read for
-- signed-in users so the app can show data freshness honestly.
drop policy if exists sync_runs_read on public.sync_runs;
create policy sync_runs_read on public.sync_runs
  for select to authenticated, anon using (true);
drop policy if exists sync_runs_write on public.sync_runs;
create policy sync_runs_write on public.sync_runs
  for all to service_role using (true) with check (true);
drop policy if exists card_sync_state_all on public.card_sync_state;
create policy card_sync_state_all on public.card_sync_state
  for all to service_role using (true) with check (true);
