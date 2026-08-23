-- Public share page support.
--
-- A shared collection page shows progress and the cards still being hunted.
-- `goal_missing` is SECURITY INVOKER by design — it answers "what do *I* still
-- need" — so an anonymous visitor calling it would see every required card as
-- missing, because RLS hides the owner's holdings from them.
--
-- This function is the one place that reads another collector's holdings, and
-- it is deliberately narrow: it takes a handle, re-checks `share_public`
-- itself, and returns nothing at all for a private or unknown handle. It
-- exposes card identity and the market figure — never quantity, condition,
-- purchase price, acquisition date, or anything else on collection_items.

create or replace function public.public_goal_missing(
  p_handle citext,
  p_set_id text,
  p_mode public.goal_mode,
  p_limit integer default 20
)
returns table (
  card_id text,
  variant text,
  number text,
  name text,
  image_small text,
  market_cents integer
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with owner as (
    select id from public.profiles where handle = p_handle and share_public
  )
  select r.card_id, r.variant, r.number, r.name, r.image_small, r.market_cents
  from owner o
  cross join public.set_requirements(p_set_id, p_mode) r
  where not exists (
    select 1 from public.collection_items ci
    where ci.user_id = o.id
      and ci.card_id = r.card_id
      and ci.variant = r.variant
      and ci.quantity > 0
  )
  order by r.number_sort, r.number_suffix, r.variant
  limit least(greatest(p_limit, 1), 60)
$$;

revoke all on function public.public_goal_missing(citext, text, public.goal_mode, integer) from public;
grant execute on function public.public_goal_missing(citext, text, public.goal_mode, integer)
  to anon, authenticated, service_role;
