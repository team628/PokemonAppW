-- Multi-Source Pricing Engine — foundation.
--
-- This lays the schema for SetValue to value a card from several independent
-- providers without ever merging incompatible identities. It does NOT build a
-- consensus algorithm and does NOT change how the app currently reads prices
-- (the completion engine keeps reading public.prices, which stays the resolved
-- "current market" table). What it adds:
--
--   * public.price_observations — the append store of record. Every row is one
--     observation of one EXACT collectible identity from one provider, with
--     full provenance. Price history lives here, per identity, forever.
--   * public.price_providers — the registry/hierarchy. Each provider is an
--     independent adapter that can be enabled/disabled and ordered by priority,
--     with its access status and licensing documented in the row.
--   * provenance columns on public.prices (source, provider_product_id) so the
--     resolved current price can say where it came from.
--   * explicit edition/finish identity on public.card_variants, plus a
--     needs_resolution flag for records a human must disambiguate.
--
-- Nothing here fabricates a price or moves a price across identities.

-- ---------------------------------------------------------------------------
-- 1. Provider registry (the hierarchy)
-- ---------------------------------------------------------------------------
create table if not exists public.price_providers (
  id             text primary key,          -- 'pokemontcg', 'tcgcsv', 'ebay', ...
  display_name   text not null,
  marketplace    text,                       -- the underlying market (e.g. 'tcgplayer')
  kind           text not null,              -- 'catalog+price' | 'derived_price' | 'sold_comps' | 'market_agg'
  enabled        boolean not null default false,
  priority       integer not null default 100, -- lower = preferred when identities overlap
  capabilities   jsonb not null default '{}'::jsonb,
  access_status  text not null default 'unavailable', -- 'live' | 'dormant' | 'blocked' | 'unavailable'
  credential_env text,                        -- env var holding the key, when one is needed
  licensing      text,                        -- commercial-display / terms note
  notes          text,
  updated_at     timestamptz not null default now()
);

comment on table public.price_providers is
  'Registry of independent pricing adapters, ordered by priority. Enable/disable per provider; access_status/licensing document real availability.';

-- ---------------------------------------------------------------------------
-- 2. Observation store (per exact collectible identity, with provenance)
-- ---------------------------------------------------------------------------
create table if not exists public.price_observations (
  id                 bigint generated always as identity primary key,
  provider           text not null references public.price_providers(id),
  source             text not null,              -- how it was accessed, e.g. 'tcgcsv' (a tcgplayer-derived mirror)
  provider_product_id text,                       -- provider's product id where available
  provider_listing_id text,                       -- provider's listing id where available (sold/listed comps)
  -- identity: card + set + edition + finish (+ condition/grade + language + region)
  card_id            text not null,
  set_id             text not null,
  variant            text not null,              -- the app-level variant key (edition+finish)
  edition            text,                        -- '1st Edition' | 'Shadowless' | 'Unlimited' | 'unspecified' | null
  finish             text,                        -- 'Holofoil' | 'Reverse Holofoil' | 'Normal' | ...
  condition          text,                        -- raw condition (e.g. 'NM') XOR grading below
  grading_company    text,                        -- 'PSA' | 'BGS' | 'CGC' | null
  grade              text,                        -- '10' | '9.5' | ... (kept as text; never coerce PSA9->PSA10)
  language           text,                        -- 'EN' | 'JP' | ...
  region             text,                        -- 'NA' | 'EU' | ...
  currency           text not null,              -- ISO code of value_cents
  observation_type   text not null,              -- 'market' | 'sold' | 'listed' | 'observed'
  value_cents        integer,                     -- observed value in `currency`; null = no trustworthy value
  value_usd_cents    integer,                     -- only when a legitimate FX conversion exists; else null
  fx_source          text,                        -- provenance of the USD conversion, when applied
  low_cents          integer,
  mid_cents          integer,
  high_cents         integer,
  observed_at        timestamptz not null,        -- when the market observation is dated
  fetched_at         timestamptz not null default now(),
  -- a stable key for the exact identity, so history upserts cleanly and nulls
  -- do not fragment a series
  identity_key text generated always as (
    card_id || '|' || variant || '|' || coalesce(edition,'') || '|' || coalesce(finish,'')
      || '|' || coalesce(condition,'') || '|' || coalesce(grading_company,'') || '|' || coalesce(grade,'')
      || '|' || coalesce(language,'') || '|' || coalesce(region,'') || '|' || coalesce(currency,'')
      || '|' || observation_type
  ) stored,
  foreign key (card_id) references public.cards(id) on delete cascade
);

-- One observation per identity per provider per observation timestamp.
create unique index if not exists price_observations_identity_time
  on public.price_observations (provider, identity_key, observed_at);
create index if not exists price_observations_card on public.price_observations (card_id, variant);
create index if not exists price_observations_lookup on public.price_observations (card_id, provider, observation_type);

comment on table public.price_observations is
  'Append store of record: one row per (provider, exact collectible identity, observed_at). Never merges incompatible identities; never carries a price across editions/finishes/grades.';

-- ---------------------------------------------------------------------------
-- 3. Provenance on the resolved current-price table
-- ---------------------------------------------------------------------------
alter table public.prices add column if not exists source text not null default 'pokemontcg';
alter table public.prices add column if not exists provider_product_id text;
comment on column public.prices.source is
  'How this resolved current price was accessed (e.g. pokemontcg, tcgcsv). provider stays the marketplace label the app reads.';

