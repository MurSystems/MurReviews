-- ============================================================================
-- Fix for 20261117261000: its handle_sms_reply OUT columns were named
-- business_id/customer_id, which PL/pgSQL treats as variables and collides
-- with the columns in ON CONFLICT (SQLSTATE 42702 on every reply).
--
-- The return type changes, so the function is dropped and recreated. Fresh
-- databases run 20261117261000 (already corrected) and then this identical
-- definition; existing databases get the fix here.
-- ============================================================================

drop function if exists public.handle_sms_reply(text, text, text, boolean, text, timestamptz);

create or replace function public.handle_sms_reply(
  p_to_number text,
  p_from_mobile text,
  p_body text,
  p_is_unsubscribe boolean,
  p_custom_ref text,
  p_received_at timestamptz
)
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
