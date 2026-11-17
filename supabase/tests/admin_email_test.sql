-- ============================================================================
-- is_admin_email: the login page's server-side admin check.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(3);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin-check@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'owner-check@test.local');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000e1';

select is(
  public.is_admin_email('admin-check@test.local'),
  true,
  'an admin email is recognised'
);
select is(
  public.is_admin_email('OWNER-CHECK@TEST.LOCAL'),
  false,
  'an owner is not an admin, with or without case differences'
);
select is(
  public.is_admin_email('nobody@test.local'),
  false,
  'an unknown email is not an admin'
);

select * from finish();
