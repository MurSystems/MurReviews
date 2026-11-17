-- ============================================================================
-- Client onboarding: sender mobile, Mobile Message verification gate and the
-- dated checklist.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c101', 'admin@onboarding.test'),
  ('00000000-0000-0000-0000-00000000c102', 'owner@onboarding.test');

insert into public.businesses (id, name, place_id, status, send_mode, owner_id)
values ('00000000-0000-0000-0000-00000000c103', 'Sender Biz', 'place-sender',
        'active', 'sms_provider', '00000000-0000-0000-0000-00000000c102');

insert into public.customers (id, business_id, first_name, mobile)
values ('00000000-0000-0000-0000-00000000c104', '00000000-0000-0000-0000-00000000c103',
        'Mia', '+61491570006');

insert into public.messages (business_id, customer_id, status, token, scheduled_at)
values ('00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-00000000c104',
        'queued', 'onb-queued', now() - interval '1 minute');

select ok(
  (select business_created_at is not null from public.business_onboarding
    where business_id = '00000000-0000-0000-0000-00000000c103'),
  'a new business gets an onboarding row with the created date ticked'
);

select is(
  (select sender_number from public.businesses
    where id = '00000000-0000-0000-0000-00000000c103') is null,
  true,
  'a new business has no sender mobile yet'
);

-- Live sms_provider sends wait until the sender is verified.
select is_empty(
  $$select * from public.claim_due_messages()$$,
  'an unverified sender blocks the queued live send'
);

select lives_ok(
  $$select public.admin_set_sender_number(
      '00000000-0000-0000-0000-00000000c103', '0411 875 278',
      '00000000-0000-0000-0000-00000000c101')$$,
  'the sender mobile can be saved'
);

select is(
  (select sender_number from public.businesses
    where id = '00000000-0000-0000-0000-00000000c103'),
  '+61411875278',
  'the sender mobile is stored as an Australian mobile'
);

select throws_ok(
  $$select public.admin_set_sender_number(
      '00000000-0000-0000-0000-00000000c103', '02 9000 0000',
      '00000000-0000-0000-0000-00000000c101')$$,
  '22023', null,
  'a landline is refused as a sender'
);

select lives_ok(
  $$select public.admin_mark_sender_verified(
      '00000000-0000-0000-0000-00000000c103', true,
      '00000000-0000-0000-0000-00000000c101')$$,
  'a Mobile Message check can mark the sender verified'
);

select is(
  (select sender_verified_at is not null and number_verified_at is not null
     from public.businesses b
     join public.business_onboarding o on o.business_id = b.id
    where b.id = '00000000-0000-0000-0000-00000000c103'),
  true,
  'verifying ticks both the sender and the checklist'
);

select is(
  (select count(*) from public.claim_due_messages()),
  1::bigint,
  'a verified sender lets the queued live send go out'
);

-- Changing the number means it has to be verified again.
select lives_ok(
  $$select public.admin_set_sender_number(
      '00000000-0000-0000-0000-00000000c103', '0491 570 110',
      '00000000-0000-0000-0000-00000000c101')$$,
  'the sender mobile can be changed'
);

select is(
  (select sender_verified_at is null and number_verified_at is null
     from public.businesses b
     join public.business_onboarding o on o.business_id = b.id
    where b.id = '00000000-0000-0000-0000-00000000c103'),
  true,
  'changing the number clears its verification'
);

-- Checklist ticks are dated and can be undone.
select lives_ok(
  $$select public.admin_toggle_onboarding(
      '00000000-0000-0000-0000-00000000c103', 'payment_taken', true,
      '00000000-0000-0000-0000-00000000c101')$$,
  'an onboarding item can be ticked'
);

insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at, mock)
values ('00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-00000000c104',
        'sent', 'onb-mock', now(), now(), true);

select is(
  (select payment_taken_at is not null from public.business_onboarding
    where business_id = '00000000-0000-0000-0000-00000000c103'),
  true,
  'a ticked item keeps its date'
);

select is(
  (select tests_count from public.admin_list_businesses()
    where id = '00000000-0000-0000-0000-00000000c103'),
  1::bigint,
  'test sends are counted separately from sent texts'
);

select is(
  (select texts_sent from public.admin_list_businesses()
    where id = '00000000-0000-0000-0000-00000000c103'),
  0::bigint,
  'test sends never count as sent texts'
);

select * from finish();
