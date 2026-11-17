-- ============================================================================
-- Stage 6: admin panel backend — mock flag, audit log, admin functions,
-- demo send with rate limits. Admin functions are service-role only (the
-- Worker verifies the caller's JWT + admin role before calling them).
-- ============================================================================

-- Mark mock sends so they never count in stats and show as "sent (test)".
alter table public.messages add column mock boolean not null default false;

-- Simple audit log of admin actions.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security; -- service-role only (no policies)

-- mark_sent now records whether the send was a mock.
create or replace function public.mark_sent(p_message_id uuid, p_text text, p_mock boolean default false)
returns void
language sql
security definer
set search_path = public
as $$
  update public.messages
     set status = 'sent', message_text = p_text, sent_at = now(), mock = p_mock, updated_at = now()
   where id = p_message_id and status = 'sending';
$$;

revoke execute on function public.mark_sent(uuid, text, boolean) from public;
grant execute on function public.mark_sent(uuid, text, boolean) to service_role;

-- ---------- admin functions (service-role only) ----------

create or replace function public.admin_create_business(
  p_name text,
  p_place_id text,
  p_timezone text,
  p_send_mode public.send_mode,
  p_delay_minutes integer,
  p_owner_id uuid,
  p_admin_id uuid
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.businesses (name, place_id, timezone, send_mode, delay_minutes, owner_id)
  values (p_name, p_place_id, p_timezone, p_send_mode, p_delay_minutes, p_owner_id)
  returning businesses.id into v_id;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'create_business', jsonb_build_object('business_id', v_id, 'name', p_name));

  return query select v_id;
end;
$$;

revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid) from public;
grant execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid) to service_role;

create or replace function public.admin_list_businesses()
returns table (
  id uuid,
  name text,
  place_id text,
  status public.business_status,
  send_mode public.send_mode,
  trial_text_cap integer,
  daily_text_cap integer,
  owner_email text,
  texts_sent bigint,
  clicks bigint,
  last_activity timestamptz,
  gateway_online boolean
)
language sql
security definer
set search_path = public
as $$
  select b.id, b.name, b.place_id, b.status, b.send_mode, b.trial_text_cap, b.daily_text_cap,
         u.email as owner_email,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status in ('sent', 'clicked') and not m.mock) as texts_sent,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status = 'clicked') as clicks,
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
           where m.business_id = b.id) as last_activity,
         coalesce((select g.last_seen_at > now() - interval '5 minutes'
           from public.gateway_credentials g where g.business_id = b.id limit 1), false) as gateway_online
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
   order by b.name;
$$;

revoke execute on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to service_role;

create or replace function public.admin_set_business_status(
  p_business_id uuid,
  p_status public.business_status,
  p_trial_cap integer,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.businesses
     set status = p_status,
         trial_text_cap = coalesce(p_trial_cap, trial_text_cap),
         updated_at = now()
   where id = p_business_id;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'set_business_status', jsonb_build_object('business_id', p_business_id, 'status', p_status));
end;
$$;

revoke execute on function public.admin_set_business_status(uuid, public.business_status, integer, uuid) from public;
grant execute on function public.admin_set_business_status(uuid, public.business_status, integer, uuid) to service_role;

create or replace function public.admin_demo_send(
  p_place_id text,
  p_mobile text,
  p_admin_id uuid
)
returns table (outcome text, demo_text text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mobile text;
  v_text text;
begin
  v_mobile := public.normalise_au_mobile(p_mobile);
  if v_mobile is null then
    return query select 'invalid_mobile', null::text;
    return;
  end if;

  -- 1 per number per 30 days
  if exists (select 1 from public.demo_sends where to_mobile = v_mobile and sent_at >= now() - interval '30 days') then
    return query select 'rate_limited_number', null::text;
    return;
  end if;

  -- 20 per day overall
  if (select count(*) from public.demo_sends where sent_at >= now() - interval '1 day') >= 20 then
    return query select 'rate_limited_daily', null::text;
    return;
  end if;

  v_text := 'Demo: Here is the review link your customers would get: https://search.google.com/local/writereview?placeid=' || p_place_id;

  insert into public.demo_sends (admin_id, prospect_place_id, to_mobile)
  values (p_admin_id, p_place_id, v_mobile);

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'demo_send', jsonb_build_object('place_id', p_place_id, 'mobile', v_mobile));

  return query select 'sent', v_text;
end;
$$;

revoke execute on function public.admin_demo_send(text, text, uuid) from public;
grant execute on function public.admin_demo_send(text, text, uuid) to service_role;
