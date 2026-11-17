-- ============================================================================
-- Billing-period allowance.
--
-- Each business has a billing anchor date (its creation date by default). The
-- allowance period runs from that day of the month to the same day next month,
-- Melbourne time. When the day does not exist in a month, the last day of that
-- month is used (e.g. 31 Jan -> 28 Feb). All allowance, pause, warning,
-- dashboard "this month" and admin usage numbers use this period.
-- ============================================================================

alter table public.businesses
  add column billing_anchor date;

-- Existing businesses started billing on the day they were created.
update public.businesses
   set billing_anchor = (created_at at time zone coalesce(timezone, 'Australia/Melbourne'))::date
 where billing_anchor is null;

alter table public.businesses
  alter column billing_anchor set default ((now() at time zone 'Australia/Melbourne')::date),
  alter column billing_anchor set not null;

-- The anchor's day in a given month, clamped to that month's last day.
create or replace function public.anchor_date_in_month(p_month date, p_day integer)
returns date
language sql
immutable
as $$
  select (date_trunc('month', p_month)::date
          + (least(greatest(p_day, 1),
                   extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int) - 1));
$$;

-- The billing period containing p_at. period_end is the next reset date, at
-- 00:00 Melbourne time.
create or replace function public.billing_period(
  p_anchor date,
  p_at timestamptz default now()
)
returns table (period_start timestamptz, period_end timestamptz)
language plpgsql
stable
as $$
declare
  v_today date := (p_at at time zone 'Australia/Melbourne')::date;
  v_day integer;
  v_month date;
  v_start date;
  v_next date;
begin
  v_day := coalesce(extract(day from p_anchor)::int, extract(day from v_today)::int);
  v_month := date_trunc('month', v_today)::date;

  v_start := public.anchor_date_in_month(v_month, v_day);
  if v_start > v_today then
    v_month := (v_month - interval '1 month')::date;
    v_start := public.anchor_date_in_month(v_month, v_day);
  end if;
  v_next := public.anchor_date_in_month((v_month + interval '1 month')::date, v_day);

  return query
  select (v_start + time '00:00') at time zone 'Australia/Melbourne',
         (v_next + time '00:00') at time zone 'Australia/Melbourne';
end;
$$;

