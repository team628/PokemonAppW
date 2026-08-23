-- Billing tables, for a feature that is switched off.
--
-- These exist so that enabling payments is a configuration change against a
-- schema that has already been reviewed, rather than a migration written under
-- time pressure on the day. Nothing in the product reads or writes them today;
-- `SETVALUE_BILLING_ENABLED` is unset, and the webhook route 404s.
--
-- The policies are the point of writing them now: billing rows are readable by
-- their owner and writable only by service_role, which is the role the webhook
-- authenticates as. No user-facing code path can grant itself a subscription.

-- Raw webhook deliveries, kept for idempotency and for reconciling a disputed
-- charge against what Stripe actually said.
create table if not exists public.billing_events (
  id          text primary key,           -- Stripe's event id; the replay guard
  type        text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now()
);
create index if not exists idx_billing_events_received on public.billing_events (received_at desc);

create table if not exists public.billing_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

do $$ begin
  create type public.subscription_status as enum (
    'trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.billing_subscriptions (
  id                   text primary key,  -- Stripe subscription id
  user_id              uuid not null references auth.users (id) on delete cascade,
  status               public.subscription_status not null,
  price_id             text,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at           timestamptz not null default now()
);
create index if not exists idx_billing_subs_user on public.billing_subscriptions (user_id);

alter table public.billing_events        enable row level security;
alter table public.billing_customers     enable row level security;
alter table public.billing_subscriptions enable row level security;

-- Webhook payloads are operational data and can contain more than the
-- subscriber needs to see. service_role only, no read for anyone else.
drop policy if exists billing_events_service on public.billing_events;
create policy billing_events_service on public.billing_events
  for all to service_role using (true) with check (true);

-- A collector may see their own billing state and nothing else. Writes are
-- service_role: the only legitimate author of a subscription row is Stripe.
drop policy if exists billing_customers_owner_read on public.billing_customers;
create policy billing_customers_owner_read on public.billing_customers
  for select to authenticated using (user_id = auth.uid());
drop policy if exists billing_customers_service on public.billing_customers;
create policy billing_customers_service on public.billing_customers
  for all to service_role using (true) with check (true);

drop policy if exists billing_subs_owner_read on public.billing_subscriptions;
create policy billing_subs_owner_read on public.billing_subscriptions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists billing_subs_service on public.billing_subscriptions;
create policy billing_subs_service on public.billing_subscriptions
  for all to service_role using (true) with check (true);

-- Defence in depth: with no permissive policy an UPDATE silently affects zero
-- rows, which reads as success. Revoking the grant makes it an error instead.
revoke insert, update, delete on
  public.billing_events, public.billing_customers, public.billing_subscriptions
from anon, authenticated;
revoke select on public.billing_events from anon, authenticated;
revoke all on public.billing_customers, public.billing_subscriptions from anon;
