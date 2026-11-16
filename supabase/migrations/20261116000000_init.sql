-- ============================================================================
-- Reviews by Mur Systems — schema, row-level security, queue claim, and the
-- add-customer RPC. Stage 1 (validated against a hosted project).
--
-- Multi-tenant: every tenant table carries business_id and is locked down by
-- RLS. Secret / operator-only tables (gateway_credentials, opt_out_links,
-- demo_sends, places_api_usage) have RLS enabled but no policies — only the
-- service_role (which bypasses RLS) can touch them.
-- ============================================================================

-- ---------- Enums ----------

create type public.business_status as enum ('trial', 'active', 'paused');
create type public.send_mode as enum ('android_gateway', 'sms_provider', 'demo', 'log_only');
create type public.message_status as enum ('queued', 'sending', 'sent', 'clicked', 'failed', 'opted_out');
create type public.message_kind as enum ('initial', 'reminder');

-- ---------- profiles: auth user -> app role ----------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now()
);

-- ---------- businesses: one row per client tenant ----------

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  place_id text not null,
  timezone text not null default 'Australia/Melbourne',
  send_mode public.send_mode not null default 'log_only',
  delay_minutes integer not null default 60 check (delay_minutes between 0 and 1440),
  daily_send_cap integer not null default 15 check (daily_send_cap >= 0),
  status public.business_status not null default 'trial',
  trial_text_cap integer not null default 30 check (trial_text_cap >= 0),
  message_template text not null default 'Hi {first_name}, thanks for choosing {business}. A quick Google review would mean a lot: {review_link} {opt_out}',
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- gateway credentials: server-side only, never exposed to owners ----------

create table public.gateway_credentials (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, provider)
);

-- ---------- customers: one per (business, mobile) ----------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  first_name text not null,
  mobile text not null, -- E.164, e.g. +61412345678
  created_at timestamptz not null default now(),
  unique (business_id, mobile)
);

-- ---------- opt-outs: source of truth, keyed by (business, mobile), never expire ----------

create table public.opt_outs (
  business_id uuid not null references public.businesses(id) on delete cascade,
  mobile text not null,
  opted_out_at timestamptz not null default now(),
  source text not null default 'link' check (source in ('link', 'reply', 'owner', 'admin', 'import')),
  primary key (business_id, mobile)
);

-- ---------- opt-out links: stable token -> (business, mobile), never expire ----------

create table public.opt_out_links (
  token text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  mobile text not null,
  created_at timestamptz not null default now(),
  unique (business_id, mobile)
);

-- ---------- messages: the outbound send queue (initial + reminder) ----------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind public.message_kind not null default 'initial',
  parent_id uuid references public.messages(id) on delete set null,
  status public.message_status not null default 'queued',
  token text not null unique,       -- short token for /r/{token}
  message_text text,                -- rendered at send time by the Worker (LINK_DOMAIN is a Worker env var)
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  clicked_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0,
  retryable boolean not null default true, -- false = never auto-resent (e.g. stale claim)
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index messages_due_idx on public.messages (status, scheduled_at) where status = 'queued';
create index messages_business_id_idx on public.messages (business_id);
create index messages_customer_id_idx on public.messages (customer_id);

-- ---------- click events: every /r/{token} hit ----------

create table public.click_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  clicked_at timestamptz not null default now()
);

create index click_events_business_id_idx on public.click_events (business_id, clicked_at);

-- ---------- replies: inbound (android_gateway / demo) ----------

create table public.replies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  from_mobile text not null,
  body text not null,
  received_at timestamptz not null default now()
);

create index replies_business_id_idx on public.replies (business_id, received_at);

-- ---------- review snapshots: daily Google Places rating/count ----------

create table public.review_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  snapshot_date date not null default current_date,
  rating numeric,
  review_count integer,
  fetched_at timestamptz not null default now(),
  unique (business_id, snapshot_date)
);

-- ---------- Places API monthly usage: hard request cap ----------

