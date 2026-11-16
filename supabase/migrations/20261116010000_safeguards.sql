-- ============================================================================
-- Safeguards + admin testing helpers.
--
-- 1. send_allowed() — the send-allowlist rule. In a non-production environment
--    only log_only (and allowlisted numbers) may send. The Worker (stage 5)
--    passes PRODUCTION and SEND_ALLOWLIST from its env vars.
-- 2. cancel_dev_messages() — one-time cleanup: cancels every queued/sending
--    message created during development (service-role only), returns the count.
-- 3. reset_number() — admin-only: clears a number's request history so it can
--    be re-added, without touching opt-outs.
-- ============================================================================

-- ---------- 1. Send allowlist ----------

create or replace function public.send_allowed(
  p_send_mode public.send_mode,
  p_mobile text,
  p_is_production boolean,
  p_allowlist text[]
)
returns boolean
language sql
immutable
as $$
  select p_is_production
      or p_send_mode = 'log_only'
      or p_mobile = any(p_allowlist)
$$;

-- ---------- 2. Cancel development messages ----------

create or replace function public.cancel_dev_messages()
returns table (cancelled bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  update public.messages
     set status = 'failed',
         failed_at = now(),
         retryable = false,
         last_error = 'cancelled before go-live',
         updated_at = now()
   where status in ('queued', 'sending');
  get diagnostics v_count = row_count;
  return query select v_count;
end;
$$;

revoke execute on function public.cancel_dev_messages() from public;
grant execute on function public.cancel_dev_messages() to service_role;

-- ---------- 3. Admin-only reset number (keeps opt-outs) ----------

create or replace function public.reset_number(p_business_id uuid, p_mobile text)
returns table (deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mobile text;
  v_count bigint;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  v_mobile := public.normalise_au_mobile(p_mobile);
  if v_mobile is null then
    raise exception 'invalid mobile' using errcode = '22023';
  end if;

  -- Clear the number's whole request history (messages of every status), but
  -- leave opt_outs untouched so an opted-out number stays opted out.
  delete from public.messages m
  using public.customers c
  where m.customer_id = c.id
    and c.business_id = p_business_id
    and c.mobile = v_mobile;
  get diagnostics v_count = row_count;

  return query select v_count;
end;
$$;
