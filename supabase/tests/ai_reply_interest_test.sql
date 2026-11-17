-- ============================================================================
-- AI review replies interest: owner inserts once, cannot write another
-- business, cannot update/delete; admins see the request in the listing.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner@ai.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'other@ai.local'),
  ('00000000-0000-0000-0000-0000000000e3', 'admin@ai.local');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000e3';

insert into public.businesses (id, name, place_id, status, send_mode, owner_id) values
  ('00000000-0000-0000-0000-0000000000f1', 'AI Cafe', 'place-ai', 'active', 'log_only', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000f2', 'Other Cafe', 'place-other', 'active', 'log_only', '00000000-0000-0000-0000-0000000000e2');

-- Owner registers interest once.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';

insert into public.ai_reply_interest (business_id)
values ('00000000-0000-0000-0000-0000000000f1');
select is(
  (select count(*)::int from public.ai_reply_interest),
  1,
  'owner can register interest for their own business'
);

select throws_ok(
  $$insert into public.ai_reply_interest (business_id) values ('00000000-0000-0000-0000-0000000000f1')$$,
  23505,
  null,
  'a business can only register interest once'
);

select throws_ok(
  $$insert into public.ai_reply_interest (business_id) values ('00000000-0000-0000-0000-0000000000f2')$$,
  42501,
  null,
  'owner cannot register interest for another business'
);

select throws_ok(
  $$update public.ai_reply_interest set created_at = now() where business_id = '00000000-0000-0000-0000-0000000000f1'$$,
  42501,
  null,
  'interest records cannot be changed'
);

select throws_ok(
  $$delete from public.ai_reply_interest where business_id = '00000000-0000-0000-0000-0000000000f1'$$,
  42501,
  null,
  'interest records cannot be deleted'
);

reset role;

select ok(
  (select ai_replies_requested_at is not null
     from public.admin_list_businesses()
    where id = '00000000-0000-0000-0000-0000000000f1'),
  'admin listing shows the interest request'
);

select ok(
  (select ai_replies_requested_at is null
     from public.admin_list_businesses()
    where id = '00000000-0000-0000-0000-0000000000f2'),
  'admin listing leaves other businesses unmarked'
);

select * from finish();
