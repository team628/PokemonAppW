-- Mutations as database functions.
--
-- The hot writes (add a card, log a find) run as single statements with
-- PostgreSQL doing the conflict resolution, so two concurrent requests from two
-- instances cannot lose an update the way a read-modify-write in application
-- code would.

-- Adds copies of a printing. The unique constraint on
-- (user, card, printing, condition, grade) resolves concurrency: the second
-- writer conflicts and increments rather than inserting a duplicate stack.
create or replace function public.add_to_collection(
  p_card_id text,
  p_variant text,
  p_quantity integer default 1,
  p_condition public.card_condition default 'NM',
  p_paid_cents integer default null,
  p_acquired_on date default null,
  p_source_note text default null,
  p_grade_company text default null,
  p_grade_value text default null
)
returns table (item_id uuid, quantity integer, set_id text, first_copy boolean)
language plpgsql security invoker
as $$
declare
  uid uuid := auth.uid();
  sid text;
  prior integer;
  res record;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_quantity < 1 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;

  select c.set_id into sid from public.cards c where c.id = p_card_id;
  if sid is null then
    raise exception 'unknown card %', p_card_id using errcode = '23503';
  end if;

  select coalesce(sum(ci.quantity), 0) into prior
  from public.collection_items ci
  where ci.user_id = uid and ci.card_id = p_card_id and ci.variant = p_variant;

  insert into public.collection_items as ci
    (user_id, card_id, variant, condition, grade_company, grade_value,
     quantity, paid_cents, acquired_on, source_note)
  values
    (uid, p_card_id, p_variant, p_condition, nullif(p_grade_company, ''), nullif(p_grade_value, ''),
     p_quantity, p_paid_cents, p_acquired_on, p_source_note)
  on conflict (user_id, card_id, variant, condition, grade_company, grade_value)
    do update set quantity = ci.quantity + excluded.quantity,
                  updated_at = now(),
                  paid_cents = coalesce(excluded.paid_cents, ci.paid_cents)
  returning ci.id, ci.quantity into res;

  insert into public.collection_events (user_id, type, set_id, card_id, payload)
  values (uid,
          case when prior = 0 then 'card_acquired' else 'copy_added' end,
          sid, p_card_id,
          jsonb_build_object('variant', p_variant, 'condition', p_condition,
                             'quantity', p_quantity, 'paidCents', p_paid_cents));

  return query select res.id, res.quantity, sid, prior = 0;
end $$;

create or replace function public.remove_from_collection(
  p_card_id text,
  p_variant text,
  p_quantity integer default 1,
  p_condition public.card_condition default null
)
returns table (remaining integer, set_id text)
language plpgsql security invoker
as $$
declare
  uid uuid := auth.uid();
  sid text;
  left_to_remove integer := greatest(p_quantity, 1);
  r record;
  take integer;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.set_id into sid from public.cards c where c.id = p_card_id;

  for r in
    select ci.id, ci.quantity from public.collection_items ci
    where ci.user_id = uid and ci.card_id = p_card_id and ci.variant = p_variant
      and (p_condition is null or ci.condition = p_condition)
    order by ci.condition desc
    for update
  loop
    exit when left_to_remove <= 0;
    take := least(left_to_remove, r.quantity);
    if take = r.quantity then
      delete from public.collection_items where id = r.id;
    else
      update public.collection_items
         set quantity = quantity - take, updated_at = now()
       where id = r.id;
    end if;
    left_to_remove := left_to_remove - take;
  end loop;

  insert into public.collection_events (user_id, type, set_id, card_id, payload)
  values (uid, 'card_removed', sid, p_card_id,
          jsonb_build_object('variant', p_variant,
                             'quantity', greatest(p_quantity, 1) - left_to_remove));

  return query
    select coalesce(sum(ci.quantity), 0)::int, sid
    from public.collection_items ci
    where ci.user_id = uid and ci.card_id = p_card_id and ci.variant = p_variant;
end $$;

-- ---------------------------------------------------------- idempotency ----

-- Claims a key. Returns true when it is new. The primary key is the guard, so
-- two instances racing the same replayed find resolve to exactly one write.
create or replace function public.claim_idempotency_key(p_key text)
returns boolean
language plpgsql security invoker
as $$
declare
  inserted integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.idempotency_keys (user_id, key)
  values (auth.uid(), p_key)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
end $$;

create or replace function public.sweep_idempotency_keys(p_retain interval default '24 hours')
returns integer
language sql security definer
set search_path = public
as $$
  with gone as (
    delete from public.idempotency_keys where created_at < now() - p_retain returning 1
  ) select count(*)::int from gone
$$;

-- ---------------------------------------------------------- rate limits ----

-- Fixed-window counter. SECURITY DEFINER because the table is deliberately
-- unreadable by user-facing roles — a caller can consume budget but cannot
-- inspect or reset it.
--
-- This is abuse control, not DDoS protection. Volumetric defence belongs at the
-- CDN/edge (Vercel's firewall, or Cloudflare in front of it); an application
-- limiter still has to accept the connection to reject it.
create or replace function public.consume_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql security definer
set search_path = public
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  h integer;
begin
  insert into public.rate_limits (bucket, window_start, hits)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = public.rate_limits.hits + 1
  returning public.rate_limits.hits into h;

  return query select h <= p_limit, h,
    greatest(ceil(extract(epoch from (w + make_interval(secs => p_window_seconds)) - now()))::int, 0);
end $$;

create or replace function public.sweep_rate_limits(p_retain interval default '1 day')
returns integer
language sql security definer
set search_path = public
as $$
  with gone as (
    delete from public.rate_limits where window_start < now() - p_retain returning 1
  ) select count(*)::int from gone
$$;

-- ------------------------------------------------------------ card show ----

-- Records a find and adds the card in one transaction, so a crash between the
-- two cannot leave a hunt tally that disagrees with the collection.
create or replace function public.record_find(
  p_session_id uuid,
  p_card_id text,
  p_variant text,
  p_paid_cents integer default null,
  p_condition public.card_condition default 'NM'
)
returns table (find_id uuid, market_cents integer, set_id text, first_copy boolean)
language plpgsql security invoker
as $$
declare
  uid uuid := auth.uid();
  mkt integer;
  added record;
  fid uuid;
begin
  if not exists (select 1 from public.show_sessions s
                 where s.id = p_session_id and s.user_id = uid and s.ended_at is null) then
    raise exception 'that hunt session is not open for you' using errcode = '42501';
  end if;

  select public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) into mkt
  from public.prices p
  where p.card_id = p_card_id and p.variant = p_variant and p.provider = 'tcgplayer';

  select * into added from public.add_to_collection(
    p_card_id, p_variant, 1, p_condition, p_paid_cents, current_date, 'Card Show mode');

  insert into public.show_finds (session_id, user_id, card_id, variant, paid_cents, market_cents)
  values (p_session_id, uid, p_card_id, p_variant, p_paid_cents, mkt)
  returning id into fid;

  return query select fid, mkt, added.set_id, added.first_copy;
end $$;

grant execute on function
  public.add_to_collection(text, text, integer, public.card_condition, integer, date, text, text, text),
  public.remove_from_collection(text, text, integer, public.card_condition),
  public.claim_idempotency_key(text),
  public.consume_rate_limit(text, integer, integer),
  public.record_find(uuid, text, text, integer, public.card_condition)
to authenticated, service_role;

-- The limiter must be callable before a session exists (sign-in, sign-up).
grant execute on function public.consume_rate_limit(text, integer, integer) to anon;

grant execute on function
  public.sweep_idempotency_keys(interval),
  public.sweep_rate_limits(interval)
to service_role;
