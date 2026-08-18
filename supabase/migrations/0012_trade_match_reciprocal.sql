-- Trade matching: name the card on the other side of a two-way match.
--
-- `trade_matches()` already reported whether a match runs both ways, computed
-- from the intersection of this collector's spares with the counterpart's
-- missing slots. The UI needs to *show* both sides — "they have this, you have
-- that" — so the function now returns one example of the reciprocal card
-- alongside the boolean.
--
-- This is additive and discloses nothing new. The caller already knows its own
-- spares, and `mutual = true` already told it that one of them fills a hole for
-- the counterpart; the identity of that card was derivable by intersecting two
-- sets the caller can read. Every existing guarantee is unchanged: opt-in rows
-- only, narrowed to the caller's own missing printings, no user ids, no
-- condition, no purchase price, no card the counterpart did not flag.

drop function if exists public.trade_matches(integer);

create or replace function public.trade_matches(p_limit integer default 60)
returns table (
  card_id text,
  variant text,
  name text,
  number text,
  image_small text,
  market_cents integer,
  handle citext,
  display_name text,
  spare_copies integer,
  mutual boolean,
  -- One card the caller holds spare that the counterpart is missing.
  my_card_id text,
  my_name text,
  my_number text,
  my_image_small text,
  my_market_cents integer
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as id),
  my_missing as (
    select s.card_id, s.variant
    from me
    join public.set_goals g on g.user_id = me.id
    cross join lateral public.goal_required_slots(g.set_id, g.mode) s
    where not exists (
      select 1 from public.collection_items ci
      where ci.user_id = me.id and ci.card_id = s.card_id
        and ci.variant = s.variant and ci.quantity > 0)
  ),
  my_spares as (
    select ci.card_id, ci.variant
    from me join public.collection_items ci on ci.user_id = me.id
    where ci.quantity > 1 and coalesce(ci.grade_company, '') = ''
  ),
  offers as (
    select ci.user_id, ci.card_id, ci.variant, ci.quantity
    from me
    join public.collection_items ci on ci.for_trade and ci.user_id <> me.id
    join my_missing mm on mm.card_id = ci.card_id and mm.variant = ci.variant
    limit 400
  )
  select o.card_id, o.variant, c.name, c.number, c.image_small,
         public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents),
         pr.handle, pr.display_name,
         greatest(o.quantity - 1, 0)::int,
         back.card_id is not null,
         back.card_id, back.name, back.number, back.image_small, back.market_cents
  from offers o
  join public.cards c on c.id = o.card_id
  left join public.profiles pr on pr.id = o.user_id
  left join public.prices p
         on p.card_id = o.card_id and p.variant = o.variant and p.provider = 'tcgplayer'
  -- The most valuable spare of mine that fills a hole for this counterpart.
  left join lateral (
    select mc.id as card_id, mc.name, mc.number, mc.image_small,
           public.slot_market_cents(mp.market_cents, mp.mid_cents, mp.low_cents) as market_cents
    from public.set_goals g2
    cross join lateral public.goal_required_slots(g2.set_id, g2.mode) s2
    join my_spares ms on ms.card_id = s2.card_id and ms.variant = s2.variant
    join public.cards mc on mc.id = s2.card_id
    left join public.prices mp
           on mp.card_id = s2.card_id and mp.variant = s2.variant and mp.provider = 'tcgplayer'
    where g2.user_id = o.user_id
      and not exists (
        select 1 from public.collection_items ci2
        where ci2.user_id = o.user_id and ci2.card_id = s2.card_id
          and ci2.variant = s2.variant and ci2.quantity > 0)
    order by public.slot_market_cents(mp.market_cents, mp.mid_cents, mp.low_cents) desc nulls last
    limit 1
  ) back on true
  order by public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) desc nulls last
  limit least(greatest(p_limit, 1), 200)
$$;

revoke all on function public.trade_matches(integer) from public;
grant execute on function public.trade_matches(integer) to authenticated, service_role;
