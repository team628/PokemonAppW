-- RC-3: make every legitimate printing discoverable. SEARCH ONLY — this migration
-- redefines the card_search RANKING FUNCTION. It reads cards / sets / prices and
-- writes nothing: no card identity, variant, edition, holding, or price row is
-- created, updated, deleted, merged, or repriced.
--
-- The bug it fixes (proven by the master-list trace): card_search hard-capped at
-- least(p_limit, 100) with no offset. A heavily reprinted name — Pikachu has 287
-- printings, Eevee 83, Charmander 57 — could not surface its later printings at
-- all: Charizard ex (sv3 #125), Mew (basep #8) and Pikachu (swshp SWSH020) were
-- unreachable by bare name even at limit 100, and Gengar (swshp SWSH052) sat at
-- rank 47, past the 30-result window the app requests. They exist, are priced,
-- labelled and addable — but bare-name search silently dropped them.
--
-- The fix is scalable pagination plus exact-hit ranking, NOT a bigger cap:
--   • p_offset lets the caller page through the FULL ranked result set, so no
--     match is ever unreachable; page size stays bounded (<= 100).
--   • total_count (window count over the full match set) tells the caller when
--     more pages exist, powering a "show more printings" affordance.
--   • an exact set+number match (1400) and an exact number match (1300) now rank
--     ABOVE an exact whole-name match (1000), and are exempted from the
--     same-name diversity penalty, so "swshp SWSH020" lands its card first.
--   • name diversity, base-treatment headline price (migration 0022), and every
--     existing score tier are preserved, so page 1 of a small name is byte-for-
--     byte what it was before. Nothing previously discoverable moves out of reach.
--
-- API compatibility: the previous 3-arg card_search(text,text,integer) is dropped
-- and replaced by a 4-arg form whose p_offset defaults to 0, so every existing
-- 3-arg call site resolves unchanged. The added total_count output column is
-- ignored by callers that select columns by name.

set search_path = public, extensions;

drop function if exists public.card_search(text, text, integer);

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
               -- Exact set + collector number ("swshp SWSH020", "swshpswsh020"):
               -- the one card the searcher unambiguously means — ranks first.
               when length(regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')) > 0
                    and (select nqj from qj) =
                        lower(c.set_id) || regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')
                                                                                   then 1400
               -- Exact collector number, any set ("SWSH020", "151").
               when length(regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')) > 0
                    and (select nqj from qj) = regexp_replace(lower(c.number), '[^a-z0-9]+', '', 'g')
                                                                                   then 1300
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
      )
  ),
  -- Diversify by distinct card NAME so a broad "Charizard" leads with distinct
  -- names, not 30 reprints of one. Exact set/number hits (>=1300) are exempt.
  ranked as (
    select *,
           case when score >= 1300 then 1 else 0 end as exact_hit,
           row_number() over (
             partition by search_name
             order by market_cents desc nulls last, release_date desc nulls last, number_sort
           ) as name_rank
    from scored
  )
  -- total_count: full number of matches (window has no partition), computed
  -- before LIMIT/OFFSET so every page reports the same total.
  select id, name, number, set_id, set_name, rarity, image_small, market_cents, score,
         count(*) over () as total_count
  from ranked
  order by exact_hit desc,
           (score - case when exact_hit = 1 then 0 else (name_rank - 1) * 70 end) desc,
           market_cents desc nulls last, release_date desc nulls last, number_sort, id
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.card_search(text, text, integer, integer) to anon, authenticated, service_role;
