-- ============================================================================
-- Demo Cafe: remove the seeded fake activity.
--
-- The seed used to insert five messages, a reply, two review snapshots, an
-- opt-out and an opt-out link for the Demo Cafe business. That invented data
-- showed up as real stats (texts sent, clicks, reviews gained), so it is
-- removed here and no longer seeded. Customers stay: they are fictitious
-- numbers and harmless.
-- ============================================================================

delete from public.messages
 where business_id = '22222222-2222-2222-2222-222222222222'
   and id in (
     '44444444-4444-4444-4444-000000000001',
     '44444444-4444-4444-4444-000000000002',
     '44444444-4444-4444-4444-000000000003',
     '44444444-4444-4444-4444-000000000004',
     '44444444-4444-4444-4444-000000000005'
   );

delete from public.replies
 where business_id = '22222222-2222-2222-2222-222222222222'
   and from_mobile = '+61491570006'
   and body = 'Thanks, will do!';

delete from public.review_snapshots
 where business_id = '22222222-2222-2222-2222-222222222222';

delete from public.opt_outs
 where business_id = '22222222-2222-2222-2222-222222222222'
   and mobile = '+61491570158'
   and source = 'link';

delete from public.opt_out_links
 where business_id = '22222222-2222-2222-2222-222222222222'
   and token = 'demo-opt-1';