-- ---------------------------------------------------------------------------
-- 4. Explicit edition/finish identity on variants
-- ---------------------------------------------------------------------------
alter table public.card_variants add column if not exists edition text;
alter table public.card_variants add column if not exists finish text;
alter table public.card_variants add column if not exists needs_resolution boolean not null default false;

comment on column public.card_variants.needs_resolution is
  'True when a legacy record is ambiguous between newly separated editions and must be resolved by the owner, not guessed.';

-- Backfill edition/finish for existing variants deterministically from the
-- variant key. This is a lossless relabel, not a price move.
update public.card_variants set
  finish = case
    when variant ilike '%reverseHolofoil%' then 'Reverse Holofoil'
    when variant ilike '%Holofoil%'        then 'Holofoil'
    else 'Normal'
  end,
  edition = case
    when variant ilike '1stEdition%' then '1st Edition'
    when variant ilike 'unlimited%'  then 'Unlimited'
    when variant ilike 'shadowless%' then 'Shadowless'
    else null                         -- normal/holofoil/reverseHolofoil = edition not distinguished by provider
  end
where edition is null and finish is null;

-- ---------------------------------------------------------------------------
-- 5. RLS — world-readable (like the rest of the catalog), service_role writes.
-- ---------------------------------------------------------------------------
alter table public.price_providers    enable row level security;
alter table public.price_observations enable row level security;

do $$
declare t text;
begin
  foreach t in array array['price_providers','price_observations']
  loop
    execute format('drop policy if exists %I on public.%I', 'pricing_read_' || t, t);
    execute format('create policy %I on public.%I for select to anon, authenticated, service_role using (true)', 'pricing_read_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'pricing_write_' || t, t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', 'pricing_write_' || t, t);
  end loop;
end $$;

revoke insert, update, delete on public.price_providers, public.price_observations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Seed the registry. Only pokemontcg + tcgcsv are actually reachable now;
--    the rest are dormant placeholders with documented access status.
-- ---------------------------------------------------------------------------
insert into public.price_providers (id, display_name, marketplace, kind, enabled, priority, access_status, credential_env, licensing, capabilities, notes) values
  ('pokemontcg', 'pokemontcg.io', 'tcgplayer/cardmarket', 'catalog+price', true, 10,
   'live', 'POKEMONTCG_API_KEY',
   'Free API; attribution appreciated. Card-level (not printing-level) pricing.',
   '{"catalog":true,"tcgplayer_usd":true,"cardmarket_eur":true,"printing_level":false,"graded":false,"sold_comps":false}'::jsonb,
   'Primary catalog + card-level market prices. Cannot distinguish Base Set 1st Ed / Shadowless / Unlimited.'),
  ('tcgcsv', 'TCGCSV (TCGplayer-derived)', 'tcgplayer', 'derived_price', true, 20,
   'live', null,
   'Free community mirror of TCGplayer product data. TCGplayer-origin; fine for private beta; formal license (TCGplayer partner) recommended before scaled commercial display.',
   '{"printing_level":true,"tcgplayer_usd":true,"graded":false,"sold_comps":false,"history":true}'::jsonb,
   'Provisional, narrowly scoped: edition/finish-level fallback where pokemontcg cannot distinguish printings (e.g. Base Set editions).'),
  ('ebay', 'eBay sold/completed comps', 'ebay', 'sold_comps', false, 30,
   'unavailable', 'EBAY_APP_TOKEN',
   'eBay Marketplace Insights / Browse API. Commercial use governed by eBay API License Agreement; sold-comp access is gated/approval-based.',
   '{"sold_comps":true,"graded":true,"high_end":true,"printing_level":true}'::jsonb,
   'DORMANT placeholder. Want: real completed-sale comps, esp. high-end/graded. Needs approved API credentials; no network calls until then.'),
  ('pricecharting', 'PriceCharting', 'pricecharting', 'market_agg', false, 40,
   'unavailable', 'PRICECHARTING_TOKEN',
   'Paid subscription API. Commercial display permitted under their terms with a paid plan.',
   '{"printing_level":true,"graded":true,"history":true,"sold_comps":true}'::jsonb,
   'DORMANT placeholder. Want: historical + graded/slab values. Needs paid token; no network calls until then.'),
  ('cardmarket', 'Cardmarket (Europe)', 'cardmarket', 'market_agg', false, 50,
   'unavailable', 'CARDMARKET_APP_TOKEN',
   'Cardmarket API requires a registered app and adheres to their API terms; commercial use conditions apply.',
   '{"printing_level":true,"eur":true,"region":"EU"}'::jsonb,
   'DORMANT placeholder. Want: European market data (EUR). We already store some cardmarket EUR via pokemontcg; a direct adapter is future work. Needs registered app credentials.')
on conflict (id) do update set
  display_name=excluded.display_name, marketplace=excluded.marketplace, kind=excluded.kind,
  priority=excluded.priority, access_status=excluded.access_status, credential_env=excluded.credential_env,
  licensing=excluded.licensing, capabilities=excluded.capabilities, notes=excluded.notes, updated_at=now();
-- Note: enabled is NOT overwritten on re-run, so an operator toggling a provider is not reverted by a redeploy.
