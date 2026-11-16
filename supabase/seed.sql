-- ============================================================================
-- Seed: one demo business + fake customers so every screen has data.
-- Runs after migrations (supabase db push --linked --include-seed).
--
-- Safety rules:
--   * Every mobile is an ACMA-reserved fictitious number from the 0491 570 xxx
--     block (006, 110, 156, 157, 158, 159, 313, 737). These belong to no one,
--     so even an accidental send can never reach a real person.
--   * There are NO messages in status 'queued' — the cron has nothing to send.
--     (Verified by supabase/tests/seed_safety_test.sql.)
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

-- messages in a spread of non-queued states so Activity + Dashboard render,
-- with the final rendered text stored as the record of what went out.
insert into public.messages (id, business_id, customer_id, kind, status, token, message_text, scheduled_at, sent_at, clicked_at, failed_at, last_error) values
  ('44444444-4444-4444-4444-000000000001', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-000000000001', 'initial', 'sent',      'm1', 'Hi Mia, thanks for choosing Demo Cafe. A quick Google review would mean a lot: https://mur.reviews/r/m1 Reply STOP to opt out',    now() - interval '2 days', now() - interval '2 days', null, null, null),
  ('44444444-4444-4444-4444-000000000002', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-000000000002', 'initial', 'clicked',   'm2', 'Hi Noah, thanks for choosing Demo Cafe. A quick Google review would mean a lot: https://mur.reviews/r/m2 Reply STOP to opt out',   now() - interval '1 day',  now() - interval '1 day',  now() - interval '1 day', null, null),
  ('44444444-4444-4444-4444-000000000003', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-000000000003', 'initial', 'failed',    'm3', null, now() - interval '1 day', null, null, now() - interval '1 day', 'gateway timeout'),
  ('44444444-4444-4444-4444-000000000004', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-000000000004', 'initial', 'opted_out', 'm4', 'Hi Liam, thanks for choosing Demo Cafe. A quick Google review would mean a lot: https://mur.reviews/r/m4 Reply STOP to opt out',     now() - interval '3 days', null, null, null, null),
  ('44444444-4444-4444-4444-000000000005', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-000000000005', 'initial', 'sent',      'm5', 'Hi Emma, thanks for choosing Demo Cafe. A quick Google review would mean a lot: https://mur.reviews/r/m5 Reply STOP to opt out',    now() - interval '1 day',  now() - interval '1 day',  null, null, null)
on conflict do nothing;

insert into public.opt_outs (business_id, mobile, source) values
  ('22222222-2222-2222-2222-222222222222', '+61491570158', 'link')
on conflict do nothing;

insert into public.opt_out_links (token, business_id, mobile) values
  ('demo-opt-1', '22222222-2222-2222-2222-222222222222', '+61491570006')
on conflict do nothing;

insert into public.replies (business_id, from_mobile, body) values
  ('22222222-2222-2222-2222-222222222222', '+61491570006', 'Thanks, will do!')
on conflict do nothing;

insert into public.review_snapshots (business_id, snapshot_date, rating, review_count) values
  ('22222222-2222-2222-2222-222222222222', current_date - 1, 4.6, 42),
  ('22222222-2222-2222-2222-222222222222', current_date - 2, 4.5, 41)
on conflict do nothing;
