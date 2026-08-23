-- 0024_placement_treatments.sql
--
-- ADDITIVE vocabulary extension. Recognized competitive-placement stamps are
-- independently-printed, independently-valued physical identities (e.g. a
-- "[2nd Place]" League/Challenge promo trades separately from the unstamped
-- promo and from a "[3rd Place]" copy). Per product decision they are NOT
-- collapsed together: each placement is its own treatment token so it keeps a
-- distinct market identity, price, and provenance.
--
-- This migration only widens the card_variants.treatment CHECK vocabulary. It
-- changes no existing row, adds no column, and — because only base-treatment
-- printings count toward set completion (see 0021) — cannot alter any
-- HAVE/NEED/COMPLETE math. 'winner' already existed in 0021; the six added
-- tokens are first_place, second_place, third_place, fourth_place, finalist,
-- participation.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'card_variants_treatment_check'
  ) then
    alter table public.card_variants drop constraint card_variants_treatment_check;
  end if;
  alter table public.card_variants
    add constraint card_variants_treatment_check check (treatment in (
      'base','prerelease','staff','prerelease_staff','winner','worlds',
      'national_championship','regional_championship','state_championship',
      'prize_pack','league','pokemon_center','cosmos_holo','cracked_ice',
      'galaxy_holo','jumbo','other_recognized',
      -- 0024: competitive placement / recognition stamps (each distinct)
      'first_place','second_place','third_place','fourth_place',
      'finalist','participation'));
end $$;

comment on constraint card_variants_treatment_check on public.card_variants is
  'Controlled treatment vocabulary. Extended in 0024 with competitive placement '
  'stamps (first_place/second_place/third_place/fourth_place/finalist/participation). '
  'Additive: base-treatment rows alone count toward set completion, so widening '
  'this vocabulary never changes HAVE/NEED/COMPLETE.';
