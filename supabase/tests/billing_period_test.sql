-- ============================================================================
-- Billing-period allowance: normal months, the 31st, February, and a business
-- created today. The period runs from the anchor day to the same day next
-- month (last day when that day does not exist), Melbourne time.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(13);

-- ---------- a normal month ----------

select is(
  (select period_start from public.billing_period('2026-09-15'::date, '2026-10-14 12:00+11')),
  '2026-09-15 00:00:00+10'::timestamptz,
  'the period starts on the anchor day'
);
select is(
  (select period_end from public.billing_period('2026-09-15'::date, '2026-10-14 12:00+11')),
  '2026-10-15 00:00:00+11'::timestamptz,
  'the period ends on the same day next month'
);

-- ---------- the 31st ----------

select is(
  (select period_start from public.billing_period('2026-01-31'::date, '2026-02-15 12:00+11')),
  '2026-01-31 00:00:00+11'::timestamptz,
  'a 31st anchor starts on 31 January'
);
select is(
  (select period_end from public.billing_period('2026-01-31'::date, '2026-02-15 12:00+11')),
  '2026-02-28 00:00:00+11'::timestamptz,
  'a 31st anchor resets on the last day of February'
);
select is(
  (select period_start from public.billing_period('2026-01-31'::date, '2026-03-01 12:00+11')),
  '2026-02-28 00:00:00+11'::timestamptz,
  'after February the period still starts on the clamped day'
);
select is(
  (select period_end from public.billing_period('2026-01-31'::date, '2026-03-01 12:00+11')),
  '2026-03-31 00:00:00+11'::timestamptz,
  'the March period returns to the 31st'
);

-- ---------- February ----------

select is(
  (select period_end from public.billing_period('2026-01-30'::date, '2026-02-15 12:00+11')),
  '2026-02-28 00:00:00+11'::timestamptz,
  'a 30th anchor resets on the last day of February'
);
select is(
  (select period_start from public.billing_period('2026-01-30'::date, '2026-02-28 12:00+11')),
  '2026-02-28 00:00:00+11'::timestamptz,
  'on the clamped day a new February period starts'
);
select is(
  (select period_end from public.billing_period('2026-01-30'::date, '2026-02-28 12:00+11')),
  '2026-03-30 00:00:00+11'::timestamptz,
  'the next reset returns to the 30th'
);

-- ---------- a business created today ----------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000b101', 'owner@billing.test');

insert into public.businesses (id, name, place_id, status, owner_id, monthly_text_cap)
values ('00000000-0000-0000-0000-00000000b102', 'New Biz', 'place-new', 'active',
        '00000000-0000-0000-0000-00000000b101', 2);

insert into public.customers (id, business_id, first_name, mobile)
values ('00000000-0000-0000-0000-00000000b103', '00000000-0000-0000-0000-00000000b102',
        'Mia', '+61491570006');

select is(
  (select billing_anchor from public.businesses where id = '00000000-0000-0000-0000-00000000b102'),
  (now() at time zone 'Australia/Melbourne')::date,
  'a new business bills from the day it was created'
);

-- One send inside the period, one a second before it, and one mock. Only the
-- in-period real send counts.
insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at, mock)
select '00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b103',
       'sent', 'bill-' || g, bp.period_start, bp.period_start, false
  from generate_series(1, 1) g, public.billing_period(current_date, now()) bp;

insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at, mock)
select '00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b103',
       'sent', 'bill-before', bp.period_start, bp.period_start - interval '1 second', false
  from public.billing_period(current_date, now()) bp;

insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at, mock)
select '00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b103',
       'sent', 'bill-mock', bp.period_start, bp.period_start, true
  from public.billing_period(current_date, now()) bp;

select is(
  (select used from public.business_text_usage('00000000-0000-0000-0000-00000000b102')),
  1::bigint,
  'usage counts this billing period only, and never mocks'
);
select is(
  (select reset_at from public.business_text_usage('00000000-0000-0000-0000-00000000b102')),
  (select period_end from public.billing_period(current_date, now())),
  'the reset date is the end of the current billing period'
);

-- A second real send reaches the allowance and pauses the business.
insert into public.messages (business_id, customer_id, status, token, scheduled_at, sent_at)
select '00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b103',
       'sent', 'bill-full', bp.period_start, bp.period_start
  from public.billing_period(current_date, now()) bp;

select is(
  (select state from public.business_text_usage('00000000-0000-0000-0000-00000000b102')),
  'paused',
  'reaching the allowance in this period pauses sending'
);

select * from finish();
