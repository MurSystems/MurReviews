-- ============================================================================
-- Admin "Send test now": one immediate, mock-flagged message for a business,
-- outside quiet hours and the delay. Normal add_customer quiet hours must
-- remain in force.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(16);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test.local');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c1';

-- Paused on purpose: a test send must still work while customer sends are off.
insert into public.businesses (id, name, place_id, status, send_mode, owner_id, delay_minutes, timezone) values
  ('00000000-0000-0000-0000-0000000000a2', 'Mur Demo', 'place-a', 'paused', 'sms_provider',
   '00000000-0000-0000-0000-0000000000a1', 60, 'Australia/Melbourne');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Azlaan', '+61411875278');

create temporary table test_msg as
select * from public.admin_create_test_message(
  '00000000-0000-0000-0000-0000000000a2', '0411 875 278', '00000000-0000-0000-0000-0000000000c1'
);

-- ---------- the test message ----------
select is((select count(*) from test_msg), 1::bigint, 'returns one message');
select is((select mobile from test_msg), '+61411875278', 'normalises the destination mobile');
select is((select business_name from test_msg), 'Mur Demo', 'returns the business name');
select is((select send_mode::text from test_msg), 'sms_provider', 'returns the send mode');
select is(
  (select status from public.messages where id = (select message_id from test_msg)),
  'sending',
  'the message is ready to send immediately'
);
select is(
  (select mock from public.messages where id = (select message_id from test_msg)),
  true,
  'the test message is marked mock so it is excluded from stats'
);
select ok(
  (select scheduled_at <= now() from public.messages where id = (select message_id from test_msg)),
  'scheduled now, ignoring quiet hours and the delay'
);
select is(
  (select attempt_count from public.messages where id = (select message_id from test_msg)),
  1,
  'counts the immediate attempt'
);
select is(
  (select first_name from public.customers where id = (select customer_id from test_msg)),
  'Azlaan',
  'reuses the existing customer without renaming them'
);
select is(
  (select count(*) from public.customers
    where business_id = '00000000-0000-0000-0000-0000000000a2' and mobile = '+61411875278'),
  1::bigint,
  'does not duplicate the customer'
);
select ok(
  exists (
    select 1 from public.audit_log
     where action = 'send_test_now'
       and details->>'message_id' = (select message_id::text from test_msg)
       and details->>'mobile' = '+61411875278'
  ),
  'writes an audit row'
);
select ok(
  (select rendered_text like '%https://m.example/r/%'
     from public.prepare_send((select message_id from test_msg), 'https://m.example')),
  'renders the review link with the business template'
);

-- The send is recorded but never counts towards the monthly allowance.
select public.mark_sent((select message_id from test_msg), 'test text', true);
select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-0000000000a2')),
  0::bigint,
  'a test send does not use the monthly allowance'
);

-- ---------- validation ----------
select throws_ok(
  $$select * from public.admin_create_test_message('00000000-0000-0000-0000-0000000000a2', '12345', '00000000-0000-0000-0000-0000000000c1')$$,
  22023
);
select throws_ok(
  $$select * from public.admin_create_test_message('00000000-0000-0000-0000-0000000000ff', '+61411875278', '00000000-0000-0000-0000-0000000000c1')$$,
  22023
);

-- ---------- normal customer sends keep quiet hours ----------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select * from public.add_customer(
  '00000000-0000-0000-0000-0000000000a2', 'Quiet', '0491 570 006'
);
reset role;

select is(
  (select extract(hour from (m.scheduled_at at time zone 'Australia/Melbourne'))::int between 9 and 19
     from public.messages m
     join public.customers c on c.id = m.customer_id
    where c.business_id = '00000000-0000-0000-0000-0000000000a2'
      and c.mobile = '+61491570006'),
  true,
  'normal add_customer still schedules inside quiet hours'
);

select * from finish();
