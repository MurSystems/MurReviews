-- ============================================================================
-- Logo storage rules: a business can only write its own logo.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(2);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@test.local');

insert into public.businesses (id, name, place_id, owner_id) values
  ('00000000-0000-0000-0000-0000000000a2', 'Biz A', 'place-a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Biz B', 'place-b', '00000000-0000-0000-0000-0000000000b1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('logos', '00000000-0000-0000-0000-0000000000a2/logo')$$,
  'owner can upload their own logo'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('logos', '00000000-0000-0000-0000-0000000000b2/logo')$$,
  42501
);

select * from finish();
