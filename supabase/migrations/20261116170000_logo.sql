-- ============================================================================
-- Business identity: logo URL + a public "logos" storage bucket with RLS so a
-- business can only write its own logo.
-- ============================================================================

alter table public.businesses add column logo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 1048576, '{image/png,image/jpeg,image/webp}')
on conflict (id) do nothing;

-- Owner can create/replace/delete their own business logo (folder = business id).
create policy "logos_owner_write" on storage.objects
for all using (
  bucket_id = 'logos'
  and (storage.foldername(name))[1]::text = (select id::text from public.businesses where owner_id = auth.uid())
) with check (
  bucket_id = 'logos'
  and (storage.foldername(name))[1]::text = (select id::text from public.businesses where owner_id = auth.uid())
);

-- Anyone can read logos (public bucket).
create policy "logos_public_read" on storage.objects
for select using (bucket_id = 'logos');
