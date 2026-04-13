-- Storage bucket for Pirate Ship XLSX imports.
-- The bucket is created via the Supabase client (not SQL), but RLS policies
-- must be declared here so they survive `supabase db reset`.

-- Allow authenticated users to upload files
CREATE POLICY "auth_insert_pirate_ship"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pirate-ship-imports');

-- Allow authenticated users to read their uploads
CREATE POLICY "auth_select_pirate_ship"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'pirate-ship-imports');
