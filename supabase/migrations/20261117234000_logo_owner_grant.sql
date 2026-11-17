-- ============================================================================
-- Logo upload fix: the storage bucket and policies were fine, but owners were
-- only granted UPDATE on (delay_minutes, message_template). Saving the uploaded
-- logo URL therefore failed with 42501 and the header kept showing initials.
-- ============================================================================

grant update (logo_url) on public.businesses to authenticated;
