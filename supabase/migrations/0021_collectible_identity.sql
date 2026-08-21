-- Orthogonal collectible identity — flat variant enum → card + edition + finish +
-- treatment + language. ADDITIVE ONLY. This migration changes no existing row's
-- identity, ownership, price, or history, and by construction cannot change any
-- set's HAVE/NEED/COMPLETE result.
--
-- Motivation: the flat `variant` enum conflates edition+finish and has no axis for
-- market-recognized printings/treatments (Prerelease [Staff], Winner/Worlds stamps,
-- Prize Pack, Pokémon Center, etc.). TCGplayer and PriceCharting price each of these
-- as a distinct product; SetValue could not represent them, forcing a $2,200
-- Prerelease-Staff Gengar into the ~$40 base identity. See
-- docs/collectible-identity-migration.md for the full design and audit.
--
-- Two new orthogonal axes are added to public.card_variants:
--   * treatment — controlled vocabulary of recognized printings; default 'base'.
--   * language  — default 'EN' (English scope preserved).
-- edition/finish already exist (migration 0017). Condition (NM/LP/…) and grade
-- (PSA/BGS/CGC) are deliberately NOT catalog identity — they stay per-ownership on
-- collection_items and per-observation on pricing.
--
-- The `variant` text token remains the join key everywhere. A treatment identity is a
-- NEW card_variants row whose token embeds the treatment (e.g. 'holofoil__winner'),
-- provably disjoint from every existing token (no existing token contains '__'). So
-- prices / price_points / collection_items need NO DDL and NO key change: a treatment
-- identity is independently ownable and independently priced through the same
-- (card_id, variant) keys, with its OWN observed price and provenance and NO price
-- inheritance from the base card.

-- ---------------------------------------------------------------------------
-- 1. Add the treatment + language axes. Everything defaults to base/EN, so every
--    existing variant row is relabelled losslessly with zero backfill of data.
-- ---------------------------------------------------------------------------
alter table public.card_variants
  add column if not exists treatment text not null default 'base',
  add column if not exists language  text not null default 'EN';

-- Controlled vocabulary for treatment (recognized printings only; never condition,
-- grade, or seller noise). 'other_recognized' is the escape hatch for a
-- market-recognized printing that fits no named bucket.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'card_variants_treatment_check'
  ) then
    alter table public.card_variants
      add constraint card_variants_treatment_check check (treatment in (
        'base','prerelease','staff','prerelease_staff','winner','worlds',
        'national_championship','regional_championship','state_championship',
        'prize_pack','league','pokemon_center','cosmos_holo','cracked_ice',
        'galaxy_holo','jumbo','other_recognized'));
  end if;
end $$;

comment on column public.card_variants.treatment is
  'Recognized printing/treatment axis (controlled vocabulary). ''base'' = ordinary printing. Orthogonal to edition/finish. Never condition or grade.';
comment on column public.card_variants.language is
  'Catalog language axis. Defaults ''EN''. Distinct from region and from currency of any price.';

-- ---------------------------------------------------------------------------
-- 2. Keys / indexes. (card_id, variant) stays the join key; these add the
--    semantic guard and fast lookups without changing any PK.
-- ---------------------------------------------------------------------------
-- (a) The four identity axes must map 1:1 to a variant token — the same
--     (card, edition, finish, treatment, language) can never be entered twice under
--     two different tokens. coalesce keeps legacy rows (edition null) unambiguous.
create unique index if not exists uq_card_variants_identity
  on public.card_variants (
    card_id, coalesce(edition,''), coalesce(finish,''), treatment, language);

-- (b) "all treatments of this card" for the identity picker.
create index if not exists idx_card_variants_card_treatment
  on public.card_variants (card_id, treatment);

-- (c) Partial index making the base-only completion path cheap + explicit.
create index if not exists idx_card_variants_base_slots
  on public.card_variants (card_id) where treatment = 'base';

-- ---------------------------------------------------------------------------
-- 3. Completion safety. set_requirements() generates one required slot per
--    card_variants row for a set. `master` mode ignores is_primary, so adding
--    treatment variants would explode master-set completion. We add ONE predicate,
--    `v.treatment = 'base'`, so set completion is defined only over base printings in
--    EVERY mode. Treatments are fully ownable + priced but NEVER a required slot.
--    This is the sole change to the function; the rest is copied verbatim from 0004.
-- ---------------------------------------------------------------------------
create or replace function public.set_requirements(p_set_id text, p_mode public.goal_mode)
returns table (
  card_id text,
  variant text,
  number text,
  number_sort integer,
  number_suffix text,
  name text,
  rarity text,
  image_small text,
  is_secret boolean,
  variant_source public.variant_source,
  market_cents integer,
  acquisition_cents integer,
  basis text,
  observed_on date
)
language sql stable parallel safe
as $$
  select
    c.id, v.variant, c.number, c.number_sort, c.number_suffix, c.name, c.rarity,
    c.image_small, c.is_secret, v.source,
    public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents),
    public.slot_acquisition_cents(p.direct_cents, p.low_cents, p.market_cents, p.mid_cents),
    public.slot_basis(p.market_cents, p.mid_cents, p.low_cents),
    p.observed_on
  from public.cards c
  join public.card_variants v on v.card_id = c.id
  left join public.prices p
         on p.card_id = c.id and p.variant = v.variant and p.provider = 'tcgplayer'
  where c.set_id = p_set_id
    and v.treatment = 'base'          -- treatments are ownable+priced but never a set-completion slot
    and (
      p_mode = 'master'
      or (v.is_primary and (p_mode = 'complete' or not c.is_secret))
    )
$$;

comment on function public.set_requirements(text, public.goal_mode) is
  'Required slots for a set goal. Only base-treatment printings count toward completion (all modes), so adding recognized-treatment variants never changes HAVE/NEED/COMPLETE.';