create table public.places_api_usage (
  month text primary key, -- 'YYYY-MM'
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------- demo sends: admin demo-send log (rate-limited) ----------

create table public.demo_sends (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references auth.users(id) on delete set null,
  prospect_name text,
  prospect_place_id text,
  to_mobile text not null,
  sent_at timestamptz not null default now()
);

-- ============================================================================
-- RLS helpers. security definer so they can read businesses/profiles without
-- tripping the very RLS policies that call them — avoids recursion.
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
$$;

create or replace function public.can_access_business(bid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (
        select 1 from public.businesses b
        where b.id = bid and b.owner_id = auth.uid()
      )
$$;

-- ---------- auto-create a profile when a user signs up ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'owner')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Add-customer: the single entry point the owner app calls. In one transaction
-- it authorises, normalises the mobile (rejecting landlines), honours opt-outs
-- and the 90-day rule, enforces the trial cap, upserts the customer and queues
-- the message.
-- ============================================================================

create or replace function public.normalise_au_mobile(p_mobile text)
returns text
language plpgsql
immutable
as $$
declare
  v_digits text;
begin
  if p_mobile is null then
    return null;
  end if;

  v_digits := regexp_replace(p_mobile, '\D', '', 'g');
  if v_digits = '' then
    return null;
  end if;

  -- reduce to the national form 04XXXXXXXX (10 digits)
  if length(v_digits) = 11 and left(v_digits, 2) = '61' then
    v_digits := '0' || substr(v_digits, 3);       -- +61 4XX... -> 04XX...
  elsif length(v_digits) = 10 and left(v_digits, 2) = '04' then
    null;                                          -- already national
  elsif length(v_digits) = 9 and left(v_digits, 1) = '4' then
    v_digits := '0' || v_digits;                   -- 4XX... -> 04XX...
  else
    return null;                                   -- landline / malformed
  end if;

  -- mobiles are 04 followed by 8 digits; anything else (02/03/07/08, 1800, 13...) is rejected
  if v_digits !~ '^04[0-9]{8}$' then
    return null;
  end if;

  return '+61' || substr(v_digits, 2);             -- +614XXXXXXXX
end;
$$;

create or replace function public.new_token()
returns text
language sql
volatile
as $$
  select substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 16)
$$;

