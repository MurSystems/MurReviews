-- ============================================================================
-- Stage 3: quiet hours (incl. DST), GSM-7/160 rule, reminder logic.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(13);

-- ---------- quiet hours ----------
select is(
  public.next_send_time('2026-11-16 19:59:00+11'::timestamptz, 'Australia/Melbourne'),
  '2026-11-16 19:59:00+11'::timestamptz,
  '7:59pm is within quiet hours and is not moved'
);
select is(
  public.next_send_time('2026-11-16 20:01:00+11'::timestamptz, 'Australia/Melbourne'),
  '2026-11-17 09:00:00+11'::timestamptz,
  '8:01pm rolls forward to 9am the next day'
);
select is(
  public.next_send_time('2026-11-16 08:00:00+11'::timestamptz, 'Australia/Melbourne'),
  '2026-11-16 09:00:00+11'::timestamptz,
  '8am rolls forward to 9am the same day'
);
select is(
  public.next_send_time('2026-04-04 20:30:00+11'::timestamptz, 'Australia/Melbourne'),
  '2026-04-05 09:00:00+10'::timestamptz,
  'DST fall-back day: 8:30pm rolls to 9am AEST (+10)'
);
select is(
  public.next_send_time('2026-10-03 20:30:00+10'::timestamptz, 'Australia/Melbourne'),
  '2026-10-04 09:00:00+11'::timestamptz,
  'DST spring-forward day: 8:30pm rolls to 9am AEDT (+11)'
);

-- ---------- GSM-7 / 160 rule ----------
select is(public.gsm7_length('abc'), 3, 'plain characters count as one septet');
select is(public.gsm7_length('a€b'), 4, 'extended characters count as two septets');
select ok(
  public.gsm7_length(public.render_message_text(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    'Mia', 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  )) <= 160,
  'reminder template fits 160 GSM-7 characters for a normal name'
);
select ok(
  public.gsm7_length(public.render_message_text(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    repeat('x', 50), 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  )) > 160,
  'a long first name pushes the reminder over 160 GSM-7 characters'
);

-- ---------- reminder logic ----------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

insert into public.businesses (id, name, place_id, status, trial_text_cap, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Active Biz', 'place-a', 'active', 30, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Paused Biz', 'place-b', 'paused', 30, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c2', 'Trial Biz',  'place-c', 'trial',  1,  '00000000-0000-0000-0000-0000000000a1');

insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 'Mia',    '+61491570006'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', 'Noah',   '+61491570156'),
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a2', 'Olivia', '+61491570157'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 'Liam',   '+61491570158'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c2', 'Emma',   '+61491570159');

insert into public.opt_outs (business_id, mobile) values
  ('00000000-0000-0000-0000-0000000000a2', '+61491570156'); -- Noah opted out

insert into public.messages (id, business_id, customer_id, kind, status, token, scheduled_at, sent_at, clicked_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'initial', 'sent',    'tok-1', now() - interval '4 days', now() - interval '4 days', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', 'initial', 'sent',    'tok-2', now() - interval '4 days', now() - interval '4 days', null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'initial', 'clicked', 'tok-3', now() - interval '4 days', now() - interval '4 days', now() - interval '4 days'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'initial', 'sent',    'tok-4', now() - interval '4 days', now() - interval '4 days', null),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3', 'initial', 'sent',    'tok-5', now() - interval '4 days', now() - interval '4 days', null);

select * from public.queue_reminders();

select is(
  (select count(*) from public.messages where kind = 'reminder' and parent_id = '00000000-0000-0000-0000-0000000000d1'),
  1::bigint,
  'a sent, unclicked message older than 3 days gets a reminder'
);
select is(
  (select count(*) from public.messages where kind = 'reminder' and parent_id in
    ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000d5')),
  0::bigint,
  'no reminder when clicked, opted out, paused, or over trial cap'
);
select ok(
  extract(hour from ((select scheduled_at from public.messages where kind = 'reminder' and parent_id = '00000000-0000-0000-0000-0000000000d1') at time zone 'Australia/Melbourne')) between 9 and 19,
  'the reminder respects quiet hours'
);

select * from public.queue_reminders();
select is(
  (select count(*) from public.messages where kind = 'reminder' and parent_id = '00000000-0000-0000-0000-0000000000d1'),
  1::bigint,
  'running again does not create a duplicate reminder'
);

select * from finish();