-- Used / allowance / reset date / state for one business's billing period.
create or replace function public.business_text_usage(p_business_id uuid)
returns table (used bigint, allowance integer, reset_at timestamptz, state text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_anchor date;
  v_start timestamptz;
  v_end timestamptz;
  v_used bigint;
  v_allowance integer;
begin
  select b.monthly_text_cap, b.billing_anchor
    into v_allowance, v_anchor
    from public.businesses b where b.id = p_business_id;
  if v_allowance is null then
    raise exception 'business not found' using errcode = '22023';
  end if;

  select bp.period_start, bp.period_end into v_start, v_end
    from public.billing_period(v_anchor, now()) bp;

  select count(*) into v_used
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not coalesce(m.mock, false)
     and m.sent_at >= v_start
     and m.sent_at < v_end;

  used := v_used;
  allowance := v_allowance;
  reset_at := v_end;
  state := case
    when v_used >= v_allowance then 'paused'
    when v_used * 100 >= v_allowance * 80 then 'warning'
    else 'ok'
  end;
  return next;
end;
$$;

revoke execute on function public.business_text_usage(uuid) from public, anon, authenticated;
grant execute on function public.business_text_usage(uuid) to service_role;

-- Claim respects this business's billing period and ignores mocks.
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

-- Owner dashboard: "this month" is this business's billing period.
drop function if exists public.owner_dashboard(uuid);

create or replace function public.owner_dashboard(p_business_id uuid)
returns table (
  month_start timestamptz,
  month_end timestamptz,
  texts_sent_this_month bigint,
  clicks_this_month bigint,
  click_rate_this_month numeric,
  texts_sent bigint,
  clicks bigint,
  click_rate numeric,
  review_count integer,
  rating numeric,
  starting_review_count integer,
  reviews_gained integer,
  last_snapshot_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anchor date;
  v_start timestamptz;
  v_end timestamptz;
  v_sent bigint;
  v_clicks bigint;
  v_month_sent bigint;
  v_month_clicks bigint;
  v_current integer;
  v_current_rating numeric;
  v_last_date date;
  v_starting integer;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select b.billing_anchor into v_anchor
    from public.businesses b where b.id = p_business_id;
  select bp.period_start, bp.period_end into v_start, v_end
    from public.billing_period(v_anchor, now()) bp;

  -- A click counts against the text that carried its link, so this period's
  -- click rate is the share of this period's texts that were opened.
  select count(*) into v_sent
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not m.mock;

  select count(*) into v_clicks
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not m.mock
     and m.clicked_at is not null;

  select count(*) into v_month_sent
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not m.mock
     and m.sent_at >= v_start
     and m.sent_at < v_end;

  select count(*) into v_month_clicks
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not m.mock
     and m.sent_at >= v_start
     and m.sent_at < v_end
     and m.clicked_at is not null;

  select s.review_count, s.rating, s.snapshot_date
    into v_current, v_current_rating, v_last_date
    from public.review_snapshots s
   where s.business_id = p_business_id
   order by s.snapshot_date desc, s.fetched_at desc
   limit 1;

  v_starting := public.effective_starting_review_count(p_business_id);

  return query
  select
    v_start,
    v_end,
    v_month_sent,
    v_month_clicks,
    case when v_month_sent > 0
         then v_month_clicks::numeric / v_month_sent else 0 end,
    v_sent,
    v_clicks,
    case when v_sent > 0 then v_clicks::numeric / v_sent else 0 end,
    v_current,
    v_current_rating,
    v_starting,
    case when v_current is not null and v_starting is not null
         then v_current - v_starting end,
    v_last_date;
end;
$$;

revoke execute on function public.owner_dashboard(uuid) from anon;
grant execute on function public.owner_dashboard(uuid) to authenticated;

-- Admin listing: usage and results use each business's billing period, and
-- the anchor/reset date are returned for the Allowance editor.
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
  last_snapshot_date date
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
         latest.snapshot_date
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
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

revoke execute on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to service_role;

-- New businesses bill from the day they are created.
create or replace function public.admin_create_business(
  p_name text,
  p_place_id text,
  p_timezone text,
  p_send_mode public.send_mode,
  p_delay_minutes integer,
  p_owner_id uuid,
  p_admin_id uuid,
  p_review_count integer default null
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tz text := coalesce(p_timezone, 'Australia/Melbourne');
begin
  if p_review_count is not null and p_review_count < 0 then
    raise exception 'review count must be zero or more' using errcode = '22023';
  end if;

  insert into public.businesses
    (name, place_id, timezone, send_mode, delay_minutes, owner_id, billing_anchor)
  values (p_name, p_place_id, v_tz, p_send_mode, p_delay_minutes, p_owner_id,
          (now() at time zone v_tz)::date)
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
          jsonb_build_object('business_id', v_id, 'name', p_name));

  return query select v_id;
end;
$$;

revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer)
  from public;
grant execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer)
  to service_role;

-- Admin: move a business onto its Stripe billing date.
create or replace function public.admin_set_billing_anchor(
  p_business_id uuid,
  p_anchor date,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_anchor is null then
    raise exception 'billing date is required' using errcode = '22023';
  end if;

  update public.businesses set billing_anchor = p_anchor where id = p_business_id;
  if not found then
    raise exception 'business not found' using errcode = '22023';
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'set_billing_anchor',
          jsonb_build_object('business_id', p_business_id, 'billing_anchor', p_anchor));
end;
$$;

revoke execute on function public.admin_set_billing_anchor(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_set_billing_anchor(uuid, date, uuid) to service_role;
