-- ============================================================================
-- Safeguards: send allowlist, dev-message cancellation, admin reset_number.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(15);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test.local');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c1';

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Alice', '+61491570006'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', 'Bob',   '+61491570156');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'queued',  'tok-q1', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',    'tok-s1', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', 'queued',  'tok-q2', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', 'sending', 'tok-s2', now()),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', 'clicked', 'tok-c1', now() - interval '1 day');

insert into public.opt_outs (business_id, mobile) values
  ('00000000-0000-0000-0000-0000000000a2', '+61491570110');

-- ---------- 1. send allowlist ----------
select ok(public.send_allowed('log_only', '+61499999999', null, array[]::text[]), 'log_only is always allowed');
select ok(public.send_allowed('demo', '+61499999999', 'true', array[]::text[]), 'production (exact "true") allows any number');
select ok(public.send_allowed('demo', '+61491570006', 'false', array['+61491570006']), 'allowlisted number is allowed');
select ok(not public.send_allowed('demo', '+61499999999', 'false', array[]::text[]), 'non-production sender rejects an unlisted number');
select ok(not public.send_allowed('demo', '+61499999999', null, array[]::text[]), 'missing PRODUCTION env var is treated as non-production');
select ok(not public.send_allowed('demo', '+61499999999', '', array[]::text[]), 'empty PRODUCTION env var is treated as non-production');
select ok(not public.send_allowed('demo', '+61499999999', 'TRUE', array[]::text[]), 'wrong-case PRODUCTION env var is treated as non-production');

-- ---------- 2. cancel dev messages ----------
select ok((select cancelled from public.cancel_dev_messages()) >= 3, 'cancel returns the count of cancelled queued/sending');
select is(
  (select count(*) from public.messages
    where id in ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000d4')
      and status = 'failed' and retryable = false),
  3::bigint,
  'queued and sending messages are cancelled and never auto-resent'
);
select is((select status from public.messages where token = 'tok-s1'), 'sent', 'sent message is left alone');
select is((select status from public.messages where token = 'tok-c1'), 'clicked', 'clicked message is left alone');

-- ---------- 3. reset_number (admin only) ----------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

select results_eq(
  $$select deleted from public.reset_number('00000000-0000-0000-0000-0000000000a2', '0491 570 006')$$,
  array[2::bigint],
  'admin reset clears the number''s request history'
);
select is(
  (select count(*) from public.messages where customer_id = '00000000-0000-0000-0000-0000000000a3'),
  0::bigint,
  'the number has no messages left'
);
select ok(
  exists (select 1 from public.opt_outs where business_id = '00000000-0000-0000-0000-0000000000a2' and mobile = '+61491570110'),
  'opt-outs are not removed by reset'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$select * from public.reset_number('00000000-0000-0000-0000-0000000000a2', '+61491570156')$$,
  42501
);

select * from finish();
