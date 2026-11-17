-- Label the opt-out link: templates end with "Opt out: {opt_out}"; in
-- android_gateway/demo the {opt_out} value becomes "Reply STOP".
alter table public.businesses
  alter column message_template set default 'Hi {first_name}, thanks for choosing {business}. Please review us: {review_link} Opt out: {opt_out}';
alter table public.businesses
  alter column reminder_template set default 'Hi {first_name}, a gentle nudge to review {business}: {review_link} Opt out: {opt_out}';

update public.businesses
   set message_template = 'Hi {first_name}, thanks for choosing {business}. Please review us: {review_link} Opt out: {opt_out}',
       reminder_template = 'Hi {first_name}, a gentle nudge to review {business}: {review_link} Opt out: {opt_out}';

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
    v_opt_out := 'Reply STOP';
  else
    select token into v_opt_token from public.opt_out_links
     where business_id = v_business.id and mobile = v_customer.mobile;
    if v_opt_token is not null then
      v_opt_out := rtrim(p_link_domain, '/') || '/o/' || v_opt_token;
    else
      v_opt_out := 'Reply STOP';
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
