-- ============================================================================
-- Stage 3: quiet hours, reminder logic, GSM-7 length, allowlist fix.
-- ============================================================================

-- 1. Allowlist: the PRODUCTION env var is production only when exactly "true".
create or replace function public.send_allowed(
  p_send_mode public.send_mode,
  p_mobile text,
  p_production text,
  p_allowlist text[]
)
returns boolean
language sql
immutable
as $$
  select coalesce(p_production, '') = 'true'
      or p_send_mode = 'log_only'
      or p_mobile = any(coalesce(p_allowlist, array[]::text[]))
$$;

-- 2. The reminder has its own template (must fit 160 GSM-7 with the business
--    name and opt-out included).
alter table public.businesses
  add column reminder_template text not null default
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}';

-- 3. Quiet hours: only send 9am-8pm in the business timezone. Anything else
--    rolls forward to the next 9am (local), DST-aware via AT TIME ZONE.
create or replace function public.next_send_time(p_candidate timestamptz, p_timezone text)
returns timestamptz
language sql
stable
as $$
  select
    case
      when extract(hour from (p_candidate at time zone p_timezone)) between 9 and 19
        then p_candidate
      when extract(hour from (p_candidate at time zone p_timezone)) >= 20
        then ((p_candidate at time zone p_timezone)::date + 1 + time '09:00') at time zone p_timezone
      else ((p_candidate at time zone p_timezone)::date + time '09:00') at time zone p_timezone
    end
$$;

-- 4. GSM-7 length in septets (extended characters count as two).
create or replace function public.gsm7_length(p_text text)
returns integer
language sql
stable
as $$
  select char_length(p_text) + coalesce((
    select count(*) from regexp_split_to_table(p_text, '') c
    where c = any(array['|', '^', '€', '{', '}', '[', ']', '~', chr(92)])
  ), 0)
$$;

-- 5. Render a template by substituting the four placeholders.
create or replace function public.render_message_text(
  p_template text,
  p_first_name text,
  p_business text,
  p_review_link text,
  p_opt_out text
)
returns text
language sql
stable
as $$
  select replace(
    replace(
      replace(
        replace(p_template, '{first_name}', p_first_name),
        '{business}', p_business),
      '{review_link}', p_review_link),
    '{opt_out}', p_opt_out)
$$;

-- 6. add_customer: queue the first text with quiet hours applied in the
--    business's timezone.
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
  v_timezone text;
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

  if exists (select 1 from public.opt_outs o where o.business_id = p_business_id and o.mobile = v_mobile) then
    return query select 'opted_out'::text, null::uuid, null::uuid;
    return;
  end if;

  if exists (
    select 1 from public.customers c
    join public.messages m on m.customer_id = c.id
    where c.business_id = p_business_id and c.mobile = v_mobile
      and m.created_at >= now() - interval '90 days'
  ) then
    return query select 'recent'::text, null::uuid, null::uuid;
    return;
  end if;

  select b.status, b.trial_text_cap, b.delay_minutes, b.timezone
    into v_status, v_cap, v_delay, v_timezone
    from public.businesses b
   where b.id = p_business_id;

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
          public.next_send_time(now() + make_interval(mins => v_delay), v_timezone))
  returning id into v_message;

  return query select 'queued'::text, v_customer, v_message;
end;
$$;

-- 7. Queue reminders: one reminder per initial text, three days after it was
--    sent, if still not clicked, not opted out, business not paused and not
--    over its trial cap. Quiet hours apply to the reminder's send time.
create or replace function public.queue_reminders()
returns table (queued bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  insert into public.messages (business_id, customer_id, kind, parent_id, status, token, scheduled_at)
  select m.business_id, m.customer_id, 'reminder', m.id, 'queued', public.new_token(),
         public.next_send_time(now(), b.timezone)
  from public.messages m
  join public.businesses b on b.id = m.business_id
  join public.customers c on c.id = m.customer_id
  where m.kind = 'initial'
    and m.status = 'sent'
    and m.sent_at <= now() - interval '3 days'
    and b.status <> 'paused'
    and not exists (select 1 from public.opt_outs o where o.business_id = b.id and o.mobile = c.mobile)
    and not exists (select 1 from public.messages rm where rm.parent_id = m.id)
    and (b.status <> 'trial'
         or (select count(*) from public.messages mm
             where mm.business_id = b.id and mm.status in ('sent', 'clicked', 'sending')) < b.trial_text_cap);

  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

revoke execute on function public.queue_reminders() from public;
grant execute on function public.queue_reminders() to service_role;
