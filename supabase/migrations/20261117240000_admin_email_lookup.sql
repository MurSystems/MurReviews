-- ============================================================================
-- Admin lookup for the login page.
--
-- The frontend no longer carries an admin email list. Before login it asks
-- the Worker whether an email belongs to an admin profile; the Worker calls
-- this service-role-only function. The answer is only used to decide whether
-- to show the "email me a sign-in link" option.
-- ============================================================================

create or replace function public.is_admin_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from auth.users u
      join public.profiles p on p.id = u.id
     where u.email is not null
       and lower(u.email) = lower(btrim(p_email))
       and p.role = 'admin'
  );
$$;

revoke execute on function public.is_admin_email(text) from public, anon, authenticated;
grant execute on function public.is_admin_email(text) to service_role;
