-- SetValue Valuation Engine — production-safe data model + service boundary.
--
-- This migration adds the SCHEMA only. It writes no estimates and changes no
-- displayed price. The estimator is gated behind a flag that is OFF by default
-- (public.app_flags.setvalue_estimates_enabled), so a fresh/local/CI database and
-- production behave exactly as before until the flag is explicitly turned on.
--
-- Three valuation classes: OBSERVED (a trustworthy current market observation
-- exists), SETVALUE_ESTIMATE (modeled from comparables), UNVALUED (insufficient
-- evidence). An estimate is NEVER stored or displayed as an observed market price:
-- the class column makes the distinction explicit and un-collapsible.

-- ---------------------------------------------------------------------------
-- 1. Resolved valuation per EXACT collectible identity (what the app reads).
-- ---------------------------------------------------------------------------
create table if not exists public.card_valuations (
  card_id          text not null references public.cards(id) on delete cascade,
  variant          text not null,
  valuation_class  text not null check (valuation_class in ('OBSERVED','SETVALUE_ESTIMATE','UNVALUED')),
  value_cents      integer,                 -- point value: observed market OR estimate
  low_cents        integer,                 -- estimate range low  (null when OBSERVED)
  high_cents       integer,                 -- estimate range high (null when OBSERVED)
  currency         text not null default 'USD',
  -- observed provenance (OBSERVED only)
  provider         text,                    -- 'tcgplayer' | 'cardmarket' | ...
  source           text,                    -- 'pokemontcg' | 'tcgcsv' | ...
  observation_type text check (observation_type in ('market','sold','listed','observed')),
  provider_product_id text,
  -- estimate provenance (SETVALUE_ESTIMATE only)
  model_version    text,
  confidence_score numeric check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  confidence_label text check (confidence_label in ('Low','Medium','High')),
  factors          jsonb,                   -- objective features used
  comparables      jsonb,                   -- comparable card identities used
  -- identity discipline — never mixed across these axes
  condition        text,
  grading_company  text,
  grade            text,
  edition          text,
  finish           text,
  language         text not null default 'EN',
  region           text not null default 'NA',
  valued_at        timestamptz not null default now(),
  primary key (card_id, variant),
  -- an ESTIMATE must carry model provenance; an OBSERVED must carry a provider.
  constraint valuation_class_provenance check (
    (valuation_class = 'SETVALUE_ESTIMATE' and model_version is not null)
    or (valuation_class = 'OBSERVED' and provider is not null)
    or (valuation_class = 'UNVALUED')
  )
);
create index if not exists idx_card_valuations_class on public.card_valuations (valuation_class);

comment on table public.card_valuations is
  'Resolved per-identity valuation. valuation_class distinguishes OBSERVED market data from a SETVALUE_ESTIMATE (modeled) or UNVALUED. An estimate is never labelled or displayed as an observed market price.';

-- ---------------------------------------------------------------------------
-- 2. Immutable estimate audit log (every model run — backtest/drift/repro).
-- ---------------------------------------------------------------------------
create table if not exists public.valuation_estimates (
  id               bigint generated always as identity primary key,
  card_id          text not null references public.cards(id) on delete cascade,
  variant          text not null,
  model_version    text not null,
  estimated_cents  integer not null,
  low_cents        integer,
  high_cents       integer,
  confidence_score numeric,
  confidence_label text,
  factors          jsonb,
  comparables      jsonb,
  estimated_at     timestamptz not null default now()
);
create index if not exists idx_valuation_estimates_card on public.valuation_estimates (card_id, variant, estimated_at desc);

-- ---------------------------------------------------------------------------
-- 3. Feature flag — OFF by default. Broad SetValue Estimates are not exposed
--    until this is explicitly enabled AND per-estimate gates pass (confidence
--    threshold, comparable sufficiency, non-suppressed category).
-- ---------------------------------------------------------------------------
insert into public.app_flags (key, enabled)
values ('setvalue_estimates_enabled', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. RLS. card_valuations is world-readable like the rest of the catalog/pricing
--    (it is public valuation metadata); only service_role writes it. The estimate
--    audit log is service_role-only (internal model output, not user-facing).
-- ---------------------------------------------------------------------------
alter table public.card_valuations   enable row level security;
alter table public.valuation_estimates enable row level security;

drop policy if exists card_valuations_read on public.card_valuations;
create policy card_valuations_read on public.card_valuations
  for select to anon, authenticated, service_role using (true);
drop policy if exists card_valuations_write on public.card_valuations;
create policy card_valuations_write on public.card_valuations
  for all to service_role using (true) with check (true);

drop policy if exists valuation_estimates_service on public.valuation_estimates;
create policy valuation_estimates_service on public.valuation_estimates
  for all to service_role using (true) with check (true);
revoke all on public.valuation_estimates from anon, authenticated;
