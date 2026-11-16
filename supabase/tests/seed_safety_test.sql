-- ============================================================================
-- Seed safety: the demo numbers are ACMA-reserved fictitious mobiles, and the
-- seed leaves nothing in 'queued' that the cron could pick up and send.
--
-- Run with:  supabase test db --linked --yes
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(2);

-- 1. every ACMA fictitious mobile (0491 570 xxx block) normalises to E.164
select results_eq(
  $$select public.normalise_au_mobile(n) from (values
     ('0491 570 006'), ('0491 570 110'), ('0491 570 156'), ('0491 570 157'),
     ('0491 570 158'), ('0491 570 159'), ('0491 570 313'), ('0491 570 737')
  ) as t(n)$$,
  array['+61491570006','+61491570110','+61491570156','+61491570157',
        '+61491570158','+61491570159','+61491570313','+61491570737'],
  'ACMA fictitious mobiles normalise correctly'
);

-- 2. seed-shaped data (only sent/clicked/failed/opted_out, never queued) means
--    claim_due_messages() has nothing to send — the cron can never text a
--    seed number.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'demo@test.local');

insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Demo Cafe', 'place-demo', 'active', 'demo', '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, kind, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'sent',    's1', now() - interval '2 days', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'clicked', 's2', now() - interval '1 day',  now() - interval '1 day');

select is_empty(
  'select * from public.claim_due_messages()',
  'cron has nothing to send from seed-shaped data'
);

select * from finish();
