-- ============================================================================
-- Follow-ups: nameless fallback, template validation, base62 tokens.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(8);

-- ---------- nameless fallback ----------
select is(
  public.render_send_message(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    'Mia', 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  ),
  public.render_message_text(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    'Mia', 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  ),
  'a short name keeps the first name'
);
select is(
  public.render_send_message(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    repeat('x', 50), 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  ),
  public.render_message_nameless(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  ),
  'a long first name falls back to the nameless version'
);
select ok(
  public.gsm7_length(public.render_send_message(
    'Hi {first_name}, just a friendly nudge to leave {business} a Google review: {review_link} {opt_out}',
    repeat('x', 50), 'Demo Cafe', 'https://mur.reviews/r/abcdefghijklmnop', 'Reply STOP to opt out'
  )) <= 160,
  'the nameless fallback fits 160 GSM-7 characters'
);

-- ---------- template validation ----------
select lives_ok(
  $$select public.validate_template('Hi {first_name}, thanks for choosing {business}: {review_link} {opt_out}', 'Demo Cafe', 'https://reviews-mur-systems.mursystems.workers.dev/r/abcdEFGH12', 'Reply STOP to opt out')$$,
  'a short template is accepted'
);
select throws_ok(
  $$select public.validate_template(repeat('x', 200), 'Demo Cafe', 'https://reviews-mur-systems.mursystems.workers.dev/r/abcdEFGH12', 'Reply STOP to opt out')$$,
  22023
);

-- ---------- base62 tokens ----------
select is(char_length(public.new_token()), 8, 'default token is 8 characters');
select is(char_length(public.new_token(8)), 8, 'token can be the 8-character minimum');
select ok(public.new_token() ~ '^[A-Za-z0-9]+$', 'token is base62 only');

select * from finish();
