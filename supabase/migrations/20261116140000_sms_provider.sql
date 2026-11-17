-- ============================================================================
-- sms_provider as the default mode: per-business sender number, monthly cap,
-- and sender_number in prepare_send.
-- ============================================================================

alter table public.businesses alter column send_mode set default 'sms_provider';

-- The "from" number for this business (owner's verified mobile, or a
-- dedicated number). Null means the operator's own default sender.
alter table public.businesses add column sender_number text;

-- Per-business monthly text cap (low-credit / overage safety net).
alter table public.businesses add column monthly_text_cap integer not null default 500 check (monthly_text_cap >= 0);

-- Claim now respects both the daily and monthly caps.
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
            and mm.sent_at >= date_trunc('month', now())
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

-- prepare_send now also returns the business's sender number.
drop function if exists public.prepare_send(uuid, text);
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
    select token into v_opt_token from public.opt_out_links
     where business_id = v_business.id and mobile = v_customer.mobile;
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

revoke execute on function public.prepare_send(uuid, text) from public;
grant execute on function public.prepare_send(uuid, text) to service_role;
