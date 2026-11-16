-- ============================================================================
-- Follow-ups: nameless fallback, template validation, base62 tokens.
-- ============================================================================

create extension if not exists pgcrypto;

-- base62 token, at least 8 chars (default 12 = ~71 bits of entropy).
create or replace function public.new_token(p_length integer default 12)
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
           (get_byte(gen_random_bytes(1), 0) % 62) + 1, 1),
    ''
  )
  from generate_series(1, p_length)
$$;

-- Render a template with no first name (and tidy the leftover " ," and spaces).
create or replace function public.render_message_nameless(
  p_template text, p_business text, p_review_link text, p_opt_out text
)
returns text
language sql
stable
as $$
  select regexp_replace(
    regexp_replace(
      public.render_message_text(p_template, '', p_business, p_review_link, p_opt_out),
      ' ,', ',', 'g'),
    '[ ]{2,}', ' ', 'g')
$$;

-- Render for sending: use the first name if it fits 160 GSM-7 characters,
-- otherwise fall back to the nameless version. Never fails, never splits.
create or replace function public.render_send_message(
  p_template text, p_first_name text, p_business text, p_review_link text, p_opt_out text
)
returns text
language sql
stable
as $$
  select case
    when public.gsm7_length(public.render_message_text(p_template, p_first_name, p_business, p_review_link, p_opt_out)) <= 160
      then public.render_message_text(p_template, p_first_name, p_business, p_review_link, p_opt_out)
    else public.render_message_nameless(p_template, p_business, p_review_link, p_opt_out)
  end
$$;

-- Validate a template before saving: it must fit 160 GSM-7 characters when
-- rendered with the nameless fallback, the longest possible link, and the
-- opt-out text.
create or replace function public.validate_template(
  p_template text, p_business text, p_longest_link text, p_opt_out text
)
returns void
language plpgsql
as $$
declare
  v_len integer;
begin
  v_len := public.gsm7_length(
    public.render_message_nameless(p_template, p_business, p_longest_link, p_opt_out)
  );
  if v_len > 160 then
    raise exception 'template renders % GSM-7 characters (max 160)', v_len
      using errcode = '22023';
  end if;
end;
$$;

-- add_customer: also mint the stable opt-out link token for this number.
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

  -- Stable opt-out link token for this number (never regenerated).
  insert into public.opt_out_links (token, business_id, mobile)
  values (public.new_token(), p_business_id, v_mobile)
  on conflict (business_id, mobile) do nothing;

  insert into public.messages (business_id, customer_id, kind, status, token, scheduled_at)
  values (p_business_id, v_customer, 'initial', 'queued', public.new_token(),
          public.next_send_time(now() + make_interval(mins => v_delay), v_timezone))
  returning id into v_message;

  return query select 'queued'::text, v_customer, v_message;
end;
$$;
