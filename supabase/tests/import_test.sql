-- ============================================================================
-- CSV import: skip rules and drip rate.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(3);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1');

-- a recent customer (asked within 90 days) and an opted-out number
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Recent', '+61491570156');
insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent', 'tok-recent', now() - interval '1 day');
insert into public.opt_outs (business_id, mobile) values
  ('00000000-0000-0000-0000-0000000000a2', '+61491570157');

-- set up the drip cap as postgres (owners can't change daily_send_cap)
update public.businesses set daily_send_cap = 2 where id = '00000000-0000-0000-0000-0000000000a2';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

-- skip rules: valid, opted-out, recent, invalid, duplicate (valid's mobile again)
select is(
  (select will_send from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Opt","mobile":"0491 570 157"},{"name":"Recent","mobile":"0491 570 156"},{"name":"Bad","mobile":"not-a-number"},{"name":"Dup","mobile":"0491 570 006"}]',
    false
  )),
  1::bigint,
  'only one row will be sent'
);
select is(
  (select skipped_opted_out from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Opt","mobile":"0491 570 157"},{"name":"Recent","mobile":"0491 570 156"},{"name":"Bad","mobile":"not-a-number"},{"name":"Dup","mobile":"0491 570 006"}]',
    false
  )),
  1::bigint,
  'opted-out number is skipped'
);

-- drip: daily_send_cap=2, import 5 valid rows -> at most 2 due per day
select * from public.import_customers(
  '00000000-0000-0000-0000-0000000000a2',
  '[{"name":"A","mobile":"0491 570 006"},{"name":"B","mobile":"0491 570 110"},{"name":"C","mobile":"0491 570 158"},{"name":"D","mobile":"0491 570 159"},{"name":"E","mobile":"0491 570 313"}]',
  true
);
select ok(
  (select max(c) <= 2 from (
    select count(*) c from public.messages
    where business_id = '00000000-0000-0000-0000-0000000000a2'
      and customer_id <> '00000000-0000-0000-0000-0000000000a3'
    group by (scheduled_at at time zone 'Australia/Melbourne')::date
  ) x),
  'drip: at most daily_send_cap messages are due per day'
);

select * from finish();
