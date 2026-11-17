-- ============================================================================
-- Results tracking: this-month and all-time texts/clicks/click rate, Google
-- rating and review count, and reviews gained since joining.
--
-- Review counts come from Places API snapshots when a key is configured. Until
-- then an admin records the count by hand against a date; those rows live in
-- the same review_snapshots table with source = 'manual'. The count recorded
-- when a business is created is the starting point.
--
-- Mock/test sends are excluded from every number here.
-- ============================================================================

-- Where a snapshot came from. Existing rows were all written by the Places
-- cron, so the default is 'places'.
alter table public.review_snapshots
  add column source text not null default 'places'
    check (source in ('places', 'manual'));

-- When the explicit starting count was recorded (at business creation). A
-- business created with a genuine 0 reviews must still count as recorded.
alter table public.businesses
  add column starting_review_recorded_at timestamptz;

update public.businesses b
   set starting_review_recorded_at = coalesce(
         (select min(s.fetched_at) from public.review_snapshots s
           where s.business_id = b.id),
         b.created_at)
 where b.starting_review_count <> 0
   and b.starting_review_recorded_at is null;

-- The effective baseline: the explicit starting count, otherwise the earliest
-- recorded snapshot. Keeping this in one place means a backdated manual entry
-- also becomes the baseline.
create or replace function public.effective_starting_review_count(
  p_business_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_recorded timestamptz;
begin
  select b.starting_review_count, b.starting_review_recorded_at
    into v_count, v_recorded
    from public.businesses b
   where b.id = p_business_id;

  -- A non-zero count is an explicit baseline even for older rows that predate
  -- starting_review_recorded_at. A recorded 0 is still explicit.
  if v_recorded is not null or coalesce(v_count, 0) <> 0 then
    return v_count;
  end if;

  select s.review_count into v_count
    from public.review_snapshots s
   where s.business_id = p_business_id
     and s.review_count is not null
   order by s.snapshot_date asc, s.fetched_at asc
   limit 1;

  return v_count;
end;
$$;

revoke execute on function public.effective_starting_review_count(uuid)
  from public, anon, authenticated;
grant execute on function public.effective_starting_review_count(uuid)
  to service_role;

-- ---------- Places snapshot: mark the source ----------

create or replace function public.record_review_snapshot(
  p_business_id uuid,
  p_rating numeric,
  p_review_count integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := to_char(now(), 'YYYY-MM');
begin
  insert into public.review_snapshots
    (business_id, snapshot_date, rating, review_count, source)
  values (p_business_id, current_date, p_rating, p_review_count, 'places')
  on conflict (business_id, snapshot_date)
  do update set rating = excluded.rating,
                review_count = excluded.review_count,
                source = 'places',
                fetched_at = now();

  insert into public.places_api_usage (month, request_count) values (v_month, 1)
  on conflict (month) do update
    set request_count = public.places_api_usage.request_count + 1,
        updated_at = now();
end;
$$;

revoke execute on function public.record_review_snapshot(uuid, numeric, integer)
  from anon, authenticated;
grant execute on function public.record_review_snapshot(uuid, numeric, integer)
  to service_role;

-- ---------- admin: record a Google review count by hand ----------

create or replace function public.admin_record_review_snapshot(
  p_business_id uuid,
  p_review_count integer,
  p_snapshot_date date,
  p_rating numeric,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timezone text;
  v_date date;
begin
  if p_review_count is null or p_review_count < 0 then
    raise exception 'review count must be zero or more' using errcode = '22023';
  end if;
  if p_rating is not null and (p_rating < 0 or p_rating > 5) then
    raise exception 'rating must be between 0 and 5' using errcode = '22023';
  end if;

  select b.timezone into v_timezone
    from public.businesses b where b.id = p_business_id;
  if v_timezone is null then
    raise exception 'business not found' using errcode = '22023';
  end if;

  v_date := coalesce(p_snapshot_date, (now() at time zone v_timezone)::date);

  insert into public.review_snapshots
    (business_id, snapshot_date, rating, review_count, source)
  values (p_business_id, v_date, p_rating, p_review_count, 'manual')
  on conflict (business_id, snapshot_date)
  do update set review_count = excluded.review_count,
                rating = coalesce(excluded.rating, review_snapshots.rating),
                source = 'manual',
                fetched_at = now();

  insert into public.audit_log (admin_id, action, details)
  values (
    p_admin_id,
    'record_review_count',
    jsonb_build_object(
      'business_id', p_business_id,
      'review_count', p_review_count,
      'snapshot_date', v_date,
      'rating', p_rating
    )
  );
end;
$$;

revoke execute on function public.admin_record_review_snapshot(uuid, integer, date, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_record_review_snapshot(uuid, integer, date, numeric, uuid)
  to service_role;

-- ---------- create a business with its starting review count ----------

drop function if exists public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid);

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
    (name, place_id, timezone, send_mode, delay_minutes, owner_id)
  values (p_name, p_place_id, v_tz, p_send_mode, p_delay_minutes, p_owner_id)
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

-- ---------- owner dashboard: this month, all time and reviews ----------

drop function if exists public.owner_dashboard(uuid);

create or replace function public.owner_dashboard(p_business_id uuid)
returns table (
  month_start timestamptz,
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
  v_start timestamptz := public.month_start_melbourne(now());
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

  -- A click counts against the text that carried its link, so this month's
  -- click rate is the share of this month's texts that were opened.
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
     and m.sent_at >= v_start;

  select count(*) into v_month_clicks
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not m.mock
     and m.sent_at >= v_start
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

-- ---------- admin listing: the same numbers per business ----------

drop function if exists public.admin_list_businesses();

create or replace function public.admin_list_businesses()
returns table (
  id uuid, name text, place_id text, status public.business_status, send_mode public.send_mode,
  trial_text_cap integer, daily_text_cap integer, owner_email text, texts_sent bigint, clicks bigint,
  last_activity timestamptz, gateway_online boolean, logo_url text,
  ai_replies_requested_at timestamptz,
  texts_used_this_month bigint, monthly_text_cap integer, monthly_state text,
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
    left join lateral public.business_text_usage(b.id) tu on true
    left join lateral (
      select count(*) as sent
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= public.month_start_melbourne()
    ) month_sent on true
    left join lateral (
      select count(*) as clicks
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= public.month_start_melbourne()
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
