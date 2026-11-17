-- ============================================================================
-- Results tracking: this-month/all-time texts, clicks and click rate; Google
-- review count and rating; reviews gained; manual counts and the starting
-- point recorded when a business is created. Mock sends never count.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@test.local');

insert into public.businesses
  (id, name, place_id, status, owner_id, starting_review_count, starting_review_recorded_at)
values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active',
   '00000000-0000-0000-0000-0000000000a1', 10, now());

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2',
   'Mia', '+61491570006');

insert into public.messages
  (id, business_id, customer_id, status, mock, token, scheduled_at, sent_at, clicked_at)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000a3', 'clicked', true, 'dm1', now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000a3', 'sent', false, 'dm2', now(), now(), null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000a3', 'clicked', false, 'dm3', now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000a3', 'clicked', false, 'dm4',
   now() - interval '40 days', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000a3', 'sent', false, 'dm5',
   now() - interval '40 days', now() - interval '40 days', null);

insert into public.review_snapshots (business_id, snapshot_date, rating, review_count, source) values
  ('00000000-0000-0000-0000-0000000000a2', current_date - 1, 4.5, 12, 'manual');

-- Biz B has no explicit starting count: the earliest snapshot is the baseline.
insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000b2', 'Biz B', 'place-b', 'active',
   '00000000-0000-0000-0000-0000000000a1');

insert into public.review_snapshots (business_id, snapshot_date, rating, review_count, source) values
  ('00000000-0000-0000-0000-0000000000b2', current_date - 2, 4.0, 7, 'manual'),
  ('00000000-0000-0000-0000-0000000000b2', current_date, 4.2, 9, 'manual');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select texts_sent from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  4::bigint,
  'all-time texts exclude mock sends'
);
select is(
  (select clicks from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  2::bigint,
  'all-time clicks exclude mock sends'
);
select is(
  (select texts_sent_this_month from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  2::bigint,
  'this month counts only texts sent since the Melbourne month start'
);
select is(
  (select clicks_this_month from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  1::bigint,
  'this month counts only clicks on this month’s texts'
);
select is(
  (select click_rate_this_month from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  0.5::numeric,
  'this month click rate = clicks / texts sent'
);
select is(
  (select review_count from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  12,
  'latest review count'
);
select is(
  (select rating from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  4.5::numeric,
  'latest rating'
);
select is(
  (select reviews_gained from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  2,
  'reviews gained = latest count - starting count (12 - 10)'
);
select is(
  (select starting_review_count from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  10,
  'the explicit starting count is returned'
);
select is(
  (select reviews_gained from public.owner_dashboard('00000000-0000-0000-0000-0000000000b2')),
  2,
  'without an explicit start, the earliest snapshot is the baseline (9 - 7)'
);

reset role;

-- ---------- admin records a count by hand ----------

select public.admin_record_review_snapshot(
  '00000000-0000-0000-0000-0000000000a2', 16, current_date, 4.7,
  '00000000-0000-0000-0000-0000000000ad'
);

select is(
  (select review_count from public.review_snapshots
    where business_id = '00000000-0000-0000-0000-0000000000a2'
      and snapshot_date = current_date),
  16,
  'admin manual count is stored against its date'
);
select ok(
  (select source = 'manual' from public.review_snapshots
    where business_id = '00000000-0000-0000-0000-0000000000a2'
      and snapshot_date = current_date),
  'manual entries are marked as manual'
);
select is(
  (select count(*) from public.audit_log
    where action = 'record_review_count'
      and details->>'business_id' = '00000000-0000-0000-0000-0000000000a2'),
  1::bigint,
  'recording a count is audited'
);

-- ---------- creating a business records its starting point ----------

-- The business created by this call is not visible to another part of the same
-- statement (one snapshot per statement), so create it first and assert after.
select public.admin_create_business(
  'Biz C', 'place-c', 'Australia/Melbourne', 'log_only', 60,
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000ad', 20
);
select is(
  (select starting_review_count from public.businesses where place_id = 'place-c'),
  20,
  'the count entered at creation is the starting count'
);
select is(
  (select review_count from public.review_snapshots
    where business_id = (select id from public.businesses where place_id = 'place-c')
      and snapshot_date = current_date),
  20,
  'the count entered at creation is also the first snapshot'
);
select ok(
  (select starting_review_recorded_at is not null from public.businesses where place_id = 'place-c'),
  'recording the starting count is remembered (so 0 is a valid baseline)'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select reviews_gained from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  6,
  'a manual count updates reviews gained (16 - 10)'
);
select is(
  (select rating from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  4.7::numeric,
  'a manual rating updates the dashboard'
);

select * from finish();
