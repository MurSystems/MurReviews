-- ============================================================================
-- Stage 6: ensure owner exists (for onboarding) and read the audit log.
-- ============================================================================

create or replace function public.admin_ensure_owner(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    insert into auth.users (id, email, email_confirmed_at)
    values (gen_random_uuid(), p_email, now())
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.admin_ensure_owner(text) from anon, authenticated;
grant execute on function public.admin_ensure_owner(text) to service_role;

create or replace function public.admin_get_audit()
returns table (id uuid, admin_email text, action text, details jsonb, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select a.id, u.email, a.action, a.details, a.created_at
    from public.audit_log a
    left join auth.users u on u.id = a.admin_id
   order by a.created_at desc
   limit 200;
$$;

revoke execute on function public.admin_get_audit() from anon, authenticated;
grant execute on function public.admin_get_audit() to service_role;
