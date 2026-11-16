-- ============================================================================
-- Stage 5: sender DB logic — render-for-send, mark sent/failed, inbound SMS,
-- gateway heartbeat. All service-role only (called by the Worker).
-- ============================================================================

-- Render the final text for a claimed message: review link + opt-out, with the
-- 160 GSM-7 rule and nameless fallback.
create or replace function public.prepare_send(p_message_id uuid, p_link_domain text)
returns table (mobile text, rendered_text text, send_mode public.send_mode, business_id uuid)
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
         v_business.id;
end;
$$;

revoke execute on function public.prepare_send(uuid, text) from public;
grant execute on function public.prepare_send(uuid, text) to service_role;

-- Record the exact text actually sent, and mark the message sent.
create or replace function public.mark_sent(p_message_id uuid, p_text text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.messages
     set status = 'sent', message_text = p_text, sent_at = now(), updated_at = now()
   where id = p_message_id and status = 'sending';
$$;

revoke execute on function public.mark_sent(uuid, text) from public;
grant execute on function public.mark_sent(uuid, text) to service_role;

create or replace function public.mark_failed(p_message_id uuid, p_error text, p_retryable boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.messages
     set status = 'failed', last_error = p_error, failed_at = now(), retryable = p_retryable, updated_at = now()
   where id = p_message_id and status = 'sending';
$$;

revoke execute on function public.mark_failed(uuid, text, boolean) from public;
grant execute on function public.mark_failed(uuid, text, boolean) to service_role;

-- Inbound SMS from the gateway: STOP-like replies opt the number out and cancel
-- queued messages; anything else is stored as a reply. Matches the business via
-- the device id in gateway_credentials.
create or replace function public.handle_inbound_sms(p_device_id text, p_from_mobile text, p_body text)
returns table (handled boolean, is_stop boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_normalized text;
  v_stop boolean;
begin
  select business_id into v_business
    from public.gateway_credentials
   where payload->>'deviceId' = p_device_id
   limit 1;

  if v_business is null then
    return query select false, false;
    return;
  end if;

  v_stop := upper(btrim(p_body)) like 'STOP%'
         or upper(btrim(p_body)) in ('UNSUBSCRIBE', 'UNSUB', 'CANCEL', 'END', 'QUIT', 'REMOVE');
  v_normalized := public.normalise_au_mobile(p_from_mobile);

  if v_stop then
    if v_normalized is not null then
      insert into public.opt_outs (business_id, mobile, source)
      values (v_business, v_normalized, 'reply')
      on conflict (business_id, mobile) do nothing;

      update public.messages m
         set status = 'opted_out', updated_at = now()
       from public.customers c
       where m.customer_id = c.id
         and c.business_id = v_business
         and c.mobile = v_normalized
         and m.status in ('queued', 'sending');
    end if;
  else
    insert into public.replies (business_id, from_mobile, body)
    values (v_business, coalesce(v_normalized, p_from_mobile), p_body);
  end if;

  return query select true, v_stop;
end;
$$;

revoke execute on function public.handle_inbound_sms(text, text, text) from public;
grant execute on function public.handle_inbound_sms(text, text, text) to service_role;

-- Update the gateway heartbeat.
create or replace function public.touch_gateway(p_device_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gateway_credentials
     set last_seen_at = now(), updated_at = now()
   where payload->>'deviceId' = p_device_id;
$$;

revoke execute on function public.touch_gateway(text) from public;
grant execute on function public.touch_gateway(text) to service_role;
