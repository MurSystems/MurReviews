-- ============================================================================
-- Texts that do not look like spam: {sender_name}, the new default template,
-- the graceful fallbacks and the admin preview.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e101', 'admin@template.test'),
  ('00000000-0000-0000-0000-00000000e102', 'owner@template.test');

insert into public.businesses (id, name, place_id, status, send_mode, owner_id, sender_name)
values ('00000000-0000-0000-0000-00000000e103', 'Mur Demo', 'place-demo', 'active', 'demo',
        '00000000-0000-0000-0000-00000000e102', 'Azlaan');

select is(
  (select message_template from public.businesses
    where id = '00000000-0000-0000-0000-00000000e103'),
  'Hi {first_name}, it''s {sender_name} from {business}. Thanks for choosing us. '
  'If you have a minute, a quick Google review would really help: {review_link} '
  'Opt out: {opt_out}',
  'the default template uses the sender name and plain language'
);

select is(
  public.render_message_text(
    (select message_template from public.businesses
      where id = '00000000-0000-0000-0000-00000000e103'),
    'Mia', 'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'https://mur.reviews/o/abcdEFGH12',
    'Azlaan'),
  'Hi Mia, it''s Azlaan from Mur Demo. Thanks for choosing us. If you have a minute, '
  'a quick Google review would really help: https://mur.reviews/r/abcdEFGH12 '
  'Opt out: https://mur.reviews/o/abcdEFGH12',
  'the text reads naturally with a sender name'
);

select is(
  public.render_message_text(
    (select message_template from public.businesses
      where id = '00000000-0000-0000-0000-00000000e103'),
    'Mia', 'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'STOP', null),
  'Hi Mia from Mur Demo. Thanks for choosing us. If you have a minute, '
  'a quick Google review would really help: https://mur.reviews/r/abcdEFGH12 Opt out: STOP',
  'without a sender name it reads "Hi Mia from Mur Demo"'
);

select is(
  public.render_message_nameless(
    (select message_template from public.businesses
      where id = '00000000-0000-0000-0000-00000000e103'),
    'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'STOP', 'Azlaan'),
  'Hi, it''s Azlaan from Mur Demo. Thanks for choosing us. If you have a minute, '
  'a quick Google review would really help: https://mur.reviews/r/abcdEFGH12 Opt out: STOP',
  'the nameless fallback still names the sender'
);

select ok(
  public.gsm7_length(
    public.render_send_message(
      (select message_template from public.businesses
        where id = '00000000-0000-0000-0000-00000000e103'),
      'Mia', 'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'STOP', 'Azlaan')
  ) <= 160,
  'a normal text fits one segment, dropping the sender name when it would not'
);

select isnt(
  public.render_send_message(
    (select message_template from public.businesses
      where id = '00000000-0000-0000-0000-00000000e103'),
    repeat('x', 140), 'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'STOP', 'Azlaan'),
  public.render_message_text(
    (select message_template from public.businesses
      where id = '00000000-0000-0000-0000-00000000e103'),
    repeat('x', 140), 'Mur Demo', 'https://mur.reviews/r/abcdEFGH12', 'STOP', 'Azlaan'),
  'a very long first name falls back to the nameless text'
);

select is(public.gsm7_segments(160), 1, '160 characters is one text');
select is(public.gsm7_segments(161), 2, '161 characters is two texts');
select is(public.gsm7_segments(306), 2, '306 characters still fits two texts');
select is(public.gsm7_segments(307), 3, '307 characters needs three texts');

select lives_ok(
  $$select public.admin_set_sender_name(
      '00000000-0000-0000-0000-00000000e103', '  Az  ',
      '00000000-0000-0000-0000-00000000e101')$$,
  'the sender name can be saved'
);

select is(
  (select sender_name from public.businesses
    where id = '00000000-0000-0000-0000-00000000e103'),
  'Az',
  'the sender name is trimmed'
);

select is(
  (select example_text from public.admin_preview_message(
      '00000000-0000-0000-0000-00000000e103', 'https://m.test')),
  'Hi Mia, it''s Az from Mur Demo. Thanks for choosing us. If you have a minute, '
  'a quick Google review would really help: https://m.test/r/abcdEFGH12 '
  'Opt out: Reply STOP to opt out',
  'the admin preview shows the exact text that goes out'
);

select * from finish();
