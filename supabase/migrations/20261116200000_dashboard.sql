-- ============================================================================
-- Dashboard: starting review count, review snapshots, owner dashboard stats.
-- ============================================================================

alter table public.businesses add column starting_review_count integer not null default 0;

-- Record one Places snapshot. On the first snapshot, record the starting
-- review count. Tracks usage in places_api_usage (service-role only).
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
  insert into public.review_snapshots (business_id, snapshot_date, rating, review_count)
  values (p_business_id, current_date, p_rating, p_review_count)
  on conflict (business_id, snapshot_date)
  do update set rating = excluded.rating, review_count = excluded.review_count, fetched_at = now();

  update public.businesses
     set starting_review_count = p_review_count
   where id = p_business_id and starting_review_count = 0;

  insert into public.places_api_usage (month, request_count) values (v_month, 1)
  on conflict (month) do update set request_count = public.places_api_usage.request_count + 1, updated_at = now();
end;
$$;

revoke execute on function public.record_review_snapshot(uuid, numeric, integer) from anon, authenticated;
grant execute on function public.record_review_snapshot(uuid, numeric, integer) to service_role;

-- Owner dashboard: headline numbers. Mock sends are excluded.
create or replace function public.owner_dashboard(p_business_id uuid)
returns table (
  texts_sent bigint,
  clicks bigint,
  click_rate numeric,
  review_count integer,
  rating numeric,
  starting_review_count integer,
  reviews_gained integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent bigint;
  v_clicks bigint;
  v_current integer;
  v_start integer;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select count(*) into v_sent from public.messages m
   where m.business_id = p_business_id and m.status in ('sent','clicked') and not m.mock;
  select count(*) into v_clicks from public.messages m
   where m.business_id = p_business_id and m.status = 'clicked';
  select review_count into v_current from public.review_snapshots s
   where s.business_id = p_business_id order by s.snapshot_date desc limit 1;
  select starting_review_count into v_start from public.businesses b where b.id = p_business_id;

  return query
  select
    v_sent,
    v_clicks,
    case when v_sent > 0 then v_clicks::numeric / v_sent else 0 end,
    v_current,
    (select rating from public.review_snapshots s where s.business_id = p_business_id order by s.snapshot_date desc limit 1),
    v_start,
    coalesce(v_current, 0) - v_start;
end;
$$;

revoke execute on function public.owner_dashboard(uuid) from anon;
grant execute on function public.owner_dashboard(uuid) to authenticated;

-- Admin: monthly Places usage vs a passed cap, and the per-business cap.
create or replace function public.admin_places_usage()
returns table (month text, request_count integer)
language sql
security definer
set search_path = public
as $$
  select month, request_count from public.places_api_usage order by month desc;
$$;

revoke execute on function public.admin_places_usage() from anon, authenticated;
grant execute on function public.admin_places_usage() to service_role;
