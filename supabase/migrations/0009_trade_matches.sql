-- Trade matching.
--
-- `collection_items` is owner-only under RLS, which is correct: nobody should
-- be able to read another collector's holdings. But trade matching is, by
-- definition, a cross-collector read — "who has a spare of the card I am
-- missing?" — so it needs one narrow, audited door rather than a policy hole.
--
-- This is that door. It is SECURITY DEFINER and it:
--   * only ever considers rows the owner explicitly flagged `for_trade`,
--     which is the opt-in;
--   * returns card identity, a spare count, and the counterpart's public
--     handle and display name — never a user id, never quantity beyond the
--     spare count, never condition, purchase price, acquisition date, source
--     note, or any card the counterpart did not flag;
--   * is filtered to printings the *caller* is actually missing, so it cannot
--     be used to enumerate someone's collection by asking about cards you do
--     not need.
--
-- Marking a card for trade is what publishes the handle. Nothing else does.

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
  mutual boolean
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
         exists (
           select 1 from public.set_goals g2
           cross join lateral public.goal_required_slots(g2.set_id, g2.mode) s2
           join my_spares ms on ms.card_id = s2.card_id and ms.variant = s2.variant
           where g2.user_id = o.user_id
             and not exists (
               select 1 from public.collection_items ci2
               where ci2.user_id = o.user_id and ci2.card_id = s2.card_id
                 and ci2.variant = s2.variant and ci2.quantity > 0)
         )
  from offers o
  join public.cards c on c.id = o.card_id
  left join public.profiles pr on pr.id = o.user_id
  left join public.prices p
         on p.card_id = o.card_id and p.variant = o.variant and p.provider = 'tcgplayer'
  order by public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) desc nulls last
  limit least(greatest(p_limit, 1), 200)
$$;

-- Anonymous visitors have no goals and no holdings, so the function would
-- return nothing for them anyway — but it is not granted to `anon` regardless,
-- because a cross-collector read should require an identity.
revoke all on function public.trade_matches(integer) from public;
grant execute on function public.trade_matches(integer) to authenticated, service_role;

-- Price drops have the same shape of problem in reverse: the query is entirely
-- within the caller's own rows plus the shared catalog, so it stays SECURITY
-- INVOKER. Nothing to change there.
