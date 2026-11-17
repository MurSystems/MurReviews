-- ============================================================================
-- The 15/day import drip and the 100/day safety cap are separate settings.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(1);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', 'active', '00000000-0000-0000-0000-0000000000a1');
-- daily_send_cap defaults to 15 (drip); daily_text_cap defaults to 100 (safety).

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia', '+61491570006');

insert into public.messages (business_id, customer_id, status, token, scheduled_at)
select '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'queued', 'tok-' || i, now() - interval '1 minute'
from generate_series(1, 20) i;

select * from public.claim_due_messages();

select is(
  (select count(*) from public.messages where business_id = '00000000-0000-0000-0000-0000000000a2' and status = 'sending'),
  20::bigint,
  'the 15/day drip cap does not limit normal sending'
);

select * from finish();
