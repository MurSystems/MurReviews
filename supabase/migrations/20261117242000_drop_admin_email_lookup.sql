-- ============================================================================
-- Remove the pre-login admin email lookup.
--
-- The login page must respond the same way for every email so it cannot be
-- used to discover admin accounts. Admin status is checked only after login,
-- from the authenticated session (profiles.role), and the Worker's /admin/*
-- guard verifies the caller's role on every admin request.
-- ============================================================================

drop function if exists public.is_admin_email(text);
