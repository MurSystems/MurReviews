-- ============================================================================
-- Android gateway (SMSGate) is the default send mode.
--
-- * New businesses default to android_gateway.
-- * Owners connect their own phone from Settings: the cloud username/password
--   (and optional device id) are written to gateway_credentials, which stays
--   service-role only. Nothing secret is ever returned to the browser.
-- * android_gateway texts carry the stable /o/{token} opt-out link when the
--   customer has one, so opt-out can be tapped as well as replied STOP.
-- ============================================================================

alter table public.businesses
  alter column send_mode set default 'android_gateway';

-- ---------- owner: save the phone connection ----------

create or replace function public.save_gateway_credentials(
  p_business_id uuid,
  p_username text,
  p_password text,
  p_device_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.businesses b
     where b.id = p_business_id and b.owner_id = auth.uid()
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_username is null or btrim(p_username) = ''
     or p_password is null or btrim(p_password) = '' then
    raise exception 'username and password are required' using errcode = '22023';
  end if;

  insert into public.gateway_credentials (business_id, provider, payload)
  values (
    p_business_id,
    'smsgate',
    jsonb_build_object(
      'baseUrl', 'https://api.sms-gate.app',
      'username', btrim(p_username),
      'password', p_password,
      'deviceId', nullif(btrim(p_device_id), '')
    )
  )
  on conflict (business_id, provider) do update
    set payload = excluded.payload,
        updated_at = now();
end;
$$;

revoke execute on function public.save_gateway_credentials(uuid, text, text, text) from public;
revoke execute on function public.save_gateway_credentials(uuid, text, text, text) from anon;
grant execute on function public.save_gateway_credentials(uuid, text, text, text) to authenticated;

-- ---------- owner: connected/offline status (no secrets) ----------

create or replace function public.get_gateway_status(p_business_id uuid)
returns table (configured boolean, connected boolean, last_seen_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_seen timestamptz;
  v_configured boolean := false;
begin
  if not public.can_access_business(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select (g.payload->>'username') is not null
           and (g.payload->>'password') is not null,
         g.last_seen_at
    into v_configured, v_seen
    from public.gateway_credentials g
   where g.business_id = p_business_id and g.provider = 'smsgate'
   limit 1;

  return query select
    coalesce(v_configured, false),
    coalesce(v_seen > now() - interval '10 minutes', false),
    v_seen;
end;
$$;

revoke execute on function public.get_gateway_status(uuid) from public;
revoke execute on function public.get_gateway_status(uuid) from anon;
grant execute on function public.get_gateway_status(uuid) to authenticated;

-- ---------- service role: config for the cron sender ----------

create or replace function public.gateway_send_config(p_business_id uuid)
returns table (base_url text, username text, password text, device_id text, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(g.payload->>'baseUrl', 'https://api.sms-gate.app'),
         g.payload->>'username',
         g.payload->>'password',
         g.payload->>'deviceId',
         g.last_seen_at
    from public.gateway_credentials g
   where g.business_id = p_business_id and g.provider = 'smsgate'
   limit 1
$$;

revoke execute on function public.gateway_send_config(uuid) from public;
revoke execute on function public.gateway_send_config(uuid) from anon, authenticated;
grant execute on function public.gateway_send_config(uuid) to service_role;

-- ---------- service role: owner-checked config for the test-send route ----------

create or replace function public.owner_gateway_config(p_business_id uuid, p_user_id uuid)
returns table (base_url text, username text, password text, device_id text, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(g.payload->>'baseUrl', 'https://api.sms-gate.app'),
         g.payload->>'username',
         g.payload->>'password',
         g.payload->>'deviceId',
         g.last_seen_at
    from public.gateway_credentials g
    join public.businesses b on b.id = g.business_id
   where g.business_id = p_business_id
     and g.provider = 'smsgate'
     and b.owner_id = p_user_id
   limit 1
$$;

revoke execute on function public.owner_gateway_config(uuid, uuid) from public;
revoke execute on function public.owner_gateway_config(uuid, uuid) from anon, authenticated;
grant execute on function public.owner_gateway_config(uuid, uuid) to service_role;

-- ---------- opt-out link for android_gateway as well ----------

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
         public.render_send_message(v_template, v_customer.first_name, v_business.name, v_review_link, v_opt_out),
         v_business.send_mode,
         v_business.id,
         v_business.sender_number;
end;
$$;

revoke execute on function public.prepare_send(uuid, text) from public;
grant execute on function public.prepare_send(uuid, text) to service_role;
