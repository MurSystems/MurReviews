-- ============================================================================
-- Stage 6: admin panel backend — mock flag, demo-send limits, audit, authz.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test.local');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c1';

insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Demo Cafe', 'place-a', 'active', 'log_only', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sending', 'tok1', now(), null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sending', 'tok2', now(), null);

-- 1. mock flag is recorded and excluded from usage.
select public.mark_sent('00000000-0000-0000-0000-0000000000d1', 'Hi Mia (test)', true);
select public.mark_sent('00000000-0000-0000-0000-0000000000d2', 'Hi Mia (real)', false);
select is(
  (select mock from public.messages where id = '00000000-0000-0000-0000-0000000000d1'),
  true,
  'a mock send is flagged as mock'
);
select is(
  (select texts_sent from public.admin_list_businesses() where id = '00000000-0000-0000-0000-0000000000a2'),
  1::bigint,
  'mock sends are excluded from the sent count'
);

-- 2. demo send works and starts with "Demo:".
select ok(
  (select outcome = 'sent' and demo_text like 'Demo:%' from public.admin_demo_send('place-a', '0491 570 006', '00000000-0000-0000-0000-0000000000c1')),
  'demo send succeeds and starts with Demo:'
);

-- 3. demo send is limited to 1 per number per 30 days.
select is(
  (select outcome from public.admin_demo_send('place-b', '0491 570 006', '00000000-0000-0000-0000-0000000000c1')),
  'rate_limited_number',
  'same number cannot get a second demo send within 30 days'
);

-- 4. demo send is limited to 20 per day overall.
insert into public.demo_sends (admin_id, prospect_place_id, to_mobile, sent_at)
select '00000000-0000-0000-0000-0000000000c1', 'place-x', 'placeholder-' || i, now()
from generate_series(1, 20) as i;
select is(
  (select outcome from public.admin_demo_send('place-y', '0491 570 110', '00000000-0000-0000-0000-0000000000c1')),
  'rate_limited_daily',
  '20 demo sends per day overall is enforced'
);

-- 5. create business writes an audit row.
select is(
  (select count(*) from public.admin_create_business('New Biz', 'place-new', 'Australia/Melbourne', 'log_only', 60, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1')),
  1::bigint,
  'admin_create_business creates a business'
);
select is(
  (select count(*) from public.audit_log where action = 'create_business'),
  1::bigint,
  'admin_create_business writes an audit row'
);

-- 6. set status writes an audit row and applies.
select public.admin_set_business_status('00000000-0000-0000-0000-0000000000a2', 'paused', 50, '00000000-0000-0000-0000-0000000000c1');
select is(
  (select status from public.businesses where id = '00000000-0000-0000-0000-0000000000a2'),
  'paused',
  'admin_set_business_status applies the status'
);

-- 7. an owner account is rejected (admin functions are service-role only).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$select * from public.admin_create_business('X', 'p', 'Australia/Melbourne', 'log_only', 60, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1')$$,
  42501
);

select * from finish();
