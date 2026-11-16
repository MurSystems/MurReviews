-- ============================================================================
-- Stage 4: review-link click recording and opt-out-by-token. Service-role only
-- (called by the Worker with the service_role key).
-- ============================================================================

-- Look up a review link token and, when p_record is true, record the first
-- click (sets clicked_at once and inserts one click_event). Returns the
-- business's place_id so the Worker can build the redirect.
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
       set clicked_at = now(), updated_at = now()
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

-- Opt a number out from its link token: record the opt-out (idempotent) and
-- cancel anything queued/sending. Never removes the opt-out.
create or replace function public.opt_out_by_token(p_token text)
returns table (found boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
begin
  select * into v_link from public.opt_out_links where token = p_token;

  if v_link.token is null then
    return query select false;
    return;
  end if;

  insert into public.opt_outs (business_id, mobile, source)
  values (v_link.business_id, v_link.mobile, 'link')
  on conflict (business_id, mobile) do nothing;

  update public.messages m
     set status = 'opted_out', updated_at = now()
   from public.customers c
   where m.customer_id = c.id
     and c.business_id = v_link.business_id
     and c.mobile = v_link.mobile
     and m.status in ('queued', 'sending');

  return query select true;
end;
$$;

revoke execute on function public.opt_out_by_token(text) from public;
grant execute on function public.opt_out_by_token(text) to service_role;
