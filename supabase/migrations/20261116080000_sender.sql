-- ============================================================================
-- Stage 5: sender safety — per-business daily send cap and gateway heartbeat.
-- ============================================================================

-- Daily send cap (safety net; distinct from the CSV drip cap).
alter table public.businesses
  add column daily_text_cap integer not null default 100 check (daily_text_cap >= 0);

-- Gateway heartbeat: last time the device checked in (system:ping webhook).
alter table public.gateway_credentials
  add column last_seen_at timestamptz;

-- Claim now respects the daily send cap per business.
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
      order by m.scheduled_at
      limit p_batch_limit
      for update of m skip locked
   )
   returning *;
end;
$$;

revoke execute on function public.claim_due_messages(integer) from public;
grant execute on function public.claim_due_messages(integer) to service_role;
