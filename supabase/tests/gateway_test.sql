-- ============================================================================
-- Android gateway: default send mode, owner credential saving, status,
-- service-role config and the opt-out link in android_gateway texts.
-- ============================================================================

create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'owner-b@test.local');

-- no send_mode on purpose: the column default must be android_gateway
insert into public.businesses (id, name, place_id, status, owner_id) values
  ('00000000-0000-0000-0000-0000000000e3', 'Default Mode Cafe', 'place-default', 'active', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000e4', 'Gateway Cafe', 'place-gateway', 'active', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000e5', 'Other Cafe', 'place-other', 'active', '00000000-0000-0000-0000-0000000000e2'),
  ('00000000-0000-0000-0000-0000000000e6', 'Demo Mode Cafe', 'place-demo', 'active', '00000000-0000-0000-0000-0000000000e1');
update public.businesses set send_mode = 'android_gateway' where id = '00000000-0000-0000-0000-0000000000e4';
update public.businesses set send_mode = 'demo' where id = '00000000-0000-0000-0000-0000000000e6';

select is(
  (select send_mode from public.businesses where id = '00000000-0000-0000-0000-0000000000e3'),
  'android_gateway'::public.send_mode,
  'new businesses default to android_gateway'
);

-- ---------- owner saves their own phone ----------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';

select lives_ok(
  $$select public.save_gateway_credentials('00000000-0000-0000-0000-0000000000e4', 'gateway-user', 'gateway-pass', 'dev-1')$$,
  'an owner can save credentials for their own business'
);

select is(
  (select configured from public.get_gateway_status('00000000-0000-0000-0000-0000000000e4')),
  true,
  'status reports configured after saving'
);

select is(
  (select connected from public.get_gateway_status('00000000-0000-0000-0000-0000000000e4')),
  false,
  'status is offline before a heartbeat'
);

-- service role heartbeat, then check again as the owner
reset role;
select public.touch_gateway('dev-1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
select is(
  (select connected from public.get_gateway_status('00000000-0000-0000-0000-0000000000e4')),
  true,
  'a recent heartbeat makes the gateway connected'
);

-- ---------- the config is available to the sender ----------
reset role;
select is(
  (select username from public.gateway_send_config('00000000-0000-0000-0000-0000000000e4')),
  'gateway-user',
  'service role can read the gateway config'
);

-- ---------- another owner is locked out ----------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e2';
select throws_ok(
  $$select public.save_gateway_credentials('00000000-0000-0000-0000-0000000000e4', 'x', 'y', null)$$,
  42501
);
select throws_ok(
  $$select * from public.get_gateway_status('00000000-0000-0000-0000-0000000000e4')$$,
  42501
);

-- ---------- owner-scoped config for the test-send route ----------
reset role;
select is(
  (select count(*) from public.owner_gateway_config('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000e1')),
  1::bigint,
  'owner_gateway_config returns the config to its owner'
);
select is(
  (select count(*) from public.owner_gateway_config('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000e2')),
  0::bigint,
  'owner_gateway_config refuses a different owner'
);

-- ---------- opt-out link in android_gateway, STOP text in demo ----------
insert into public.customers (id, business_id, first_name, mobile) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e4', 'Mia', '+61491570006'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e6', 'Noah', '+61491570156');

insert into public.opt_out_links (token, business_id, mobile) values
  ('opt-tok-1', '00000000-0000-0000-0000-0000000000e4', '+61491570006');

insert into public.messages (id, business_id, customer_id, status, token, scheduled_at) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000f1', 'sending', 'gtok1', now()),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000f2', 'sending', 'gtok2', now());

select ok(
  (select rendered_text like '%/o/opt-tok-1%'
     from public.prepare_send('00000000-0000-0000-0000-0000000000f3', 'https://m.test')),
  'android_gateway texts include the tappable opt-out link'
);
select ok(
  (select rendered_text like '%Reply STOP%'
     from public.prepare_send('00000000-0000-0000-0000-0000000000f4', 'https://m.test')),
  'demo texts still use the Reply STOP wording'
);

select * from finish();
