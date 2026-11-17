-- ============================================================================
-- Four connected fixes:
--   1. A review-link click now moves the message to 'clicked', so the owner's
--      Activity shows "Link opened" instead of staying on "Sent".
--   2. Mobile Message inbound replies are matched to their message, business
--      and customer, stored, and STOP-like replies become opt-outs.
--   3. Cancelled texts get the 'cancelled' status instead of 'failed'.
--   4. Failed texts carry a plain reason (no stack traces or stack details).
-- ============================================================================

-- ---------- 1. clicks update the message status ----------

create or replace function public.handle_review(p_token text, p_record boolean)
returns table (found boolean, place_id text, first_click boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg record;
  v_first boolean := false;
begin
  select m.id, m.business_id, m.clicked_at, b.place_id
    into v_msg
    from public.messages m
    join public.businesses b on b.id = m.business_id
   where m.token = p_token;

  if v_msg.id is null then
    return query select false, null::text, false;
    return;
  end if;

  if p_record and v_msg.clicked_at is null then
    update public.messages
       set clicked_at = now(),
           status = case when status = 'sent' then 'clicked'::public.message_status else status end,
           updated_at = now()
     where id = v_msg.id and clicked_at is null;

    if found then
      v_first := true;
      insert into public.click_events (message_id, business_id)
      values (v_msg.id, v_msg.business_id);
    end if;
  end if;

  return query select true, v_msg.place_id, v_first;
end;
$$;

revoke execute on function public.handle_review(text, boolean) from public;
grant execute on function public.handle_review(text, boolean) to service_role;

-- A click recorded before this change left the message on 'sent'.
update public.messages
   set status = 'clicked', updated_at = now()
 where clicked_at is not null
   and status = 'sent';

-- ---------- 2. inbound replies from Mobile Message ----------

alter table public.replies
  add column customer_id uuid references public.customers(id) on delete set null,
  add column message_id uuid references public.messages(id) on delete set null,
  add column kind text not null default 'reply' check (kind in ('reply', 'stop'));

-- The provider retries a webhook for up to 10 deliveries, so the same inbound
-- message can arrive more than once. Its pair of numbers and received_at are
-- stable, so they make the reply idempotent.
create unique index replies_inbound_dedupe_idx
  on public.replies (business_id, from_mobile, received_at);

-- Match an inbound reply to its message/business/customer, store it, and turn
-- STOP-like replies (or type=unsubscribe) into opt-outs.
--
-- Matching order: the custom_ref we set when sending is exact; otherwise the
-- most recent text to that number wins, preferring a business that sent from
-- the number the reply arrived at. A dedicated number alone can identify the
-- business even when no outbound message is on file.
create or replace function public.handle_sms_reply(
  p_to_number text,
  p_from_mobile text,
  p_body text,
  p_is_unsubscribe boolean,
  p_custom_ref text,
  p_received_at timestamptz
)
-- The OUT columns cannot be called business_id/customer_id: PL/pgSQL treats
-- them as variables, which collides with the columns in ON CONFLICT.
returns table (matched boolean, is_stop boolean, reply_business_id uuid, reply_customer_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_customer uuid;
  v_message uuid;
  v_mobile text;
  v_to text;
  v_stop boolean;
  v_received timestamptz := coalesce(p_received_at, now());
begin
  v_mobile := public.normalise_au_mobile(p_from_mobile);
  if v_mobile is null then
    return query select false, false, null::uuid, null::uuid;
    return;
  end if;

  -- Exact: the outbound message id or token came back as custom_ref.
  if p_custom_ref is not null and btrim(p_custom_ref) <> '' then
    select m.business_id, m.customer_id, m.id
      into v_business, v_customer, v_message
      from public.messages m
      join public.customers c on c.id = m.customer_id
     where (m.id::text = btrim(p_custom_ref) or m.token = btrim(p_custom_ref))
       and c.mobile = v_mobile
     limit 1;
  end if;

  if v_business is null then
    v_to := regexp_replace(coalesce(p_to_number, ''), '\D', '', 'g');
    select m.business_id, m.customer_id, m.id
      into v_business, v_customer, v_message
      from public.messages m
      join public.customers c on c.id = m.customer_id
      join public.businesses b on b.id = m.business_id
     where c.mobile = v_mobile
       and m.sent_at is not null
       and m.sent_at > now() - interval '90 days'
     order by (case
                 when v_to <> ''
                   and regexp_replace(coalesce(b.sender_number, ''), '\D', '', 'g') = v_to
                 then 1 else 0
               end) desc,
              m.sent_at desc
     limit 1;
  end if;

  if v_business is null and coalesce(p_to_number, '') <> '' then
    v_to := regexp_replace(p_to_number, '\D', '', 'g');
    select b.id into v_business
      from public.businesses b
     where regexp_replace(coalesce(b.sender_number, ''), '\D', '', 'g') = v_to
     limit 1;
  end if;

  if v_business is null then
    return query select false, false, null::uuid, null::uuid;
    return;
  end if;

  if v_customer is null then
    select c.id into v_customer
      from public.customers c
     where c.business_id = v_business and c.mobile = v_mobile
     limit 1;
  end if;

  v_stop := coalesce(p_is_unsubscribe, false)
         or upper(btrim(p_body)) like 'STOP%'
         or upper(regexp_replace(btrim(p_body), '\s+', ' ', 'g')) in (
              'UNSUBSCRIBE', 'UNSUB', 'CANCEL', 'END', 'QUIT', 'REMOVE',
              'OPT OUT', 'OPT-OUT', 'OPTOUT'
            );

  insert into public.replies (
    business_id, customer_id, message_id, from_mobile, body, kind, received_at
  )
  values (
    v_business, v_customer, v_message, v_mobile, p_body,
    case when v_stop then 'stop' else 'reply' end,
    v_received
  )
  on conflict (business_id, from_mobile, received_at) do nothing;

  if v_stop then
    insert into public.opt_outs (business_id, mobile, source)
    values (v_business, v_mobile, 'reply')
    on conflict (business_id, mobile) do nothing;

    update public.messages m
       set status = 'opted_out', updated_at = now()
      from public.customers c
     where m.customer_id = c.id
       and c.business_id = v_business
       and c.mobile = v_mobile
       and m.status in ('queued', 'sending');
  end if;

  return query select true, v_stop, v_business, v_customer;
end;
$$;

revoke execute on function public.handle_sms_reply(text, text, text, boolean, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.handle_sms_reply(text, text, text, boolean, text, timestamptz)
  to service_role;

-- ---------- 3. cancelled is not a failure ----------

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
     set status = 'cancelled',
         failed_at = now(),
         retryable = false,
         last_error = 'Cancelled after waiting more than 7 days to send.',
         updated_at = now()
   where status = 'queued'
     and scheduled_at < now() - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.expire_stale_queued_messages() from public, anon, authenticated;
grant execute on function public.expire_stale_queued_messages() to service_role;

create or replace function public.cancel_dev_messages()
returns table (cancelled bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  update public.messages
     set status = 'cancelled',
         failed_at = now(),
         retryable = false,
         last_error = 'Cancelled before go-live.',
         updated_at = now()
   where status in ('queued', 'sending');
  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

revoke execute on function public.cancel_dev_messages() from public, anon, authenticated;
grant execute on function public.cancel_dev_messages() to service_role;

-- Existing rows cancelled by hand kept status 'failed'.
update public.messages
   set status = 'cancelled',
       last_error = case
         when last_error = 'expired while waiting to send'
           then 'Cancelled after waiting more than 7 days to send.'
         else 'Cancelled before it was sent.'
       end,
       updated_at = now()
 where status = 'failed'
   and (last_error ilike 'cancel%' or last_error = 'expired while waiting to send');

-- ---------- 4. plain reasons for real failures ----------

update public.messages
   set last_error = case
     when last_error ilike '%InvalidCharacterError%' or last_error ilike '%btoa%'
       then 'The text provider rejected the login. Check the provider settings.'
     when last_error like '%(401)%' or last_error like '%(403)%'
       then 'The text provider rejected the login. Check the provider settings.'
     when last_error like '%(429)%'
       then 'The text provider was limiting sends. Try again later.'
     when last_error ilike '%not allowlisted%'
       then 'This number is not on the test allowlist, so the text was not sent.'
     when last_error ilike '%no recipient%'
       then 'There is no phone number for this customer.'
     when last_error ilike '%fetch failed%' or last_error ilike '%network%'
       or last_error ilike '%timed out%'
       then 'The text provider could not be reached.'
     else 'The text could not be sent.'
   end,
   updated_at = now()
 where status = 'failed'
   and last_error ~ 'send failed|btoa|InvalidCharacterError|timeout|network|failed|allowlisted|recipient';
