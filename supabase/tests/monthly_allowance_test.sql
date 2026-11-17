-- ============================================================================
-- Monthly text allowance: 80% warning, pause at the allowance, monthly reset,
-- mock exclusion, stale-queue cancellation and the admin allowance override.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a101', 'owner@allowance.test'),
  ('00000000-0000-0000-0000-00000000a109', 'admin@allowance.test');

-- 1-2. Melbourne month boundaries (December is AEDT, UTC+11).
select is(
  public.month_start_melbourne('2026-12-15 10:00:00+11'::timestamptz),
  '2026-12-01 00:00:00+11'::timestamptz,
  'the month starts at midnight on the 1st, Melbourne time'
);
select is(
  public.next_month_start_melbourne('2026-12-15 10:00:00+11'::timestamptz),
  '2027-01-01 00:00:00+11'::timestamptz,
  'the reset date is midnight on the 1st of the next month'
);

-- Warning business: 200 allowance, 160 real sends this month.
insert into public.businesses (id, name, place_id, status, owner_id, monthly_text_cap, daily_text_cap)
values ('00000000-0000-0000-0000-00000000a102', 'Allowance Biz', 'place-allow', 'active',
        '00000000-0000-0000-0000-00000000a101', 200, 1000);

insert into public.customers (id, business_id, first_name, mobile)
values ('00000000-0000-0000-0000-00000000a103', '00000000-0000-0000-0000-00000000a102', 'Mia', '+61491570006');

insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at)
select '00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a103',
       'sent', 'allow-warn-' || g, now(), now()
  from generate_series(1, 160) g;

select is(
  (select state from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  'warning',
  '80% of the allowance shows the warning state'
);
select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  160::bigint,
  'usage counts real sends this month'
);

-- 5. Mock sends never count.
insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at, mock)
values ('00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a103',
        'sent', 'allow-mock', now(), now(), true);
select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  160::bigint,
  'mock sends do not count towards the allowance'
);

-- 6-7. Reaching 200 pauses sending.
insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at)
select '00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a103',
       'sent', 'allow-full-' || g, now(), now()
  from generate_series(1, 40) g;

select is(
  (select state from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  'paused',
  'the state is paused at the allowance'
);
select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  200::bigint,
  'usage reaches the allowance'
);

-- 8. Queued text is not claimed while the allowance is used up.
insert into public.messages (id, business_id, customer_id, status, token, scheduled_at)
values ('00000000-0000-0000-0000-00000000a120', '00000000-0000-0000-0000-00000000a102',
        '00000000-0000-0000-0000-00000000a103', 'queued', 'allow-paused-queue', now() - interval '1 minute');

select is(
  (select count(*) from public.claim_due_messages()
    where business_id = '00000000-0000-0000-0000-00000000a102'),
  0::bigint,
  'a business at its monthly allowance claims nothing'
);

-- 9-11. A send from last month does not count after the reset.
insert into public.businesses (id, name, place_id, status, owner_id, monthly_text_cap)
values ('00000000-0000-0000-0000-00000000a104', 'Reset Biz', 'place-reset', 'active',
        '00000000-0000-0000-0000-00000000a101', 200);

insert into public.customers (id, business_id, first_name, mobile)
values ('00000000-0000-0000-0000-00000000a105', '00000000-0000-0000-0000-00000000a104', 'Sam', '+61491570007');

insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at)
values ('00000000-0000-0000-0000-00000000a104', '00000000-0000-0000-0000-00000000a105',
        'sent', 'allow-last-month', now() - interval '1 month',
        public.month_start_melbourne() - interval '1 minute');

select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-00000000a104')),
  0::bigint,
  'sends from the previous month are not counted'
);
select is(
  (select state from public.business_text_usage('00000000-0000-0000-0000-00000000a104')),
  'ok',
  'usage resets to ok on the 1st'
);
select is(
  (select reset_at from public.business_text_usage('00000000-0000-0000-0000-00000000a104')),
  (select period_end from public.billing_period(
     (select billing_anchor from public.businesses where id = '00000000-0000-0000-0000-00000000a104'),
     now())),
  'the reset date is the end of this business’s billing period'
);

-- 12-15. Queued texts wait at most 7 days.
insert into public.businesses (id, name, place_id, status, owner_id)
values ('00000000-0000-0000-0000-00000000a106', 'Stale Biz', 'place-stale', 'active',
        '00000000-0000-0000-0000-00000000a101');

insert into public.customers (id, business_id, first_name, mobile)
values ('00000000-0000-0000-0000-00000000a107', '00000000-0000-0000-0000-00000000a106', 'Lee', '+61491570008');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-00000000a121', '00000000-0000-0000-0000-00000000a106',
   '00000000-0000-0000-0000-00000000a107', 'queued', 'allow-stale-8d', now() - interval '8 days'),
  ('00000000-0000-0000-0000-00000000a122', '00000000-0000-0000-0000-00000000a106',
   '00000000-0000-0000-0000-00000000a107', 'queued', 'allow-stale-6d', now() - interval '6 days');

select public.expire_stale_queued_messages();

select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-00000000a121'),
  'cancelled',
  'a queued text more than 7 days old is cancelled'
);
select is(
  (select retryable from public.messages where id = '00000000-0000-0000-0000-00000000a121'),
  false,
  'an expired text is not retried'
);
select is(
  (select last_error from public.messages where id = '00000000-0000-0000-0000-00000000a121'),
  'Cancelled after waiting more than 7 days to send.',
  'the cancellation reason is recorded'
);
select is(
  (select status from public.messages where id = '00000000-0000-0000-0000-00000000a122'),
  'queued',
  'a queued text under 7 days old keeps waiting'
);

-- 16-19. Admin can raise one business's allowance.
select public.admin_set_monthly_cap(
  '00000000-0000-0000-0000-00000000a102', 1000, '00000000-0000-0000-0000-00000000a109');

select is(
  (select monthly_text_cap from public.businesses where id = '00000000-0000-0000-0000-00000000a102'),
  1000,
  'admin_set_monthly_cap raises the allowance'
);
select is(
  (select state from public.business_text_usage('00000000-0000-0000-0000-00000000a102')),
  'ok',
  'the higher allowance clears the paused state'
);
select is(
  (select count(*) from public.claim_due_messages()
    where business_id = '00000000-0000-0000-0000-00000000a102'),
  1::bigint,
  'sending resumes after the allowance is raised'
);
select ok(
  exists (select 1 from public.audit_log
           where action = 'set_monthly_cap'
             and details->>'business_id' = '00000000-0000-0000-0000-00000000a102'
             and details->>'monthly_text_cap' = '1000'),
  'changing an allowance is recorded in the audit log'
);

-- 20. A business created without an allowance gets the 200 default.
insert into public.businesses (id, name, place_id, status, owner_id)
values ('00000000-0000-0000-0000-00000000a108', 'Default Biz', 'place-default', 'active',
        '00000000-0000-0000-0000-00000000a101');

select is(
  (select monthly_text_cap from public.businesses where id = '00000000-0000-0000-0000-00000000a108'),
  200,
  'new businesses default to 200 texts per month'
);

select * from finish();
