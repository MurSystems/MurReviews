-- ============================================================================
-- Owner dashboard: mock exclusion, reviews gained.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id, starting_review_count) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1', 10);

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, mock, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',    true,  'dm1', now(), now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',    false, 'dm2', now(), now()),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'clicked', false, 'dm3', now(), now());

insert into public.review_snapshots (business_id, snapshot_date, rating, review_count) values
  ('00000000-0000-0000-0000-0000000000a2', current_date - 1, 4.5, 12);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select texts_sent from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  2::bigint,
  'mock sends are excluded from texts sent'
);
select is(
  (select clicks from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  1::bigint,
  'clicks count only real clicks'
);
select is(
  (select reviews_gained from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  2::int,
  'reviews gained = current - starting (12 - 10)'
);
select ok(
  (select rating = 4.5 and review_count = 12 from public.owner_dashboard('00000000-0000-0000-0000-0000000000a2')),
  'latest rating and review count'
);

select * from finish();