create or replace function public.add_customer(
  p_business_id uuid,
  p_first_name text,
  p_mobile text
)
returns table (outcome text, customer_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mobile text;
  v_status public.business_status;
  v_cap integer;
  v_delay integer;
  v_customer uuid;
  v_message uuid;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_first_name is null or btrim(p_first_name) = '' then
    return query select 'invalid_name'::text, null::uuid, null::uuid;
    return;
  end if;

  v_mobile := public.normalise_au_mobile(p_mobile);
  if v_mobile is null then
    return query select 'invalid_mobile'::text, null::uuid, null::uuid;
    return;
  end if;

  -- opt-outs are honoured instantly and permanently, keyed by (business, mobile)
  if exists (
    select 1 from public.opt_outs o
    where o.business_id = p_business_id and o.mobile = v_mobile
  ) then
    return query select 'opted_out'::text, null::uuid, null::uuid;
    return;
  end if;

  -- skip if this number was already asked in the last 90 days
  if exists (
    select 1
      from public.customers c
      join public.messages m on m.customer_id = c.id
     where c.business_id = p_business_id
       and c.mobile = v_mobile
       and m.created_at >= now() - interval '90 days'
  ) then
    return query select 'recent'::text, null::uuid, null::uuid;
    return;
  end if;

  select b.status, b.trial_text_cap, b.delay_minutes
    into v_status, v_cap, v_delay
    from public.businesses b
   where b.id = p_business_id;

  -- trial cap is enforced here in the database (not only in the UI)
  if v_status = 'trial' and (
    select count(*) from public.messages mm
     where mm.business_id = p_business_id
       and mm.status in ('sent', 'clicked', 'sending')
  ) >= v_cap then
    return query select 'capped'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.customers (business_id, first_name, mobile)
  values (p_business_id, btrim(p_first_name), v_mobile)
  on conflict (business_id, mobile)
  do update set first_name = excluded.first_name
  returning id into v_customer;

  insert into public.messages (business_id, customer_id, kind, status, token, scheduled_at)
  values (p_business_id, v_customer, 'initial', 'queued', public.new_token(),
          now() + make_interval(mins => v_delay))
  returning id into v_message;

  return query select 'queued'::text, v_customer, v_message;
end;
$$;

-- ============================================================================
-- Row-level security
-- ============================================================================

-- profiles: owner sees own, admin sees all. No write policies (role changes
-- are service-role only, so an owner can never self-promote).
alter table public.profiles enable row level security;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- businesses: owner reads own + edits only delay/template. Admin manages
-- everything through the Worker (service role).
alter table public.businesses enable row level security;
create policy "businesses_select_own_or_admin" on public.businesses
  for select using (owner_id = auth.uid() or public.is_admin());
create policy "businesses_update_own_settings" on public.businesses
  for update using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Owners may change only delay + template. status, send_mode, owner_id,
-- place_id, timezone and caps stay admin/service-role only.
revoke insert, delete, update on public.businesses from anon, authenticated;
grant update (delay_minutes, message_template) on public.businesses to authenticated;

-- customers: owner inserts + reads own (writes normally go through add_customer).
-- No update/delete (mobile is the opt-out key; a deleted customer must not let
-- an opted-out number back in).
alter table public.customers enable row level security;
create policy "customers_select_own_or_admin" on public.customers
  for select using (public.can_access_business(business_id));
create policy "customers_insert_own" on public.customers
  for insert with check (public.can_access_business(business_id));

-- opt_outs: owner reads + inserts (manual opt-out). Permanent, no update/delete.
alter table public.opt_outs enable row level security;
create policy "opt_outs_select_own_or_admin" on public.opt_outs
  for select using (public.can_access_business(business_id));
create policy "opt_outs_insert_own" on public.opt_outs
  for insert with check (public.can_access_business(business_id));

-- messages: owner reads own only. Writes via add_customer / queue RPC and
-- status transitions via the Worker/service role.
alter table public.messages enable row level security;
create policy "messages_select_own_or_admin" on public.messages
  for select using (public.can_access_business(business_id));

-- replies: owner reads own only. Inbound writes via webhook (service role).
alter table public.replies enable row level security;
create policy "replies_select_own_or_admin" on public.replies
  for select using (public.can_access_business(business_id));

-- click_events: owner reads own only. Writes via /r route (service role).
alter table public.click_events enable row level security;
create policy "click_events_select_own_or_admin" on public.click_events
  for select using (public.can_access_business(business_id));

-- review_snapshots: owner reads own only. Writes via daily cron (service role).
alter table public.review_snapshots enable row level security;
create policy "review_snapshots_select_own_or_admin" on public.review_snapshots
  for select using (public.can_access_business(business_id));

-- Service-role-only tables: RLS enabled, no policies -> denied to
-- anon/authenticated; the service_role bypasses RLS.
alter table public.gateway_credentials enable row level security;
alter table public.opt_out_links enable row level security;
alter table public.demo_sends enable row level security;
alter table public.places_api_usage enable row level security;

-- ============================================================================
-- Queue claim: atomically claim due, unsent messages so overlapping cron runs
-- can never send the same text twice. Service-role only. Trial cap is enforced
-- in add_customer; the claim only respects paused businesses.
-- ============================================================================

create or replace function public.claim_due_messages(p_batch_limit integer default 50)
returns setof public.messages
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.messages
     set status = 'sending',
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id in (
     select m.id
       from public.messages m
      where m.status = 'queued'
        and m.scheduled_at <= now()
        and exists (
          select 1 from public.businesses b
           where b.id = m.business_id and b.status <> 'paused'
        )
      order by m.scheduled_at
      limit p_batch_limit
      for update skip locked
   )
   returning *;
end;
$$;

revoke execute on function public.claim_due_messages(integer) from public;
grant execute on function public.claim_due_messages(integer) to service_role;

-- ---------- stale-claim sweeper: a message stuck in "sending" is marked
-- failed and never auto-resent (retryable = false). Service-role only.

create or replace function public.fail_stale_sends(p_stale_after interval default interval '10 minutes')
returns setof public.messages
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.messages
     set status = 'failed',
         failed_at = now(),
         retryable = false,
         last_error = 'stale claim: no send confirmation',
         updated_at = now()
   where status = 'sending'
     and updated_at <= now() - p_stale_after
   returning *;
end;
$$;

revoke execute on function public.fail_stale_sends(interval) from public;
grant execute on function public.fail_stale_sends(interval) to service_role;
