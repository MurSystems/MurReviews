-- ============================================================================
-- AI review replies: an owner can register interest once per business.
-- The card in Settings inserts one row; admins see who asked via the business
-- listing. No update/delete: once recorded, it stays.
-- ============================================================================

create table public.ai_reply_interest (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  requested_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.ai_reply_interest enable row level security;

create policy "ai_reply_interest_select_own_or_admin" on public.ai_reply_interest
  for select using (public.can_access_business(business_id));

create policy "ai_reply_interest_insert_own" on public.ai_reply_interest
  for insert with check (public.can_access_business(business_id));

-- One record per business, written once by the owner.
revoke update, delete on public.ai_reply_interest from anon, authenticated;

-- Surface the request in the admin business listing.
drop function if exists public.admin_list_businesses();
create or replace function public.admin_list_businesses()
returns table (
  id uuid, name text, place_id text, status public.business_status, send_mode public.send_mode,
  trial_text_cap integer, daily_text_cap integer, owner_email text, texts_sent bigint, clicks bigint,
  last_activity timestamptz, gateway_online boolean, logo_url text,
  ai_replies_requested_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select b.id, b.name, b.place_id, b.status, b.send_mode, b.trial_text_cap, b.daily_text_cap,
         u.email as owner_email,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status in ('sent','clicked') and not m.mock) as texts_sent,
         (select count(*) from public.messages m
           where m.business_id = b.id and m.status = 'clicked') as clicks,
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
           where m.business_id = b.id) as last_activity,
         coalesce((select g.last_seen_at > now() - interval '5 minutes'
           from public.gateway_credentials g where g.business_id = b.id limit 1), false) as gateway_online,
         b.logo_url,
         (select i.created_at from public.ai_reply_interest i
           where i.business_id = b.id) as ai_replies_requested_at
    from public.businesses b
    left join auth.users u on u.id = b.owner_id
   order by b.name;
$$;

revoke execute on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to service_role;
