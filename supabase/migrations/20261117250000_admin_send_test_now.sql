-- ============================================================================
-- Admin "Send test now": create one message that is sent immediately, outside
-- quiet hours and the review delay, to the operator's allowlisted number.
--
-- Normal customer sending is unchanged: add_customer still applies quiet hours
-- and the delay, and claim_due_messages still sends only due queued rows.
--
-- The Worker verifies the caller is an admin, checks the destination against
-- SEND_ALLOWLIST, renders the message with prepare_send, sends it, then calls
-- mark_sent with mock=true. mock keeps test sends out of usage and stats.
-- ============================================================================

create or replace function public.admin_create_test_message(
  p_business_id uuid,
  p_mobile text,
  p_admin_id uuid
)
returns table (
  message_id uuid,
  customer_id uuid,
  send_mode public.send_mode,
  business_name text,
  mobile text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business record;
  v_mobile text;
  v_customer uuid;
  v_message uuid;
begin
  select b.id, b.name, b.send_mode
    into v_business
    from public.businesses b
   where b.id = p_business_id;

  if v_business.id is null then
    raise exception 'business not found' using errcode = '22023';
  end if;

  v_mobile := public.normalise_au_mobile(p_mobile);
  if v_mobile is null then
    raise exception 'invalid mobile' using errcode = '22023';
  end if;

  -- Reuse the existing customer for this number so a test never renames them.
  select c.id
    into v_customer
    from public.customers c
   where c.business_id = p_business_id
     and c.mobile = v_mobile;

  if v_customer is null then
    insert into public.customers (business_id, first_name, mobile)
    values (p_business_id, 'Test', v_mobile)
    returning id into v_customer;
  end if;

  -- status 'sending' and scheduled_at now() bypass the queue: the sender must
  -- not wait for quiet hours or the review delay. mock=true keeps the test out
  -- of the monthly allowance and all statistics.
  insert into public.messages (
    business_id, customer_id, kind, status, token, scheduled_at, attempt_count, mock
  )
  values (
    p_business_id, v_customer, 'initial', 'sending', public.new_token(), now(), 1, true
  )
  returning id into v_message;

  insert into public.audit_log (admin_id, action, details)
  values (
    p_admin_id,
    'send_test_now',
    jsonb_build_object(
      'business_id', p_business_id,
      'mobile', v_mobile,
      'message_id', v_message
    )
  );

  return query
  select v_message, v_customer, v_business.send_mode, v_business.name, v_mobile;
end;
$$;

revoke execute on function public.admin_create_test_message(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_create_test_message(uuid, text, uuid)
  to service_role;
