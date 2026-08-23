-- 0025_search_name_number_reachability.sql
--
-- SEARCH ONLY. Redefines the card_search RANKING FUNCTION. Reads cards / sets /
-- prices; writes nothing — no card, variant, edition, holding, or price row is
-- created, updated, deleted, merged, or repriced.
--
-- The bug (reproduced by driving the production function exactly as /api/search
-- does): a collector who types a NAME + NUMBER — the natural way to ask for one
-- specific printing — got no number pin, because the exact-number bonus only
-- fired when the WHOLE query was "<setid><number>". So:
--   "charizard 125"   -> sv3-125        not in the first 30 (true rank ~138)
--   "pikachu swsh020" -> swshp-SWSH020  not in the first 30 (true rank ~248)
--   "gengar swsh241"  -> swshp-SWSH241  not in the first 30
-- And an exact WHOLE-NAME hit on a heavily reprinted name (Pikachu: 136 exact
-- printings) was pushed BELOW partial matches, because the same-name diversity
-- penalty (name_rank-1)*70 was UNBOUNDED: SWSH020 (an exact "Pikachu", $109)
-- sank past rank 240. The cards exist, are priced, labelled and addable — bare
-- search just could not surface them. DB existence is not discoverability.
--
-- Two minimal, additive ranking changes (nothing else in the tiering moves):
--   1. A per-TOKEN collector-number match (score 1200): if any query token
--      equals a card's collector number AND the query has another token, that
--      card is pinned — so "name number" resolves the one card the searcher
--      means. Single-token bare numbers ("SWSH020", "151") keep the existing
--      whole-query number bonus.
--   2. The same-name diversity penalty is CAPPED at 280 (four tiers) instead of
--      growing without bound, and the penalty-exemption threshold drops from
--      1300 to 1200 so number-pinned hits are never penalized. A capped penalty
--      still diversifies page 1 by distinct name, but can no longer bury an
--      exact printing hundreds of rows deep. For lightly reprinted names the cap
--      never binds, so their result order is unchanged.
--
-- Exact set+number (1400) and exact whole-name-first behaviour are preserved;
-- pagination, total_count, and the base-treatment headline price (0022) are
-- untouched. The 4-arg signature is unchanged — this is CREATE OR REPLACE, no
-- drop, so every existing call site resolves exactly as before.

set search_path = public, extensions;

create or replace function public.card_search(
  p_q      text,
  p_set    text default null,
  p_limit  integer default 30,
  p_offset integer default 0
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
  score        integer,
  total_count  bigint
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select public.search_normalize(p_q) as nq),
       qj as (select replace((select nq from q), ' ', '') as nqj),
       tk as (select array_remove(regexp_split_to_array((select nq from q), ' '), '') as toks),
  scored as (
    select c.id, c.name, c.number, c.set_id, s.name as set_name, c.rarity, c.image_small,
           c.search_name, c.number_sort, s.release_date, pr.market_cents,
           regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g') as num_norm,
           (
             case
               -- Exact set + collector number ("swshp SWSH020"): the one card
               -- the searcher unambiguously means — ranks first.
               when length(regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')) > 0
                    and (select nqj from qj) =
                        lower(c.set_id) || regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')
                                                                                   then 1400
               -- Exact collector number, whole query ("SWSH020", "151").
               when length(regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')) > 0
                    and (select nqj from qj) = regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')
                                                                                   then 1300
               -- NEW: a query TOKEN equals the collector number, in a multi-token
               -- query — the "<name> <number>" a collector actually types.
               when array_length((select toks from tk), 1) > 1
                    and length(regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')) > 0
                    and exists (
                          select 1 from unnest((select toks from tk)) as tt
                          where tt = regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g'))
                                                                                   then 1200
               -- Exact whole name.
               when c.search_name = (select nq from q)                            then 1000
               -- Query is a whole word/phrase inside the name.
               when c.search_name ~ ('(^| )' || (select nq from q) || '( |$)')     then 800
               -- Substring of the name not on a word boundary.
               when c.search_name like '%' || (select nq from q) || '%'           then 600
               -- Every query token appears somewhere in the document.
               when (select bool_and(c.search_text like '%' || t || '%')
                       from unnest((select toks from tk)) as t)                   then 400
               when c.search_text like '%' || (select nq from q) || '%'           then 300
               else 0
             end
             + (coalesce(similarity(c.search_name, (select nq from q)), 0) * 100)::int
           ) as score
    from public.cards c
    join public.sets s on s.id = c.set_id
    left join lateral (
      -- Headline price from the BASE printing only (migration 0022); treatments
      -- keep their own independent prices on card detail. No price is borrowed.
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
        or (length((select nqj from qj)) > 0
            and (select nqj from qj) = regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g'))
        -- NEW: match cards whose collector number equals a query token, so
        -- "<name> <number>" can find the card even when the name token alone
        -- would not (e.g. a promo number that is not a word in search_text).
        or exists (
             select 1 from unnest((select toks from tk)) as tt
             where length(tt) > 0
               and tt = regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g'))
      )
  ),
  -- Diversify by distinct card NAME so a broad "Charizard" leads with distinct
  -- names, not 30 reprints of one. Number-pinned/exact hits (>=1200) are exempt.
  ranked as (
    select *,
           case when score >= 1200 then 1 else 0 end as exact_hit,
           row_number() over (
             partition by search_name
             order by market_cents desc nulls last, release_date desc nulls last, number_sort
           ) as name_rank
    from scored
  )
  select id, name, number, set_id, set_name, rarity, image_small, market_cents, score,
         count(*) over () as total_count
  from ranked
  order by exact_hit desc,
           -- Capped same-name diversity penalty: still spreads distinct names
           -- across early pages, but never buries an exact printing out of reach.
           (score - case when exact_hit = 1 then 0 else least((name_rank - 1) * 70, 280) end) desc,
           market_cents desc nulls last, release_date desc nulls last, number_sort, id
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.card_search(text, text, integer, integer) to anon, authenticated, service_role;
