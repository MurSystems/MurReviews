-- ============================================================================
-- Client onboarding in Admin.
--
--  * Sender mobile per business, checked against Mobile Message GET /v1/senders
--    (the Worker does the HTTP call; the database records the result).
--  * Live sms_provider sends are blocked until that sender is verified.
--  * A per-business onboarding checklist with dated ticks.
--  * A test-send count, visible to admins and excluded from Sent/Clicks/usage
--    (messages.mock is already excluded everywhere).
-- ============================================================================

alter table public.businesses
  add column sender_verified_at timestamptz,
  add column sender_checked_at timestamptz;

-- ---------- onboarding checklist ----------

create table public.business_onboarding (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  payment_taken_at timestamptz,
  number_verified_at timestamptz,
  business_created_at timestamptz,
  login_link_sent_at timestamptz,
  test_text_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.business_onboarding enable row level security;
-- No policies: service role only.

insert into public.business_onboarding (business_id, business_created_at)
select b.id, b.created_at from public.businesses b
on conflict (business_id) do nothing;

create or replace function public.create_business_onboarding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.business_onboarding (business_id, business_created_at)
  values (new.id, now())
  on conflict (business_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_business_created on public.businesses;
create trigger on_business_created
  after insert on public.businesses
  for each row execute function public.create_business_onboarding();

revoke execute on function public.create_business_onboarding() from public, anon, authenticated;

-- ---------- sender number ----------

create or replace function public.admin_set_sender_number(
  p_business_id uuid,
  p_sender_number text,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender text;
begin
  if p_sender_number is null or btrim(p_sender_number) = '' then
    v_sender := null;
  else
    v_sender := public.normalise_au_mobile(p_sender_number);
    if v_sender is null then
      raise exception 'sender must be an Australian mobile number' using errcode = '22023';
    end if;
  end if;

  update public.businesses
     set sender_number = v_sender,
         sender_verified_at = null,
         sender_checked_at = null
   where id = p_business_id;
  if not found then
    raise exception 'business not found' using errcode = '22023';
  end if;

  update public.business_onboarding
     set number_verified_at = null, updated_at = now()
   where business_id = p_business_id;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'set_sender_number',
          jsonb_build_object('business_id', p_business_id, 'sender_number', v_sender));
end;
$$;

revoke execute on function public.admin_set_sender_number(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_set_sender_number(uuid, text, uuid) to service_role;

-- Record the result of a Mobile Message sender-list check.
create or replace function public.admin_mark_sender_verified(
  p_business_id uuid,
  p_verified boolean,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender text;
begin
  update public.businesses
     set sender_verified_at = case when p_verified then now() else null end,
         sender_checked_at = now()
   where id = p_business_id
   returning sender_number into v_sender;
  if not found then
    raise exception 'business not found' using errcode = '22023';
  end if;

  update public.business_onboarding
     set number_verified_at = case
           when p_verified then coalesce(number_verified_at, now())
           else null end,
         updated_at = now()
   where business_id = p_business_id;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'check_sender',
          jsonb_build_object('business_id', p_business_id,
                             'sender_number', v_sender,
                             'verified', p_verified));
end;
$$;

revoke execute on function public.admin_mark_sender_verified(uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_mark_sender_verified(uuid, boolean, uuid) to service_role;

-- ---------- checklist ticks ----------

create or replace function public.admin_toggle_onboarding(
  p_business_id uuid,
  p_item text,
  p_done boolean,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_item not in ('payment_taken', 'number_verified', 'business_created',
                    'login_link_sent', 'test_text_sent') then
    raise exception 'unknown onboarding item' using errcode = '22023';
  end if;

  insert into public.business_onboarding (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  if p_item = 'payment_taken' then
    update public.business_onboarding
       set payment_taken_at = case when p_done then coalesce(payment_taken_at, now()) else null end,
           updated_at = now()
     where business_id = p_business_id;
  elsif p_item = 'number_verified' then
    update public.business_onboarding
       set number_verified_at = case when p_done then coalesce(number_verified_at, now()) else null end,
           updated_at = now()
     where business_id = p_business_id;
  elsif p_item = 'business_created' then
    update public.business_onboarding
       set business_created_at = case when p_done then coalesce(business_created_at, now()) else null end,
           updated_at = now()
     where business_id = p_business_id;
  elsif p_item = 'login_link_sent' then
    update public.business_onboarding
       set login_link_sent_at = case when p_done then coalesce(login_link_sent_at, now()) else null end,
           updated_at = now()
     where business_id = p_business_id;
  else
    update public.business_onboarding
       set test_text_sent_at = case when p_done then coalesce(test_text_sent_at, now()) else null end,
           updated_at = now()
     where business_id = p_business_id;
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'update_onboarding',
          jsonb_build_object('business_id', p_business_id, 'item', p_item, 'done', p_done));
end;
$$;

revoke execute on function public.admin_toggle_onboarding(uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_toggle_onboarding(uuid, text, boolean, uuid) to service_role;

-- ---------- block live sms_provider sends until the sender is verified ----------

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
       join public.businesses b on b.id = m.business_id
       cross join lateral public.billing_period(b.billing_anchor, now()) bp
      where m.status = 'queued'
        and m.scheduled_at <= now()
        and b.status <> 'paused'
        and not (b.send_mode = 'sms_provider' and b.sender_verified_at is null)
        and (
          select count(*) from public.messages mm
          where mm.business_id = m.business_id
            and (mm.status = 'sending'
                 or (mm.status in ('sent', 'clicked') and mm.sent_at >= current_date))
        ) < b.daily_text_cap
        and (
          select count(*) from public.messages mm
          where mm.business_id = m.business_id
            and mm.status in ('sent', 'clicked')
            and not coalesce(mm.mock, false)
            and mm.sent_at >= bp.period_start
            and mm.sent_at < bp.period_end
        ) < b.monthly_text_cap
      order by m.scheduled_at
      limit p_batch_limit
      for update of m skip locked
   )
   returning *;
end;
$$;

revoke execute on function public.claim_due_messages(integer) from public;
grant execute on function public.claim_due_messages(integer) to service_role;

-- ---------- create a business with a sender mobile ----------

drop function if exists public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer);

create or replace function public.admin_create_business(
  p_name text,
  p_place_id text,
  p_timezone text,
  p_send_mode public.send_mode,
  p_delay_minutes integer,
  p_owner_id uuid,
  p_admin_id uuid,
  p_review_count integer default null,
  p_sender_number text default null
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tz text := coalesce(p_timezone, 'Australia/Melbourne');
  v_sender text;
begin
  if p_review_count is not null and p_review_count < 0 then
    raise exception 'review count must be zero or more' using errcode = '22023';
  end if;

  if p_sender_number is not null and btrim(p_sender_number) <> '' then
    v_sender := public.normalise_au_mobile(p_sender_number);
    if v_sender is null then
      raise exception 'sender must be an Australian mobile number' using errcode = '22023';
    end if;
  end if;

  insert into public.businesses
    (name, place_id, timezone, send_mode, delay_minutes, owner_id, billing_anchor, sender_number)
  values (p_name, p_place_id, v_tz, p_send_mode, p_delay_minutes, p_owner_id,
          (now() at time zone v_tz)::date, v_sender)
  returning businesses.id into v_id;

  -- The count on the day the business joins is the baseline for "reviews
  -- gained since joining".
  if p_review_count is not null then
    insert into public.review_snapshots
      (business_id, snapshot_date, review_count, source)
    values (v_id, (now() at time zone v_tz)::date, p_review_count, 'manual');

    update public.businesses
       set starting_review_count = p_review_count,
           starting_review_recorded_at = now()
     where businesses.id = v_id;
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'create_business',
          jsonb_build_object('business_id', v_id, 'name', p_name,
                             'sender_number', v_sender));

  return query select v_id;
end;
$$;

revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer, text)
  to service_role;

-- ---------- admin listing: sender, tests and onboarding ----------

drop function if exists public.admin_list_businesses();

create or replace function public.admin_list_businesses()
returns table (
  id uuid, name text, place_id text, status public.business_status, send_mode public.send_mode,
  trial_text_cap integer, daily_text_cap integer, owner_email text, texts_sent bigint, clicks bigint,
  last_activity timestamptz, gateway_online boolean, logo_url text,
  ai_replies_requested_at timestamptz,
  texts_used_this_month bigint, monthly_text_cap integer, monthly_state text,
  billing_anchor date, billing_period_end timestamptz,
  texts_sent_this_month bigint, clicks_this_month bigint, click_rate_this_month numeric,
  review_count integer, rating numeric, starting_review_count integer, reviews_gained integer,
  last_snapshot_date date,
  sender_number text, sender_verified_at timestamptz, sender_checked_at timestamptz,
  tests_count bigint,
  payment_taken_at timestamptz, number_verified_at timestamptz,
  onboarding_created_at timestamptz, login_link_sent_at timestamptz,
  test_text_sent_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select b.id, b.name, b.place_id, b.status, b.send_mode, b.trial_text_cap, b.daily_text_cap,
         u.email as owner_email,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status in ('sent','clicked') and not m.mock) as texts_sent,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status in ('sent','clicked')
             and not m.mock and m.clicked_at is not null) as clicks,
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
           where m.business_id = b.id) as last_activity,
         coalesce((select g.last_seen_at > now() - interval '5 minutes'
           from public.gateway_credentials g where g.business_id = b.id limit 1), false) as gateway_online,
         b.logo_url,
         (select i.created_at from public.ai_reply_interest i
           where i.business_id = b.id) as ai_replies_requested_at,
         tu.used, b.monthly_text_cap, tu.state,
         b.billing_anchor, bp.period_end,
         month_sent.sent as texts_sent_this_month,
         month_click.clicks as clicks_this_month,
         case when month_sent.sent > 0
              then month_click.clicks::numeric / month_sent.sent else 0 end,
         latest.review_count, latest.rating,
         public.effective_starting_review_count(b.id),
         case when latest.review_count is not null
                   and public.effective_starting_review_count(b.id) is not null
              then latest.review_count - public.effective_starting_review_count(b.id) end,
         latest.snapshot_date,
         b.sender_number, b.sender_verified_at, b.sender_checked_at,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.mock
             and m.status in ('sent','clicked')) as tests_count,
         o.payment_taken_at, o.number_verified_at,
         o.business_created_at, o.login_link_sent_at, o.test_text_sent_at
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
    left join public.business_onboarding o on o.business_id = b.id
    left join lateral public.billing_period(b.billing_anchor, now()) bp on true
    left join lateral public.business_text_usage(b.id) tu on true
    left join lateral (
      select count(*) as sent
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= bp.period_start
         and m.sent_at < bp.period_end
    ) month_sent on true
    left join lateral (
      select count(*) as clicks
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= bp.period_start
         and m.sent_at < bp.period_end
         and m.clicked_at is not null
    ) month_click on true
    left join lateral (
      select s.review_count, s.rating, s.snapshot_date
        from public.review_snapshots s
       where s.business_id = b.id
       order by s.snapshot_date desc, s.fetched_at desc
       limit 1
    ) latest on true
   order by b.name;
$$;

revoke execute on function public.admin_list_businesses() from public, anon, authenticated;
grant execute on function public.admin_list_businesses() to service_role;
