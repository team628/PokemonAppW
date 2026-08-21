-- card_search headline price = the base printing, not the priciest treatment.
--
-- card_search returns one row per card with a single market_cents for the result
-- list. It resolved that as max(slot_market_cents) across ALL of the card's
-- price rows. After migration 0021 + the recognized-treatment ingest, a card can
-- own high-value treatment identities (e.g. Gengar SWSH241 base ~$28 vs its
-- Prerelease [Staff] ~$2,200), and the unfiltered max made the search list show the
-- stamped-treatment price as the card's headline — a printing most searchers do not
-- mean. Treatments stay independently priced and fully visible on the card-detail
-- view; only the one-per-card search headline is pinned to the base printing.
--
-- This is the ONLY change: the price lateral now joins card_variants and keeps
-- treatment = 'base'. For every card that has no treatment variants (the whole
-- catalog before the ingest) the result is byte-for-byte identical, so this is a
-- pure restoration of the pre-ingest headline price, not a behaviour change.

create or replace function public.card_search(
  p_q     text,
  p_set   text default null,
  p_limit integer default 30
)
returns table (
  id           text,
  name         text,
  number       text,
  set_id       text,
  set_name     text,
  rarity       text,
  image_small  text,
  market_cents integer,
  score        integer
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select public.search_normalize(p_q) as nq),
       tk as (select array_remove(regexp_split_to_array((select nq from q), ' '), '') as toks),
  scored as (
    select c.id, c.name, c.number, c.set_id, s.name as set_name, c.rarity, c.image_small,
           c.search_name, c.number_sort, s.release_date, pr.market_cents,
           (
             case
               when c.search_name = (select nq from q)                              then 1000
               when c.search_name ~ ('(^| )' || (select nq from q) || '( |$)')       then 800
               when c.search_name like '%' || (select nq from q) || '%'             then 600
               when (select bool_and(c.search_text like '%' || t || '%')
                       from unnest((select toks from tk)) as t)                     then 400
               when c.search_text like '%' || (select nq from q) || '%'             then 300
               else 0
             end
             + (coalesce(similarity(c.search_name, (select nq from q)), 0) * 100)::int
           ) as score
    from public.cards c
    join public.sets s on s.id = c.set_id
    left join lateral (
      -- Headline price from the BASE printing only; treatments are priced on their
      -- own identities and shown on card detail, not as the card's list price.
      select public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) as market_cents
      from public.prices p
      join public.card_variants v
        on v.card_id = p.card_id and v.variant = p.variant and v.treatment = 'base'
      where p.card_id = c.id and p.provider = 'tcgplayer'
      order by public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) desc nulls last
      limit 1
    ) pr on true
    where (p_set is null or c.set_id = p_set)
      and (
        (select bool_and(c.search_text like '%' || t || '%')
           from unnest((select toks from tk)) as t)
        or c.search_name % (select nq from q)
        or c.search_text like '%' || (select nq from q) || '%'
      )
  ),
  ranked as (
    select *,
           row_number() over (
             partition by search_name
             order by market_cents desc nulls last, release_date desc nulls last, number_sort
           ) as name_rank
    from scored
  )
  select id, name, number, set_id, set_name, rarity, image_small, market_cents, score
  from ranked
  order by (score - (name_rank - 1) * 70) desc, market_cents desc nulls last,
           release_date desc nulls last, number_sort
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.card_search(text, text, integer) to anon, authenticated, service_role;
