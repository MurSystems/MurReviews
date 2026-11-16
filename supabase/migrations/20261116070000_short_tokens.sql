-- 8-character base62 tokens (shorter links; ~47 bits of entropy).
create or replace function public.new_token(p_length integer default 8)
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
           (get_byte(uuid_send(gen_random_uuid()), 0) % 62) + 1, 1),
    ''
  )
  from generate_series(1, p_length)
$$;
