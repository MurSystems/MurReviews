-- ============================================================================
-- CSV import end-to-end fixes:
--   1. Report a missing name separately from a bad mobile number.
--   2. Mark queued messages for a log_only business as mock (it can never
--      deliver for real, so those rows must not look like live sends).
--   3. Fix prepare_send's ambiguous business_id/mobile references, which made
--      every sms_provider/log_only send fail with SQLSTATE 42702.
-- ============================================================================

drop function if exists public.import_customers(uuid, jsonb, boolean);

create or replace function public.import_customers(
  p_business_id uuid,
  p_rows jsonb,
  p_commit boolean
)
returns table (
  will_send bigint,
  skipped_invalid bigint,
  skipped_opted_out bigint,
  skipped_recent bigint,
  skipped_duplicate bigint,
  skipped_missing_name bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily_cap integer;
  v_timezone text;
  v_delay integer;
  v_send_mode public.send_mode;
  v_row record;
  v_mobile text;
  v_will_send bigint := 0;
  v_skipped_invalid bigint := 0;
  v_skipped_opted_out bigint := 0;
  v_skipped_recent bigint := 0;
  v_skipped_duplicate bigint := 0;
  v_skipped_missing_name bigint := 0;
  v_seen text[] := '{}';
  v_scheduled timestamptz;
  v_customer uuid;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select daily_send_cap, timezone, delay_minutes, send_mode
    into v_daily_cap, v_timezone, v_delay, v_send_mode
    from public.businesses where id = p_business_id;

  for v_row in
    select * from jsonb_to_recordset(p_rows) as x(name text, mobile text)
  loop
    v_mobile := public.normalise_au_mobile(v_row.mobile);
    if v_mobile is null then
      v_skipped_invalid := v_skipped_invalid + 1;
      continue;
    end if;

    if v_row.name is null or btrim(v_row.name) = '' then
      v_skipped_missing_name := v_skipped_missing_name + 1;
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

      insert into public.messages (business_id, customer_id, kind, status, token, scheduled_at, mock)
      values (p_business_id, v_customer, 'initial', 'queued', public.new_token(), v_scheduled,
              v_send_mode = 'log_only');
    end if;
  end loop;

  return query select v_will_send, v_skipped_invalid, v_skipped_opted_out, v_skipped_recent,
                      v_skipped_duplicate, v_skipped_missing_name;
end;
$$;

-- Qualify the opt-out link columns: the OUT parameters (mobile, business_id)
-- shadow the table columns and made every non-demo send fail at runtime.
create or replace function public.prepare_send(p_message_id uuid, p_link_domain text)
returns table (mobile text, rendered_text text, send_mode public.send_mode, business_id uuid, sender_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg record;
  v_customer record;
  v_business record;
  v_opt_token text;
  v_review_link text;
  v_opt_out text;
  v_template text;
begin
  select * into v_msg from public.messages where id = p_message_id;
  if v_msg.id is null then
    raise exception 'message not found' using errcode = '22023';
  end if;

  select * into v_customer from public.customers where id = v_msg.customer_id;
  select * into v_business from public.businesses where id = v_msg.business_id;

  v_template := case when v_msg.kind = 'reminder' then v_business.reminder_template
                     else v_business.message_template end;

  v_review_link := rtrim(p_link_domain, '/') || '/r/' || v_msg.token;

  if v_business.send_mode in ('android_gateway', 'demo') then
    v_opt_out := 'Reply STOP to opt out';
  else
    select o.token into v_opt_token from public.opt_out_links o
     where o.business_id = v_business.id and o.mobile = v_customer.mobile;
    if v_opt_token is not null then
      v_opt_out := rtrim(p_link_domain, '/') || '/o/' || v_opt_token;
    else
      v_opt_out := 'Reply STOP to opt out';
    end if;
  end if;

  return query
  select v_customer.mobile,
         public.render_send_message(v_template, v_customer.first_name, v_business.name, v_review_link, v_opt_out),
         v_business.send_mode,
         v_business.id,
         v_business.sender_number;
end;
$$;
