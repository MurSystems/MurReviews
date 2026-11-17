-- ============================================================================
-- Logo: bucket settings and the owner's ability to save logo_url.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'logo-owner@test.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'logo-other@test.local');

insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000c3', 'Logo Biz', 'place-logo', 'active', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000c4', 'Other Biz', 'place-other', 'active', '00000000-0000-0000-0000-0000000000c2');

select is(
  (select file_size_limit from storage.buckets where id = 'logos'),
  1048576::bigint,
  'logos bucket limit is 1 MB'
);
select is(
  (select public from storage.buckets where id = 'logos'),
  true,
  'logos bucket is public'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'logos'),
  array['image/png', 'image/jpeg', 'image/webp'],
  'logos bucket only accepts PNG, JPG and WebP'
);

set local role authenticated;

set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
select lives_ok(
  $$ update public.businesses set logo_url = 'https://m.example/logos/x.png?v=1'
      where id = '00000000-0000-0000-0000-0000000000c3' $$,
  'owner can save logo_url'
);
select is(
  (select logo_url from public.businesses where id = '00000000-0000-0000-0000-0000000000c3'),
  'https://m.example/logos/x.png?v=1',
  'logo_url is stored'
);

-- A different owner cannot touch this business.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
update public.businesses set logo_url = 'https://m.example/stolen.png'
 where id = '00000000-0000-0000-0000-0000000000c3';
reset role;
select is(
  (select logo_url from public.businesses where id = '00000000-0000-0000-0000-0000000000c3'),
  'https://m.example/logos/x.png?v=1',
  'another owner cannot change the logo'
);

select * from finish();
