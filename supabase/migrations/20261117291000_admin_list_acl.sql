-- Dropping and recreating admin_list_businesses() in the billing-period
-- migration reset its ACL to Supabase's default grants. Owners must not be
-- able to call it (the function exposes every tenant), so close it again.
revoke execute on function public.admin_list_businesses() from public, anon, authenticated;
grant execute on function public.admin_list_businesses() to service_role;
