-- ============================================================================
-- Function ACL hardening.
--
-- Supabase grants EXECUTE on new public functions to anon and authenticated by
-- default, and it also leaves an implicit PUBLIC grant. `revoke ... from public`
-- alone does therefore not close a function, and any function that was dropped
-- and recreated along the way picked the grant back up.
--
-- These functions are called only by the Worker with the service-role key (or
-- are trigger functions that need no EXECUTE grant at all), so anon and
-- authenticated must not be able to call them.
-- ============================================================================

revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid, integer)
  to service_role;

revoke execute on function public.admin_list_businesses()
  from public, anon, authenticated;
grant execute on function public.admin_list_businesses()
  to service_role;

revoke execute on function public.admin_find_owner(text)
  from public, anon, authenticated;
grant execute on function public.admin_find_owner(text)
  to service_role;

revoke execute on function public.admin_get_audit()
  from public, anon, authenticated;
grant execute on function public.admin_get_audit()
  to service_role;

revoke execute on function public.admin_places_usage()
  from public, anon, authenticated;
grant execute on function public.admin_places_usage()
  to service_role;

revoke execute on function public.prepare_send(uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_send(uuid, text)
  to service_role;

revoke execute on function public.record_review_snapshot(uuid, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.record_review_snapshot(uuid, numeric, integer)
  to service_role;

-- Trigger functions: a trigger does not check EXECUTE, so callers should not
-- have the grant.
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;

revoke execute on function public.enforce_logo_url_owner()
  from public, anon, authenticated;

-- owner_dashboard is owner-facing: authenticated keeps it, anon does not.
revoke execute on function public.owner_dashboard(uuid)
  from public, anon;
grant execute on function public.owner_dashboard(uuid)
  to authenticated, service_role;
