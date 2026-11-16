-- ============================================================================
-- Stage 4: review-link click recording and opt-out-by-token.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Demo Cafe', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',   'revtok1', now() - interval '1 day', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'sent',   'revtok2', now() - interval '1 day', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'queued', 'revtok3', now() + interval '1 hour', null);

insert into public.opt_out_links (token, business_id, mobile) values
  ('optok1', '00000000-0000-0000-0000-0000000000a2', '+61491570006');

-- ---------- click recording ----------
select is((select first_click from public.handle_review('revtok1', true)), true, 'first real click is recorded');
select is((select first_click from public.handle_review('revtok1', true)), false, 'a second click is not recorded as first');
select is((select found from public.handle_review('revtok2', false)), true, 'lookup works without recording');
select is((select clicked_at from public.messages where token = 'revtok2'), null, 'record=false leaves the message unclicked');
select is((select found from public.handle_review('nope', true)), false, 'unknown review token is not found');

-- ---------- opt-out ----------
select is((select found from public.opt_out_by_token('optok1')), true, 'opt-out token is found');
select ok(
  exists (select 1 from public.opt_outs o where o.business_id = '00000000-0000-0000-0000-0000000000a2' and o.mobile = '+61491570006'),
  'opt-out is recorded for the number'
);
select is((select status from public.messages where token = 'revtok3'), 'opted_out', 'queued message is cancelled on opt-out');
select is((select found from public.opt_out_by_token('nope')), false, 'unknown opt-out token is not found');

select * from finish();
