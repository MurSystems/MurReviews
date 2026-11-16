-- ============================================================================
-- RLS tests: one business must never read or write another business's data,
-- owners must not reach service-role-only tables, tamper with the queue, or
-- update/delete opt-outs.
--
-- Run with:  supabase test db --remote --yes
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------- fixture users (the on_auth_user_created trigger makes profiles) ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test.local');

update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c1';

-- ---------- fixture tenants ----------
insert into public.businesses (id, name, place_id, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Business A', 'place-a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Business B', 'place-b', '00000000-0000-0000-0000-0000000000b1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Alice', '+61400000001'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 'Bob',   '+61400000002');

insert into public.messages (id, business_id, customer_id, kind, status, token, message_text, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'queued', 'tok-a1', 'Hi Alice', now()),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'initial', 'queued', 'tok-b1', 'Hi Bob',   now());

insert into public.opt_outs (business_id, mobile) values
  ('00000000-0000-0000-0000-0000000000b2', '+61400000009');

insert into public.gateway_credentials (business_id, provider, payload) values
  ('00000000-0000-0000-0000-0000000000a2', 'demo', '{}');

insert into public.opt_out_links (token, business_id, mobile) values
  ('opt-a1', '00000000-0000-0000-0000-0000000000a2', '+61400000001');

insert into public.replies (business_id, from_mobile, body) values
  ('00000000-0000-0000-0000-0000000000a2', '+61400000001', 'thanks');

-- ============================================================================
-- Owner A (owns business A)
-- ============================================================================
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select results_eq(
  'select count(*) from public.messages',
  array[1::bigint],
  'owner A sees only their own messages'
);
select results_eq(
  'select count(*) from public.businesses',
  array[1::bigint],
  'owner A sees only their own business'
);
select results_eq(
  'select count(*) from public.customers',
  array[1::bigint],
  'owner A sees only their own customers'
);
select results_eq(
  'select count(*) from public.replies',
  array[1::bigint],
  'owner A sees only their own replies'
);

select is_empty(
  'select * from public.messages where business_id = ''00000000-0000-0000-0000-0000000000b2''',
  'owner A cannot read business B messages'
);
select is_empty(
  'select * from public.customers where business_id = ''00000000-0000-0000-0000-0000000000b2''',
  'owner A cannot read business B customers'
);
select is_empty(
  'select * from public.gateway_credentials',
  'gateway credentials are invisible to owners'
);
select is_empty(
  'select * from public.opt_out_links',
  'opt-out link tokens are invisible to owners'
);

-- cross-tenant writes
select throws_ok(
  $$insert into public.customers (business_id, first_name, mobile)
    values ('00000000-0000-0000-0000-0000000000b2', 'Evil', '+61499999999') returning id$$,
  42501
);
select is_empty(
  $$update public.customers set first_name = 'Hacked'
    where id = '00000000-0000-0000-0000-0000000000b3' returning 1$$,
  'owner A cannot update business B customers'
);
select is_empty(
  $$delete from public.customers
    where id = '00000000-0000-0000-0000-0000000000b3' returning 1$$,
  'owner A cannot delete business B customers'
);

-- own writes
select results_eq(
  $$insert into public.customers (business_id, first_name, mobile)
    values ('00000000-0000-0000-0000-0000000000a2', 'Carol', '+61400000003') returning first_name$$,
  array['Carol'],
  'owner A can add their own customer'
);
select results_eq(
  $$insert into public.opt_outs (business_id, mobile, source)
    values ('00000000-0000-0000-0000-0000000000a2', '+61400000004', 'owner') returning mobile$$,
  array['+61400000004'],
  'owner A can manually opt out their own number'
);
select results_eq(
  'select count(*) from public.opt_outs',
  array[1::bigint],
  'owner A sees only their own opt-outs'
);
select is_empty(
  $$update public.opt_outs set source = 'admin'
    where business_id = '00000000-0000-0000-0000-0000000000a2' and mobile = '+61400000004' returning 1$$,
  'owner A cannot update opt-outs'
);
select is_empty(
  $$delete from public.opt_outs
    where business_id = '00000000-0000-0000-0000-0000000000a2' and mobile = '+61400000004' returning 1$$,
  'owner A cannot delete opt-outs'
);

-- owners cannot tamper with the send queue directly
select is_empty(
  $$update public.messages set status = 'sent'
    where id = '00000000-0000-0000-0000-0000000000a4' returning 1$$,
  'owner A cannot change message status directly'
);
select throws_ok(
  $$insert into public.messages (business_id, customer_id, kind, status, token, message_text, scheduled_at)
    values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'queued', 'tok-x', 'x', now()) returning id$$,
  42501
);

-- owners can edit only their own settings columns
select results_eq(
  $$update public.businesses set delay_minutes = 30
    where id = '00000000-0000-0000-0000-0000000000a2' returning delay_minutes$$,
  array[30],
  'owner A can update their own delay'
);
select throws_ok(
  $$update public.businesses set status = 'active'
    where id = '00000000-0000-0000-0000-0000000000a2'$$,
  42501
);

-- ============================================================================
-- Owner B (owns business B)
-- ============================================================================
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';

select results_eq(
  'select count(*) from public.messages',
  array[1::bigint],
  'owner B sees only their own messages'
);
select is_empty(
  'select * from public.customers where business_id = ''00000000-0000-0000-0000-0000000000a2''',
  'owner B cannot read business A customers'
);

-- ============================================================================
-- Admin
-- ============================================================================
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

select results_eq(
  'select count(*) from public.messages where business_id in (''00000000-0000-0000-0000-0000000000a2'', ''00000000-0000-0000-0000-0000000000b2'')',
  array[2::bigint],
  'admin sees messages from both businesses'
);

select * from finish();
