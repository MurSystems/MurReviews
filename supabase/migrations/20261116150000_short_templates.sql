-- Shorten the default templates so sms_provider (two links: review + opt-out)
-- fits one segment for a normal name, two for a long business name.
alter table public.businesses
  alter column message_template set default 'Hi {first_name}, thanks for choosing {business}. Please review us: {review_link} {opt_out}';
alter table public.businesses
  alter column reminder_template set default 'Hi {first_name}, a gentle nudge to review {business}: {review_link} {opt_out}';

update public.businesses
   set message_template = 'Hi {first_name}, thanks for choosing {business}. Please review us: {review_link} {opt_out}',
       reminder_template = 'Hi {first_name}, a gentle nudge to review {business}: {review_link} {opt_out}';
