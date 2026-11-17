-- ============================================================================
-- Stage 5: sender DB logic (render, mark sent/failed, inbound SMS, heartbeat).
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Demo Cafe', 'place-a', 'active', 'demo', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sending', 'tok12345', now(), null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sending', 'tok54321', now(), null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'queued',  'tokqueued', now() + interval '1 hour', null);

insert into public.opt_out_links (token, business_id, mobile) values
  ('optok1', '00000000-0000-0000-0000-0000000000a2', '+61491570006');

insert into public.gateway_credentials (business_id, provider, payload) values
  ('00000000-0000-0000-0000-0000000000a2', 'demo', '{"deviceId": "test-device-1"}');

-- 1. prepare_send renders the review link + STOP opt-out for demo mode.
select ok(
  (select rendered_text like '%https://m.example/r/tok12345%' and rendered_text like '%Opt out: Reply STOP%'
     from public.prepare_send('00000000-0000-0000-0000-0000000000d1', 'https://m.example')),
  'prepare_send renders the review link and labelled STOP opt-out'
);

-- 2. mark_sent stores the exact text and marks sent.
select public.mark_sent('00000000-0000-0000-0000-0000000000d1', 'Hi Mia, exact text here');
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d1'),
  'sent',
  'mark_sent sets status to sent'
);
select is(
  (select message_text from public.messages where id = '00000000-0000-0000-0000-0000000000d1'),
  'Hi Mia, exact text here',
  'mark_sent stores the exact text sent'
);

-- 3. mark_failed records the error and retryable flag.
select public.mark_failed('00000000-0000-0000-0000-0000000000d2', 'gateway down', false);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d2'),
  'failed',
  'mark_failed sets status to failed'
);
select is(
  (select last_error from public.messages where id = '00000000-0000-0000-0000-0000000000d2'),
  'gateway down',
  'mark_failed stores the error'
);

-- 4. inbound STOP opts the number out and cancels queued messages.
select is(
  (select is_stop from public.handle_inbound_sms('test-device-1', '0491 570 006', 'STOP')),
  true,
  'STOP reply is recognised'
);
select ok(
  exists (select 1 from public.opt_outs where business_id = '00000000-0000-0000-0000-0000000000a2' and mobile = '+61491570006'),
  'STOP reply opts the number out'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d3'),
  'opted_out',
  'queued messages are cancelled on STOP'
);

-- 5. inbound non-STOP stores a reply.
select is(
  (select is_stop from public.handle_inbound_sms('test-device-1', '0491 570 006', 'thanks!')),
  false,
  'a normal reply is not treated as STOP'
);
select is(
  (select count(*) from public.replies where business_id = '00000000-0000-0000-0000-0000000000a2' and body = 'thanks!'),
  1::bigint,
  'a normal reply is stored'
);

-- 6. heartbeat.
select public.touch_gateway('test-device-1');
select ok(
  (select last_seen_at is not null from public.gateway_credentials where payload->>'deviceId' = 'test-device-1'),
  'heartbeat updates last_seen_at'
);

-- 7. unknown device is not handled.
select is(
  (select handled from public.handle_inbound_sms('unknown-device', '0491 570 006', 'STOP')),
  false,
  'an unknown device id is not handled'
);

-- 8. sms_provider mode: the linked opt-out column lookup must not be
--    ambiguous with the OUT parameters (regression: SQLSTATE 42702).
insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000b2', 'SMS Biz', 'place-b', 'active', 'sms_provider', '00000000-0000-0000-0000-0000000000a1');
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 'Mia', '+61491570110');
insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'sending', 'toksms1', now());
insert into public.opt_out_links (token, business_id, mobile) values
  ('optok2', '00000000-0000-0000-0000-0000000000b2', '+61491570110');
select ok(
  (select rendered_text like '%https://m.example/o/optok2%'
     from public.prepare_send('00000000-0000-0000-0000-0000000000b4', 'https://m.example')),
  'prepare_send renders a linked opt-out for sms_provider'
);

-- 9. mark_sent records mock sends so they never count as real.
select public.mark_sent('00000000-0000-0000-0000-0000000000b4', 'Hi Mia, mock text', true);
select ok(
  (select mock from public.messages where id = '00000000-0000-0000-0000-0000000000b4'),
  'mark_sent records the mock flag'
);

select * from finish();
