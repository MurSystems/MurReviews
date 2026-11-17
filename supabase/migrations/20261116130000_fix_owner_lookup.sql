-- Fix: the owner must be created by the auth admin API (generate_link
-- magiclink), not by a direct insert. A direct insert leaves an incomplete
-- auth.user that later breaks generate_link. Replace ensure with a read-only
-- lookup; the "generate login link" flow is what creates the user.
drop function if exists public.admin_ensure_owner(text);

create or replace function public.admin_find_owner(p_email text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users where email = p_email limit 1;
$$;

revoke execute on function public.admin_find_owner(text) from anon, authenticated;
grant execute on function public.admin_find_owner(text) to service_role;
