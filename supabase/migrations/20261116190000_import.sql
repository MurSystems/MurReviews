-- ============================================================================
-- CSV import: validate, dedupe, skip opted-out / recent, drip at daily_send_cap
-- per day. p_commit=false is a dry-run (returns a summary without queueing).
-- ============================================================================

create or replace function public.import_customers(
  p_business_id uuid,
  p_rows jsonb,
  p_commit boolean
)
returns table (will_send bigint, skipped_invalid bigint, skipped_opted_out bigint, skipped_recent bigint, skipped_duplicate bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily_cap integer;
  v_timezone text;
  v_delay integer;
  v_row record;
  v_mobile text;
  v_will_send bigint := 0;
  v_skipped_invalid bigint := 0;
  v_skipped_opted_out bigint := 0;
  v_skipped_recent bigint := 0;
  v_skipped_duplicate bigint := 0;
  v_seen text[] := '{}';
  v_scheduled timestamptz;
  v_customer uuid;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select daily_send_cap, timezone, delay_minutes
    into v_daily_cap, v_timezone, v_delay
    from public.businesses where id = p_business_id;

  for v_row in
    select * from jsonb_to_recordset(p_rows) as x(name text, mobile text)
  loop
    v_mobile := public.normalise_au_mobile(v_row.mobile);
    if v_mobile is null or v_row.name is null or btrim(v_row.name) = '' then
      v_skipped_invalid := v_skipped_invalid + 1;
      continue;
    end if;

    if exists (select 1 from public.opt_outs where business_id = p_business_id and mobile = v_mobile) then
      v_skipped_opted_out := v_skipped_opted_out + 1;
      continue;
    end if;

    if v_mobile = any(v_seen) then
      v_skipped_duplicate := v_skipped_duplicate + 1;
      continue;
    end if;
    v_seen := v_seen || v_mobile;

    if exists (
      select 1 from public.customers c join public.messages m on m.customer_id = c.id
      where c.business_id = p_business_id and c.mobile = v_mobile
        and m.created_at >= now() - interval '90 days'
    ) then
      v_skipped_recent := v_skipped_recent + 1;
      continue;
    end if;

    v_will_send := v_will_send + 1;

    if p_commit then
      insert into public.customers (business_id, first_name, mobile)
      values (p_business_id, btrim(v_row.name), v_mobile)
      on conflict (business_id, mobile) do update set first_name = excluded.first_name
      returning id into v_customer;

      insert into public.opt_out_links (token, business_id, mobile)
      values (public.new_token(), p_business_id, v_mobile)
      on conflict (business_id, mobile) do nothing;

      -- drip: stagger so at most daily_send_cap become due each day.
      v_scheduled := public.next_send_time(
        now() + make_interval(mins => v_delay)
             + make_interval(days => ((v_will_send - 1) / v_daily_cap)::int),
        v_timezone
      );

      insert into public.messages (business_id, customer_id, kind, status, token, scheduled_at)
      values (p_business_id, v_customer, 'initial', 'queued', public.new_token(), v_scheduled);
    end if;
  end loop;

  return query select v_will_send, v_skipped_invalid, v_skipped_opted_out, v_skipped_recent, v_skipped_duplicate;
end;
$$;
