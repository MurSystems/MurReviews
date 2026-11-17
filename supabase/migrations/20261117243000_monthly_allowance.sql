-- ============================================================================
-- Monthly text allowance: 500 texts per plan month, visible to owners/admins.
--
-- A "month" starts at 00:00 on the 1st, Melbourne time. First texts and
-- reminders both count; mock sends never do. The cap in claim_due_messages
-- pauses sending at the allowance. Queued messages older than 7 days past
-- their scheduled time are cancelled instead of waiting forever.
-- ============================================================================

-- Start of the current Melbourne month as a timestamptz.
create or replace function public.month_start_melbourne(p_at timestamptz default now())
returns timestamptz
language sql
stable
as $$
  select date_trunc('month', p_at at time zone 'Australia/Melbourne')
         at time zone 'Australia/Melbourne';
$$;

-- Start of the next Melbourne month (the reset date).
create or replace function public.next_month_start_melbourne(p_at timestamptz default now())
returns timestamptz
language sql
stable
as $$
  select date_trunc('month', (p_at at time zone 'Australia/Melbourne') + interval '1 month')
         at time zone 'Australia/Melbourne';
$$;

-- Used / allowance / reset date / state for one business. Internal helper:
-- callers must be service-role or an authorised SECURITY DEFINER function.
create or replace function public.business_text_usage(p_business_id uuid)
returns table (used bigint, allowance integer, reset_at timestamptz, state text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz := public.month_start_melbourne(now());
  v_used bigint;
  v_allowance integer;
begin
  select b.monthly_text_cap into v_allowance
    from public.businesses b where b.id = p_business_id;
  if v_allowance is null then
    raise exception 'business not found' using errcode = '22023';
  end if;

  select count(*) into v_used
    from public.messages m
   where m.business_id = p_business_id
     and m.status in ('sent', 'clicked')
     and not coalesce(m.mock, false)
     and m.sent_at >= v_start;

  used := v_used;
  allowance := v_allowance;
  reset_at := public.next_month_start_melbourne(now());
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

-- Owner-facing wrapper: only the business's owner (or an admin) may read it.
create or replace function public.owner_text_usage(p_business_id uuid)
returns table (used bigint, allowance integer, reset_at timestamptz, state text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query select * from public.business_text_usage(p_business_id);
end;
$$;

revoke execute on function public.owner_text_usage(uuid) from public, anon;
grant execute on function public.owner_text_usage(uuid) to authenticated;

-- Claim respects the monthly allowance in Melbourne time and ignores mocks.
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
            and mm.sent_at >= public.month_start_melbourne()
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

-- Cancel queued texts that have waited more than 7 days past their scheduled
-- time (for example, while a business is at its monthly allowance).
create or replace function public.expire_stale_queued_messages()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  update public.messages
     set status = 'failed',
         failed_at = now(),
         retryable = false,
         last_error = 'expired while waiting to send',
         updated_at = now()
   where status = 'queued'
     and scheduled_at < now() - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.expire_stale_queued_messages() from public, anon, authenticated;
grant execute on function public.expire_stale_queued_messages() to service_role;

-- Admin listing: add this month's usage and allowance.
drop function if exists public.admin_list_businesses();
create or replace function public.admin_list_businesses()
returns table (
  id uuid, name text, place_id text, status public.business_status, send_mode public.send_mode,
  trial_text_cap integer, daily_text_cap integer, owner_email text, texts_sent bigint, clicks bigint,
  last_activity timestamptz, gateway_online boolean, logo_url text,
  ai_replies_requested_at timestamptz,
  texts_used_this_month bigint, monthly_text_cap integer, monthly_state text
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
           where m.business_id = b.id and m.status = 'clicked') as clicks,
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
           where m.business_id = b.id) as last_activity,
         coalesce((select g.last_seen_at > now() - interval '5 minutes'
           from public.gateway_credentials g where g.business_id = b.id limit 1), false) as gateway_online,
         b.logo_url,
         (select i.created_at from public.ai_reply_interest i
           where i.business_id = b.id) as ai_replies_requested_at,
         tu.used, b.monthly_text_cap, tu.state
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
    left join lateral public.business_text_usage(b.id) tu on true
   order by b.name;
$$;

revoke execute on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to service_role;

-- Admin: raise or lower one business's monthly allowance.
create or replace function public.admin_set_monthly_cap(
  p_business_id uuid,
  p_cap integer,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_cap is null or p_cap < 0 then
    raise exception 'allowance must be zero or more' using errcode = '22023';
  end if;

  update public.businesses set monthly_text_cap = p_cap where id = p_business_id;
  if not found then
    raise exception 'business not found' using errcode = '22023';
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'set_monthly_cap',
          jsonb_build_object('business_id', p_business_id, 'monthly_text_cap', p_cap));
end;
$$;

revoke execute on function public.admin_set_monthly_cap(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_monthly_cap(uuid, integer, uuid) to service_role;
