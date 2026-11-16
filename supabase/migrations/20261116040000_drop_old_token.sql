-- Remove the old parameter-less new_token() so the base62 new_token(integer)
-- is the unambiguous default (new_token() now resolves via its DEFAULT 12).
drop function if exists public.new_token();
