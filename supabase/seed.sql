-- ============================================================================
-- Seed: one demo business + fake customers so every screen has data.
-- Runs after migrations (supabase db push --linked --include-seed).
--
-- Safety rules:
--   * Every mobile is an ACMA-reserved fictitious number from the 0491 570 xxx
--     block (006, 110, 156, 157, 158, 159, 313, 737). These belong to no one,
--     so even an accidental send can never reach a real person.
--   * There are NO messages, replies or review snapshots — Demo Cafe starts
--     clean so its dashboard, clicks and review counts show real zeros only.
-- ============================================================================

-- Demo owner (also an admin) — log in with mursystems123@gmail.com.
insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'mursystems123@gmail.com', now())
on conflict (id) do nothing;

update public.profiles set role = 'admin' where id = '11111111-1111-1111-1111-111111111111';

insert into public.businesses (id, name, place_id, timezone, send_mode, status, owner_id) values
  ('22222222-2222-2222-2222-222222222222', 'Demo Cafe', 'ChIJdemo0000000000000000', 'Australia/Melbourne', 'demo', 'active', '11111111-1111-1111-1111-111111111111')
on conflict (id) do nothing;

-- fake customers (ACMA fictitious mobiles)
insert into public.customers (id, business_id, first_name, mobile) values
  ('33333333-3333-3333-3333-000000000001', '22222222-2222-2222-2222-222222222222', 'Mia',    '+61491570006'),
  ('33333333-3333-3333-3333-000000000002', '22222222-2222-2222-2222-222222222222', 'Noah',   '+61491570156'),
  ('33333333-3333-3333-3333-000000000003', '22222222-2222-2222-2222-222222222222', 'Olivia', '+61491570157'),
  ('33333333-3333-3333-3333-000000000004', '22222222-2222-2222-2222-222222222222', 'Liam',   '+61491570158'),
  ('33333333-3333-3333-3333-000000000005', '22222222-2222-2222-2222-222222222222', 'Emma',   '+61491570159')
on conflict do nothing;

-- No messages, replies, opt-outs or review snapshots are seeded: Demo Cafe
-- must show zeros, not invented activity. Customers stay so the demo login
-- can add and test against fictitious numbers.

