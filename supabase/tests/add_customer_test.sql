-- ============================================================================
-- add_customer RPC tests: normalisation (landline rejection), opt-out skip,
-- 90-day skip, trial cap, upsert+queue, and cross-business authorisation.
--
-- Run with:  supabase test db --remote --yes
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(9);

-- ---------- fixture users ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@test.local');

-- ---------- fixture businesses ----------
insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Business A', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Business B', 'place-b', 'active', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c2', 'Cap Biz',    'place-c', 'trial',  '00000000-0000-0000-0000-0000000000a1');

update public.businesses set trial_text_cap = 1 where id = '00000000-0000-0000-0000-0000000000c2';

-- opted-out number for business A
insert into public.opt_outs (business_id, mobile) values
  ('00000000-0000-0000-0000-0000000000a2', '+61400000007');

-- a business-A customer already asked in the last 90 days
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Alice', '+61400000001');

insert into public.messages (id, business_id, customer_id, kind, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'sent', 'tok-a1', now());

-- the cap business has already sent its one allowed text
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c2', 'CapCust', '+61400000010');

insert into public.messages (id, business_id, customer_id, kind, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3', 'initial', 'sent', 'tok-c1', now());

-- ============================================================================
-- Owner A
-- ============================================================================
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'Carol', '0412 345 678')),
  'queued',
  'valid mobile queues a message'
);
select is(
  (select mobile from public.customers
    where business_id = '00000000-0000-0000-0000-0000000000a2' and first_name = 'Carol'),
  '+61412345678',
  'mobile is normalised to Australian E.164'
);
select is(
  (select count(*) from public.messages m
     join public.customers c on c.id = m.customer_id
    where c.business_id = '00000000-0000-0000-0000-0000000000a2'
      and c.first_name = 'Carol' and m.status = 'queued'),
  1::bigint,
  'one queued message is created for the new customer'
);

select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'Land', '03 9000 0000')),
  'invalid_mobile',
  'landline is rejected'
);
select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'Junk', 'not a number')),
  'invalid_mobile',
  'garbage number is rejected'
);
select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'Opt', '+61400000007')),
  'opted_out',
  'opted-out number is skipped'
);
select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'Again', '+61400000001')),
  'recent',
  'number asked within 90 days is skipped'
);
select is(
  (select outcome from public.add_customer('00000000-0000-0000-0000-0000000000c2', 'Zed', '+61400000008')),
  'capped',
  'trial business at its cap queues nothing'
);

-- ============================================================================
-- Owner B cannot add a customer to business A
-- ============================================================================
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';

select throws_ok(
  $$select * from public.add_customer('00000000-0000-0000-0000-0000000000a2', 'X', '0412345678')$$,
  42501
);

select * from finish();
