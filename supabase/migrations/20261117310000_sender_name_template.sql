-- ============================================================================
-- Texts that do not look like spam.
--
--  * businesses.sender_name — the owner's first name, used in the text.
--  * A new default initial template in plain language, plus {sender_name}.
--  * Rendering falls back gracefully when the sender name is missing, and
--    keeps the 160 GSM-7 / nameless fallback.
--  * admin_preview_message() renders the exact text that would go out so the
--    admin can see it and its length.
-- ============================================================================

alter table public.businesses
  add column sender_name text;

-- ---------- rendering ----------

-- Render by substituting the placeholders. Missing values are dropped cleanly:
-- no first name leaves "Hi,"; no sender name turns "it's  from" into "from".
drop function if exists public.render_message_text(text, text, text, text, text);

create or replace function public.render_message_text(
  p_template text,
  p_first_name text,
  p_business text,
  p_review_link text,
  p_opt_out text,
  p_sender_name text default null
)
returns text
language sql
stable
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        replace(
          replace(
            replace(
              replace(
                replace(p_template, '{first_name}', coalesce(p_first_name, '')),
                '{sender_name}', coalesce(p_sender_name, '')),
              '{business}', coalesce(p_business, '')),
            '{review_link}', coalesce(p_review_link, '')),
          '{opt_out}', coalesce(p_opt_out, '')),
        ',\s*it''s\s+from\s+', ' from ', 'i'),
      '\s+,', ',', 'g'),
    '[ ]{2,}', ' ', 'g')
$$;

drop function if exists public.render_message_nameless(text, text, text, text);

create or replace function public.render_message_nameless(
  p_template text,
  p_business text,
  p_review_link text,
  p_opt_out text,
  p_sender_name text default null
)
returns text
language sql
stable
as $$
  select public.render_message_text(
    p_template, '', p_business, p_review_link, p_opt_out, p_sender_name)
$$;

drop function if exists public.render_send_message(text, text, text, text, text);

create or replace function public.render_send_message(
  p_template text,
  p_first_name text,
  p_business text,
  p_review_link text,
  p_opt_out text,
  p_sender_name text default null
)
returns text
language sql
stable
as $$
  select case
    when public.gsm7_length(
           public.render_message_text(
             p_template, p_first_name, p_business, p_review_link, p_opt_out, p_sender_name)
         ) <= 160
      then public.render_message_text(
             p_template, p_first_name, p_business, p_review_link, p_opt_out, p_sender_name)
    else public.render_message_nameless(
           p_template, p_business, p_review_link, p_opt_out, p_sender_name)
  end
$$;

-- How many SMS segments a text of this length takes (160, then 153 each).
create or replace function public.gsm7_segments(p_length integer)
returns integer
language sql
immutable
as $$
  select case when p_length <= 160 then 1 else ceil(p_length / 153.0)::integer end
$$;

drop function if exists public.validate_template(text, text, text, text);

create or replace function public.validate_template(
  p_template text,
  p_business text,
  p_longest_link text,
  p_opt_out text,
  p_sender_name text default null
)
returns void
language plpgsql
as $$
declare
  v_len integer;
begin
  v_len := public.gsm7_length(
    public.render_message_nameless(p_template, p_business, p_longest_link, p_opt_out, p_sender_name)
  );
  if v_len > 160 then
    raise exception 'template renders % GSM-7 characters (max 160)', v_len
      using errcode = '22023';
  end if;
end;
$$;

-- ---------- new defaults ----------

alter table public.businesses
  alter column message_template set default
    'Hi {first_name}, it''s {sender_name} from {business}. Thanks for choosing us. If you have a minute, a quick Google review would really help: {review_link} Opt out: {opt_out}',
  alter column reminder_template set default
    'Hi {first_name}, it''s {sender_name} from {business} again. If you have a minute, a quick Google review would really help: {review_link} Opt out: {opt_out}';

-- Only replace businesses still on the previous defaults; custom templates stay.
update public.businesses
   set message_template =
     'Hi {first_name}, it''s {sender_name} from {business}. Thanks for choosing us. If you have a minute, a quick Google review would really help: {review_link} Opt out: {opt_out}'
 where message_template =
     'Hi {first_name}, thanks for choosing {business}. Please review us: {review_link} Opt out: {opt_out}';

