-- ============================================================================
-- Stage 6 follow-up: per-business monthly text cap.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(1);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000c2', 'Monthly Biz', 'place-c', 'active', '00000000-0000-0000-0000-0000000000a1');
update public.businesses set monthly_text_cap = 1 where id = '00000000-0000-0000-0000-0000000000c2';

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c2', 'Mia', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at, sent_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3', 'sent',   'tok-msent', now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3', 'queued', 'tok-mque',  now() - interval '1 minute', null);

select * from public.claim_due_messages();

select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-0000000000e2'),
  'queued',
  'a business at its monthly cap is not claimed'
);

select * from finish();
