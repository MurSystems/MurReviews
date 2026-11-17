-- Fix ambiguous column references in owner_dashboard.
drop function if exists public.owner_dashboard(uuid);
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
  select s.review_count into v_current from public.review_snapshots s
   where s.business_id = p_business_id order by s.snapshot_date desc limit 1;
  select b.starting_review_count into v_start from public.businesses b where b.id = p_business_id;

  return query
  select
    v_sent,
    v_clicks,
    case when v_sent > 0 then v_clicks::numeric / v_sent else 0 end,
    v_current,
    (select s.rating from public.review_snapshots s where s.business_id = p_business_id order by s.snapshot_date desc limit 1),
    v_start,
    coalesce(v_current, 0) - v_start;
end;
$$;

revoke execute on function public.owner_dashboard(uuid) from anon;
grant execute on function public.owner_dashboard(uuid) to authenticated;