update public.businesses
   set reminder_template =
     'Hi {first_name}, it''s {sender_name} from {business} again. If you have a minute, a quick Google review would really help: {review_link} Opt out: {opt_out}'
 where reminder_template =
     'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}';

-- ---------- sender name ----------

create or replace function public.admin_set_sender_name(
  p_business_id uuid,
  p_sender_name text,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(coalesce(p_sender_name, '')), '');
begin
  if v_name is not null and char_length(v_name) > 40 then
    raise exception 'sender name is too long' using errcode = '22023';
  end if;

  update public.businesses
     set sender_name = v_name
   where id = p_business_id;
  if not found then
    raise exception 'business not found' using errcode = '22023';
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'set_sender_name',
          jsonb_build_object('business_id', p_business_id, 'sender_name', v_name));
end;
$$;

revoke execute on function public.admin_set_sender_name(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_set_sender_name(uuid, text, uuid) to service_role;

-- ---------- preview: the exact text that would go out ----------

create or replace function public.admin_preview_message(
  p_business_id uuid,
  p_link_domain text
)
returns table (example_text text, gsm7_length integer, segments integer, template text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business record;
  v_link text;
  v_opt_out text;
  v_text text;
  v_len integer;
begin
  select * into v_business from public.businesses where id = p_business_id;
  if v_business.id is null then
    raise exception 'business not found' using errcode = '22023';
  end if;

  v_link := rtrim(p_link_domain, '/') || '/r/abcdEFGH12';
  if v_business.send_mode = 'demo' then
    v_opt_out := 'Reply STOP to opt out';
  else
    v_opt_out := rtrim(p_link_domain, '/') || '/o/abcdEFGH12';
  end if;

  v_text := public.render_send_message(
    v_business.message_template, 'Mia', v_business.name, v_link, v_opt_out,
    v_business.sender_name);
  v_len := public.gsm7_length(v_text);

  return query select v_text, v_len, public.gsm7_segments(v_len), v_business.message_template;
end;
$$;

revoke execute on function public.admin_preview_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_preview_message(uuid, text) to service_role;

-- ---------- send with the sender name ----------

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

  -- android_gateway replies are handled by the webhook too, but a tappable
  -- link is easier and is the only opt-out path for sms_provider.
  if v_business.send_mode = 'demo' then
    v_opt_out := 'Reply STOP to opt out';
  else
    select o.token into v_opt_token from public.opt_out_links o
     where o.business_id = v_business.id and o.mobile = v_customer.mobile;
    if v_opt_token is not null then
      v_opt_out := rtrim(p_link_domain, '/') || '/o/' || v_opt_token;
    else
      v_opt_out := 'Reply STOP to opt out';
    end if;
  end if;

  return query
  select v_customer.mobile,
         public.render_send_message(v_template, v_customer.first_name, v_business.name,
                                    v_review_link, v_opt_out, v_business.sender_name),
         v_business.send_mode,
         v_business.id,
         v_business.sender_number;
end;
$$;

revoke execute on function public.prepare_send(uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_send(uuid, text) to service_role;

-- ---------- create business with a sender name ----------

drop function if exists public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer, text);

create or replace function public.admin_create_business(
  p_name text,
  p_place_id text,
  p_timezone text,
  p_send_mode public.send_mode,
  p_delay_minutes integer,
  p_owner_id uuid,
  p_admin_id uuid,
  p_review_count integer default null,
  p_sender_number text default null,
  p_sender_name text default null
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tz text := coalesce(p_timezone, 'Australia/Melbourne');
  v_sender text;
  v_sender_name text := nullif(btrim(coalesce(p_sender_name, '')), '');
begin
  if p_review_count is not null and p_review_count < 0 then
    raise exception 'review count must be zero or more' using errcode = '22023';
  end if;

  if p_sender_number is not null and btrim(p_sender_number) <> '' then
    v_sender := public.normalise_au_mobile(p_sender_number);
    if v_sender is null then
      raise exception 'sender must be an Australian mobile number' using errcode = '22023';
    end if;
  end if;

  insert into public.businesses
    (name, place_id, timezone, send_mode, delay_minutes, owner_id, billing_anchor,
     sender_number, sender_name)
  values (p_name, p_place_id, v_tz, p_send_mode, p_delay_minutes, p_owner_id,
          (now() at time zone v_tz)::date, v_sender, v_sender_name)
  returning businesses.id into v_id;

  -- The count on the day the business joins is the baseline for "reviews
  -- gained since joining".
  if p_review_count is not null then
    insert into public.review_snapshots
      (business_id, snapshot_date, review_count, source)
    values (v_id, (now() at time zone v_tz)::date, p_review_count, 'manual');

    update public.businesses
       set starting_review_count = p_review_count,
           starting_review_recorded_at = now()
     where businesses.id = v_id;
  end if;

  insert into public.audit_log (admin_id, action, details)
  values (p_admin_id, 'create_business',
          jsonb_build_object('business_id', v_id, 'name', p_name,
                             'sender_number', v_sender, 'sender_name', v_sender_name));

  return query select v_id;
end;
$$;

revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer, text, text)
  to service_role;

-- ---------- admin listing: sender name ----------

drop function if exists public.admin_list_businesses();

create or replace function public.admin_list_businesses()
returns table (
  id uuid, name text, place_id text, status public.business_status, send_mode public.send_mode,
  trial_text_cap integer, daily_text_cap integer, owner_email text, texts_sent bigint, clicks bigint,
  last_activity timestamptz, gateway_online boolean, logo_url text,
  ai_replies_requested_at timestamptz,
  texts_used_this_month bigint, monthly_text_cap integer, monthly_state text,
  billing_anchor date, billing_period_end timestamptz,
  texts_sent_this_month bigint, clicks_this_month bigint, click_rate_this_month numeric,
  review_count integer, rating numeric, starting_review_count integer, reviews_gained integer,
  last_snapshot_date date,
  sender_number text, sender_name text, sender_verified_at timestamptz, sender_checked_at timestamptz,
  tests_count bigint,
  payment_taken_at timestamptz, number_verified_at timestamptz,
  onboarding_created_at timestamptz, login_link_sent_at timestamptz,
  test_text_sent_at timestamptz
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
           where m.business_id = b.id and m.status in ('sent','clicked')
             and not m.mock and m.clicked_at is not null) as clicks,
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
           where m.business_id = b.id) as last_activity,
         coalesce((select g.last_seen_at > now() - interval '5 minutes'
           from public.gateway_credentials g where g.business_id = b.id limit 1), false) as gateway_online,
         b.logo_url,
         (select i.created_at from public.ai_reply_interest i
           where i.business_id = b.id) as ai_replies_requested_at,
         tu.used, b.monthly_text_cap, tu.state,
         b.billing_anchor, bp.period_end,
         month_sent.sent as texts_sent_this_month,
         month_click.clicks as clicks_this_month,
         case when month_sent.sent > 0
              then month_click.clicks::numeric / month_sent.sent else 0 end,
         latest.review_count, latest.rating,
         public.effective_starting_review_count(b.id),
         case when latest.review_count is not null
                   and public.effective_starting_review_count(b.id) is not null
              then latest.review_count - public.effective_starting_review_count(b.id) end,
         latest.snapshot_date,
         b.sender_number, b.sender_name, b.sender_verified_at, b.sender_checked_at,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.mock
             and m.status in ('sent','clicked')) as tests_count,
         o.payment_taken_at, o.number_verified_at,
         o.business_created_at, o.login_link_sent_at, o.test_text_sent_at
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
    left join public.business_onboarding o on o.business_id = b.id
    left join lateral public.billing_period(b.billing_anchor, now()) bp on true
    left join lateral public.business_text_usage(b.id) tu on true
    left join lateral (
      select count(*) as sent
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= bp.period_start
         and m.sent_at < bp.period_end
    ) month_sent on true
    left join lateral (
      select count(*) as clicks
        from public.messages m
       where m.business_id = b.id
         and m.status in ('sent','clicked')
         and not m.mock
         and m.sent_at >= bp.period_start
         and m.sent_at < bp.period_end
         and m.clicked_at is not null
    ) month_click on true
    left join lateral (
      select s.review_count, s.rating, s.snapshot_date
        from public.review_snapshots s
       where s.business_id = b.id
       order by s.snapshot_date desc, s.fetched_at desc
       limit 1
    ) latest on true
   order by b.name;
$$;

revoke execute on function public.admin_list_businesses() from public, anon, authenticated;
grant execute on function public.admin_list_businesses() to service_role;
