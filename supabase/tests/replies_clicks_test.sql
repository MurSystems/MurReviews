-- ============================================================================
-- Inbound replies (Mobile Message), click -> status, and cancelled vs failed.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'replies@test.local');

insert into public.businesses (id, name, place_id, status, owner_id, sender_number, send_mode) values
  ('00000000-0000-0000-0000-0000000000f2', 'Reply Cafe', 'place-f', 'active',
   '00000000-0000-0000-0000-0000000000f1', '61485900133', 'sms_provider'),
  ('00000000-0000-0000-0000-0000000000f4', 'Other Cafe', 'place-g', 'active',
   '00000000-0000-0000-0000-0000000000f1', '61485900134', 'sms_provider');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f2', 'Mia', '+61412000001'),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f4', 'Bo', '+61412000002'),
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000f4', 'Cy', '+61412000003');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f2',
   '00000000-0000-0000-0000-0000000000f3', 'sent', 'replytok1', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f4',
   '00000000-0000-0000-0000-0000000000f5', 'sent', 'replytok2', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f2',
   '00000000-0000-0000-0000-0000000000f3', 'queued', 'replytok3', now() + interval '1 hour', null),
  ('00000000-0000-0000-0000-0000000000fc', '00000000-0000-0000-0000-0000000000f4',
   '00000000-0000-0000-0000-0000000000f5', 'queued', 'replytok4', now() + interval '1 hour', null);

-- ---------- click moves the message to 'clicked' ----------

select is(
  (select first_click from public.handle_review('replytok1', true)),
  true,
  'the first real click is recorded'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000f6'),
  'clicked',
  'a click moves the message from sent to clicked'
);
select is(
  (select first_click from public.handle_review('replytok1', true)),
  false,
  'a second click is not the first click'
);

-- ---------- replies match by custom_ref ----------

select is(
  (select matched from public.handle_sms_reply(
     '61485900133', '+61412000001', 'Sounds good', false,
     '00000000-0000-0000-0000-0000000000f6', now() - interval '5 minutes')),
  true,
  'original_custom_ref matches the reply to its message'
);
select is(
  (select customer_id from public.replies
    where message_id = '00000000-0000-0000-0000-0000000000f6'),
  '00000000-0000-0000-0000-0000000000f3'::uuid,
  'the reply stores its customer'
);
select is(
  (select message_id from public.replies where body = 'Sounds good'),
  '00000000-0000-0000-0000-0000000000f6'::uuid,
  'the reply stores its message'
);
select is(
  (select count(*) from public.replies
    where business_id = '00000000-0000-0000-0000-0000000000f2'
      and from_mobile = '+61412000001'),
  1::bigint,
  'the reply is stored once'
);

-- A provider retry replays the same received_at.
select public.handle_sms_reply(
  '61485900133', '+61412000001', 'Sounds good', false,
  '00000000-0000-0000-0000-0000000000f6', now() - interval '5 minutes');
select is(
  (select count(*) from public.replies
    where business_id = '00000000-0000-0000-0000-0000000000f2'
      and from_mobile = '+61412000001'),
  1::bigint,
  'a webhook retry does not duplicate the reply'
);

-- ---------- fallback: no custom_ref, newest text to the number wins ----------

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000f2',
   '00000000-0000-0000-0000-0000000000f3', 'sent', 'replytok5', now(), now());

select is(
  (select matched from public.handle_sms_reply(
     '61485900133', '+61412000001', 'Great', false, null, now() - interval '1 minute')),
  true,
  'a reply without a custom_ref still finds its business'
);
select is(
  (select message_id from public.replies
    where business_id = '00000000-0000-0000-0000-0000000000f2'
      and body = 'Great'),
  '00000000-0000-0000-0000-0000000000f9'::uuid,
  'the reply is linked to the most recent text to that number'
);

-- ---------- STOP and unsubscribe ----------

select is(
  (select is_stop from public.handle_sms_reply(
     '61485900133', '+61412000001', 'STOP', false, null, now())),
  true,
  'STOP is an opt-out'
);
select ok(
  exists (select 1 from public.opt_outs
           where business_id = '00000000-0000-0000-0000-0000000000f2'
             and mobile = '+61412000001'
             and source = 'reply'),
  'STOP records an opt-out for the number'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000f8'),
  'opted_out',
  'STOP cancels the queued text'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000fc'),
  'queued',
  'STOP only affects the business that was texted'
);
select is(
  (select kind from public.replies
    where business_id = '00000000-0000-0000-0000-0000000000f2'
      and body = 'STOP'),
  'stop',
  'the STOP reply is stored and marked as an opt-out'
);

select is(
  (select is_stop from public.handle_sms_reply(
     '61485900134', '+61412000002', 'Thanks', true, null, now())),
  true,
  'type=unsubscribe opts out without a STOP keyword'
);
select ok(
  exists (select 1 from public.opt_outs
           where business_id = '00000000-0000-0000-0000-0000000000f4'
             and mobile = '+61412000002'),
  'an unsubscribe records an opt-out'
);

-- ---------- a dedicated number identifies the business on its own ----------

select is(
  (select matched from public.handle_sms_reply(
     '61485900134', '+61412000003', 'Hello', false, null, now())),
  true,
  'a reply to a dedicated number finds the business'
);
select is(
  (select customer_id from public.replies
    where business_id = '00000000-0000-0000-0000-0000000000f4'
      and from_mobile = '+61412000003'),
  '00000000-0000-0000-0000-0000000000fa'::uuid,
  'the customer is matched by their mobile'
);

select is(
  (select matched from public.handle_sms_reply(
     '61499999999', '+61412000009', 'Who is this?', false, null, now())),
  false,
  'an unknown number is not matched'
);

-- ---------- expired texts are cancelled, not failed ----------

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000fb', '00000000-0000-0000-0000-0000000000f2',
   '00000000-0000-0000-0000-0000000000f3', 'queued', 'replytok6', now() - interval '8 days');

select public.expire_stale_queued_messages();

select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000fb'),
  'cancelled',
  'an expired text is cancelled, not failed'
);
select is(
  (select last_error from public.messages where id = '00000000-0000-0000-0000-0000000000fb'),
  'Cancelled after waiting more than 7 days to send.',
  'the cancellation has a plain reason'
);

select * from finish();
