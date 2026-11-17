-- ============================================================================
-- Monthly text allowance: 200 texts per business (down from 500).
--
-- New businesses get 200 by default and every existing business moves to it.
-- Usage, the 80% warning (160 texts) and the pause at the allowance all read
-- the per-business cap, so no function changes are needed. Admins can still
-- raise one business with admin_set_monthly_cap. First texts and reminders
-- both count; mock and test sends never do.
-- ============================================================================

alter table public.businesses
  alter column monthly_text_cap set default 200;

update public.businesses
   set monthly_text_cap = 200;
