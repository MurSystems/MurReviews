-- ============================================================================
-- Stage 5: sender safety — daily send cap.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(2);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Capped Biz', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Open Biz',   'place-b', 'active', '00000000-0000-0000-0000-0000000000a1');

update public.businesses set daily_text_cap = 1 where id = '00000000-0000-0000-0000-0000000000a2';

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 'Noah', '+61491570156');

-- capped biz already sent its one text today, and has one queued due now;
-- open biz has one queued due now.
insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',   'tok-sent',   now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'queued', 'tok-capped', now() - interval '1 minute', null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'queued', 'tok-open',   now() - interval '1 minute', null);

-- Run the claim once.
select * from public.claim_due_messages();

select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d2'),
  'queued',
  'a business at its daily cap is not claimed'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000d3'),
  'sending',
  'an open business under its daily cap is claimed'
);

select * from finish();
