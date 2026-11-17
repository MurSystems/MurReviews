-- ============================================================================
-- Fix two issues:
-- 1. Drop the old 2-arg mark_sent (now ambiguous with the 3-arg default).
-- 2. `revoke ... from public` does NOT override Supabase's default direct
--    EXECUTE grant to `anon`/`authenticated`. Revoke from those roles directly
--    so service-role-only functions are truly service-role only.
-- ============================================================================

drop function if exists public.mark_sent(uuid, text);

revoke execute on function public.claim_due_messages(integer) from anon, authenticated;
revoke execute on function public.fail_stale_sends(interval) from anon, authenticated;
revoke execute on function public.cancel_dev_messages() from anon, authenticated;
revoke execute on function public.queue_reminders() from anon, authenticated;
revoke execute on function public.prepare_send(uuid, text) from anon, authenticated;
revoke execute on function public.mark_sent(uuid, text, boolean) from anon, authenticated;
revoke execute on function public.mark_failed(uuid, text, boolean) from anon, authenticated;
revoke execute on function public.handle_inbound_sms(text, text, text) from anon, authenticated;
revoke execute on function public.touch_gateway(text) from anon, authenticated;
revoke execute on function public.handle_review(text, boolean) from anon, authenticated;
revoke execute on function public.opt_out_by_token(text) from anon, authenticated;
revoke execute on function public.admin_create_business(text, text, text, public.send_mode, integer, uuid, uuid) from anon, authenticated;
revoke execute on function public.admin_list_businesses() from anon, authenticated;
revoke execute on function public.admin_set_business_status(uuid, public.business_status, integer, uuid) from anon, authenticated;
revoke execute on function public.admin_demo_send(text, text, uuid) from anon, authenticated;
