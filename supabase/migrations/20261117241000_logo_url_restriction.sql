-- ============================================================================
-- Keep logo_url inside the business's own folder in the public logos bucket.
--
-- Storage RLS already stops an owner uploading into another business's folder,
-- but businesses.logo_url could still be set to any URL (or another business's
-- file). This trigger makes the database enforce the same rule: a non-null
-- logo_url must be a Supabase public-object URL under logos/<business id>/.
-- The optional query string (the app adds ?v=<timestamp>) is allowed.
-- ============================================================================

create or replace function public.enforce_logo_url_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  expected text;
begin
  if new.logo_url is null then
    return new;
  end if;

  expected :=
    '^https://[^/]+/storage/v1/object/public/logos/'
    || new.id::text
    || '/[^?#]+(\?.*)?$';

  if new.logo_url !~ expected then
    raise exception
      'logo_url must point to this business''s own file in the logos bucket'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists businesses_logo_url_owner on public.businesses;

create trigger businesses_logo_url_owner
  before insert or update of logo_url on public.businesses
  for each row execute function public.enforce_logo_url_owner();
