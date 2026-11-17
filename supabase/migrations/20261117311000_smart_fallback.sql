-- ============================================================================
-- Smarter 160-character fallback.
--
-- The new default template plus a real review link is longer than one segment
-- on the current domain, so the old rule (drop the first name whenever the
-- named text is over 160) turned every greeting into "Hi from ...".
--
-- Instead, try four renderings and pick the one with the fewest segments,
-- preferring the fullest text on a tie: named + sender, named, sender only,
-- then neither. A long first name still drops to the nameless text (fewer
-- segments), while a normal text keeps "Hi Mia, it's Azlaan from ...".
-- ============================================================================

create or replace function public.render_send_message(
  p_template text,
  p_first_name text,
  p_business text,
  p_review_link text,
  p_opt_out text,
  p_sender_name text default null
)
returns text
language sql
stable
as $$
  with candidates as (
    select 1 as preference,
           public.render_message_text(
             p_template, p_first_name, p_business, p_review_link, p_opt_out, p_sender_name) as txt
    union all
    select 2,
           public.render_message_text(
             p_template, p_first_name, p_business, p_review_link, p_opt_out, null)
    union all
    select 3,
           public.render_message_text(
             p_template, '', p_business, p_review_link, p_opt_out, p_sender_name)
    union all
    select 4,
           public.render_message_text(
             p_template, '', p_business, p_review_link, p_opt_out, null)
  )
  select txt
    from candidates
   order by public.gsm7_segments(public.gsm7_length(txt)), preference
   limit 1
$$;
