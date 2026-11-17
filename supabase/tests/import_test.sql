-- ============================================================================
-- CSV import: preview counters, mock queuing, and drip rate.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active', 'log_only', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Biz Drip', 'place-b', 'active', 'log_only', '00000000-0000-0000-0000-0000000000a1');

-- Biz Drip has a recent customer (asked within 90 days) that must be skipped.
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b2', 'Recent', '+61491570156');
insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a3', 'sent', 'tok-recent', now() - interval '1 day');

-- Biz Drip can only fit two texts per day.
update public.businesses set daily_send_cap = 2 where id = '00000000-0000-0000-0000-0000000000b2';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

-- The task CSV: 3 sendable, 2 bad numbers, 1 missing name, 1 duplicate.
select is(
  (select will_send from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Jack","mobile":"0491 570 110"},{"name":"Sam","mobile":"0491 570 313"},{"name":"Sam again","mobile":"0491 570 313"},{"name":"Office","mobile":"03 9123 4567"},{"name":"Bob","mobile":"12345"},{"name":"","mobile":"0491 570 737"}]',
    false
  )),
  3::bigint,
  'preview: three rows will send'
);
select is(
  (select skipped_invalid from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Jack","mobile":"0491 570 110"},{"name":"Sam","mobile":"0491 570 313"},{"name":"Sam again","mobile":"0491 570 313"},{"name":"Office","mobile":"03 9123 4567"},{"name":"Bob","mobile":"12345"},{"name":"","mobile":"0491 570 737"}]',
    false
  )),
  2::bigint,
  'preview: two invalid numbers (landline + too short)'
);
select is(
  (select skipped_missing_name from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Jack","mobile":"0491 570 110"},{"name":"Sam","mobile":"0491 570 313"},{"name":"Sam again","mobile":"0491 570 313"},{"name":"Office","mobile":"03 9123 4567"},{"name":"Bob","mobile":"12345"},{"name":"","mobile":"0491 570 737"}]',
    false
  )),
  1::bigint,
  'preview: one missing name is reported separately'
);
select is(
  (select skipped_duplicate from public.import_customers(
    '00000000-0000-0000-0000-0000000000a2',
    '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Jack","mobile":"0491 570 110"},{"name":"Sam","mobile":"0491 570 313"},{"name":"Sam again","mobile":"0491 570 313"},{"name":"Office","mobile":"03 9123 4567"},{"name":"Bob","mobile":"12345"},{"name":"","mobile":"0491 570 737"}]',
    false
  )),
  1::bigint,
  'preview: one duplicate is skipped'
);

-- Commit the same CSV, then check the queued rows.
select * from public.import_customers(
  '00000000-0000-0000-0000-0000000000a2',
  '[{"name":"Mia","mobile":"0491 570 006"},{"name":"Jack","mobile":"0491 570 110"},{"name":"Sam","mobile":"0491 570 313"},{"name":"Sam again","mobile":"0491 570 313"},{"name":"Office","mobile":"03 9123 4567"},{"name":"Bob","mobile":"12345"},{"name":"","mobile":"0491 570 737"}]',
  true
);
select is(
  (select count(*) from public.messages where business_id = '00000000-0000-0000-0000-0000000000a2'),
  3::bigint,
  'commit: exactly three messages queued'
);
select ok(
  (select bool_and(mock) from public.messages where business_id = '00000000-0000-0000-0000-0000000000a2'),
  'commit: log_only queued messages are marked mock'
);

-- Drip: Biz Drip caps at two per day; five valid rows spread over three days.
select * from public.import_customers(
  '00000000-0000-0000-0000-0000000000b2',
  '[{"name":"A","mobile":"0491 570 006"},{"name":"B","mobile":"0491 570 110"},{"name":"C","mobile":"0491 570 158"},{"name":"D","mobile":"0491 570 159"},{"name":"E","mobile":"0491 570 313"}]',
  true
);
select ok(
  (select max(c) <= 2 from (
    select count(*) c from public.messages
    where business_id = '00000000-0000-0000-0000-0000000000b2'
      and customer_id <> '00000000-0000-0000-0000-0000000000a3'
    group by (scheduled_at at time zone 'Australia/Melbourne')::date
  ) x),
  'drip: at most daily_send_cap messages are due per day'
);
select is(
  (select count(distinct (scheduled_at at time zone 'Australia/Melbourne')::date)
     from public.messages
    where business_id = '00000000-0000-0000-0000-0000000000b2'
      and customer_id <> '00000000-0000-0000-0000-0000000000a3'),
  3::bigint,
  'drip: five rows spread across three days (2 + 2 + 1)'
);

select * from finish();
