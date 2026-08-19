-- Collector-search discoverability overhaul. SEARCH ONLY — this migration adds
-- a normalized search representation and a ranking function over it. It does NOT
-- touch card identity, variants, editions, or pricing: cards.name and every
-- catalog/pricing column are read, never rewritten.
--
-- The problem it fixes: search was prefix-only, name-only, on lower(name). A
-- collector searching "Charizard" missed "M Charizard-EX", "Mega Charizard X ex",
-- "Dark/Shining/Radiant/Blaine's Charizard"; "gold star" / "delta" / "level x"
-- matched nothing because the names store ★ / δ / LV.X glyphs. Now:
--   • substring + trigram-fuzzy matching (not prefix), accent/punctuation-folded
--   • collector aliases folded into a search document: ★→gold star, δ→delta,
--     ◇→prism star, LV.X→lvx/level x, ♀/♂→female/male, "M …-EX"→mega … ex
--   • name + set name + set id + ptcgo code + collector/promo number all searched
--   • exact/prefix ranked above substring ranked above fuzzy, so the obvious
--     card stays first and typo tolerance never makes results noisy.

set search_path = public, extensions;

create extension if not exists pg_trgm;

-- --------------------------------------------------------------- normalize ---
-- One canonical normalizer, applied to BOTH the stored card document and the
-- incoming query, so collector language and catalog glyphs meet in the middle.
create or replace function public.search_normalize(txt text)
returns text
language plpgsql
immutable
as $$
declare s text;
begin
  s := lower(coalesce(txt, ''));

  -- 1. Collector glyphs → the words collectors actually type.
  s := replace(s, '★', ' gold star ');
  s := replace(s, 'δ', ' delta species ');
  s := replace(s, '◇', ' prism star ');
  s := replace(s, '♀', ' female ');
  s := replace(s, '♂', ' male ');

  -- 2. Accent fold (dependency-free; covers the accented card names we carry).
  s := translate(
         s,
         'áàâäãåéèêëíìîïóòôöõúùûüñçýÿ',
         'aaaaaaeeeeiiiiooooouuuuncyy');

  -- 3. Level-X forms → a single canonical bag ("Snorlax LV.X" / "lvx" / "level x").
  s := regexp_replace(s, 'lv\.?\s*x', ' lvx lv x level x ', 'g');
  s := regexp_replace(s, 'level\s*x',  ' lvx lv x level x ', 'g');

  -- 4. Drop apostrophes so "blaine's" == "blaines" (both straight and curly).
  s := replace(s, '''', '');
  s := replace(s, '’', '');

  -- 5. Everything else non-alphanumeric becomes a separator.
  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');

  -- 6. The Mega abbreviation: a standalone "m" (as in "M Charizard-EX") means Mega.
  s := regexp_replace(s, '(^| )m( |$)', ' mega ', 'g');

  -- 7. Collapse and trim.
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  return s;
end $$;

-- The search document for one card: normalized name + set name + set id +
-- ptcgo code + collector number (raw and set-qualified) so "SWSH284", "svp 166",
-- "svp166", set codes, and cross-set numbers all resolve.
create or replace function public.card_search_text(p_name text, p_set_id text, p_number text)
returns text
language plpgsql
stable
as $$
declare
  v_set_name text;
  v_ptcgo    text;
  v_num      text;
begin
  select s.name, s.ptcgo_code into v_set_name, v_ptcgo
    from public.sets s where s.id = p_set_id;
  v_num := lower(regexp_replace(coalesce(p_number, ''), '[^a-z0-9]', '', 'gi'));
  return btrim(
    public.search_normalize(p_name) || ' ' ||
    public.search_normalize(coalesce(v_set_name, '')) || ' ' ||
    lower(coalesce(p_set_id, '')) || ' ' ||
    lower(coalesce(v_ptcgo, '')) || ' ' ||
    v_num || ' ' ||
    lower(coalesce(p_set_id, '')) || v_num
  );
end $$;

-- ------------------------------------------------------- stored columns -----
alter table public.cards add column if not exists search_name text;
alter table public.cards add column if not exists search_text text;

create or replace function public.cards_search_refresh()
returns trigger
language plpgsql
as $$
begin
  new.search_name := public.search_normalize(new.name);
  new.search_text := public.card_search_text(new.name, new.set_id, new.number);
  return new;
end $$;

drop trigger if exists trg_cards_search_refresh on public.cards;
create trigger trg_cards_search_refresh
  before insert or update of name, set_id, number on public.cards
  for each row execute function public.cards_search_refresh();

-- Backfill existing rows (the trigger only fires on future writes).
update public.cards c
   set search_name = public.search_normalize(c.name),
       search_text = public.card_search_text(c.name, c.set_id, c.number);

-- Trigram indexes power substring + fuzzy without a table scan.
create index if not exists idx_cards_search_name_trgm on public.cards using gin (search_name gin_trgm_ops);
create index if not exists idx_cards_search_text_trgm on public.cards using gin (search_text gin_trgm_ops);

-- ------------------------------------------------------- ranked search ------
-- Encapsulates all pg_trgm usage (its own search_path), so callers need no
-- extension in their path. Returns the same shape the app already consumes.
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
               -- Exact whole name.
               when c.search_name = (select nq from q)                              then 1000
               -- Query is a whole word/phrase inside the name — "Charizard" in both
               -- "Charizard V" AND "Shining Charizard" / "M Charizard-EX". Position
               -- does not matter, so a marquee variant is not buried under prefixes.
               when c.search_name ~ ('(^| )' || (select nq from q) || '( |$)')       then 800
               -- Substring of the name that is not on a word boundary.
               when c.search_name like '%' || (select nq from q) || '%'             then 600
               -- Every query token appears somewhere in the document (name + set +
               -- code + number + aliases): multi-field / promo-number / set matches.
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
      select public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) as market_cents
      from public.prices p
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
  -- Diversify by distinct card NAME: the best printing of each name first, so a
  -- broad "Charizard" surfaces Charizard, Shining Charizard, M Charizard-EX, Mega
  -- Charizard, Dark/Blaine's/Radiant Charizard … instead of 30 reprints of one
  -- name. Second printings follow. Exact-name match still lands first overall.
  ranked as (
    select *,
           row_number() over (
             partition by search_name
             order by market_cents desc nulls last, release_date desc nulls last, number_sort
           ) as name_rank
    from scored
  )
  -- Soft diversity: each additional printing of the same name pays a small
  -- penalty, so distinct names bubble up (a broad "Charizard" shows Shining, Mega,
  -- M Charizard-EX, Dark, Blaine's … high) WITHOUT hiding a collector's specific
  -- printing — the repeats still appear, just below the first of their name.
  select id, name, number, set_id, set_name, rarity, image_small, market_cents, score
  from ranked
  order by (score - (name_rank - 1) * 70) desc, market_cents desc nulls last,
           release_date desc nulls last, number_sort
  limit greatest(1, least(p_limit, 100));
$$;

-- Catalog is world-readable; the search over it is too.
grant execute on function public.search_normalize(text)              to anon, authenticated, service_role;
grant execute on function public.card_search_text(text, text, text)  to anon, authenticated, service_role;
grant execute on function public.card_search(text, text, integer)    to anon, authenticated, service_role;
