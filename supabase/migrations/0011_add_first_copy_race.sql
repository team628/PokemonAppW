-- Fixes a read-then-write race in add_to_collection.
--
-- `first_copy` was derived from a plain SELECT taken before the upsert. Under
-- READ COMMITTED, concurrent adds of the same printing all read `prior = 0` and
-- all reported themselves as the first copy. Twenty simultaneous FOUND IT taps
-- produced eight "first copy" answers, which meant eight `card_acquired`
-- journey entries for one card instead of one acquisition and nineteen extra
-- copies — and eight redundant milestone sweeps.
--
-- The quantity itself was never wrong: that is settled by ON CONFLICT DO UPDATE
-- inside the statement. Only the derived flag and the event type were.
--
-- The fix is a transaction-scoped advisory lock keyed on exactly the thing that
-- contends: this collector, this card, this printing. Two collectors adding the
-- same card never wait on each other, and one collector adding two different
-- cards never waits either. `xmax = 0` was rejected as an alternative because
-- it only reports whether *this row* was inserted, and a first NM copy beside an
-- existing LP copy of the same printing is a new row but not a first copy.

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

  -- Serialises concurrent adds of this (collector, card, printing) only.
  -- Released at commit; nothing else in the product takes this lock, so it
  -- cannot deadlock against another statement.
  perform pg_advisory_xact_lock(
    hashtextextended(uid::text || ':' || p_card_id || ':' || p_variant, 0)
  );

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

grant execute on function public.add_to_collection(
  text, text, integer, public.card_condition, integer, date, text, text, text
) to authenticated, service_role;
