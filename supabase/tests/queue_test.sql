-- ============================================================================
-- Queue tests: claim_due_messages (atomic claim, future + paused skipped) and
-- fail_stale_sends (stale "sending" -> failed, never auto-resent). Both are
-- service-role functions, so these run as the migration/test superuser.
--
-- Run with:  supabase test db --remote --yes
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Active Biz', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Paused Biz', 'place-b', 'paused', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Due',    '+61400000001'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', 'Future', '+61400000002'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 'Paused', '+61400000003'),
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a2', 'Stale',  '+61400000004'),
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-0000000000a2', 'Fresh',  '+61400000005');

-- due now (active), future (active), due but paused, stale "sending", fresh "sending"
insert into public.messages (id, business_id, customer_id, kind, status, token, scheduled_at, updated_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'queued',  'tok-due',    now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', 'initial', 'queued',  'tok-future', now() + interval '1 hour',  now()),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'initial', 'queued',  'tok-paused', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'initial', 'sending', 'tok-stale',  now() - interval '1 minute', now() - interval '20 minutes'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a6', 'initial', 'sending', 'tok-fresh',  now() - interval '1 minute', now());

-- claim the due message
select results_eq(
  'select count(*) from public.claim_due_messages()',
  array[1::bigint],
  'claim returns exactly the one due message'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d1'),
  'sending',
  'due message is claimed (queued -> sending)'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d2'),
  'queued',
  'future message is not claimed'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d3'),
  'queued',
  'paused business message is not claimed'
);

-- sweep stale sends
select results_eq(
  'select count(*) from public.fail_stale_sends()',
  array[1::bigint],
  'stale sweep marks exactly one sending message failed'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d4'),
  'failed',
  'stale sending message is marked failed'
);
select is(
  (select retryable from public.messages where id = '00000000-0000-0000-0000-0000000000d4'),
  false,
  'stale sending message is never auto-resent'
);

select * from finish();
