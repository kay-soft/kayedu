import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { StorageProvider } from "@/lib/storage/provider";

/**
 * The Supabase Storage adapter (SYS) — the only module that calls the
 * Storage API. Server only: it uses the service-role client
 * (`lib/supabase/admin.ts`), and the four buckets are private with no
 * `storage.objects` policy (D-19 (a), docs/02 §10), so nothing but this
 * adapter can read or write an object.
 */
export const supabaseStorage: StorageProvider = {
  configured() {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && key && !key.startsWith("["));
  },

  async upload(bucket, key, body, contentType) {
    const { error } = await createSupabaseAdminClient()
      .storage.from(bucket)
      .upload(key, body, { contentType, upsert: true });
    return !error;
  },

  async signedUrl(bucket, key, ttlSeconds) {
    const { data, error } = await createSupabaseAdminClient().storage.from(bucket).createSignedUrl(key, ttlSeconds);
    return error ? null : (data?.signedUrl ?? null);
  },

  async download(bucket, key) {
    const { data, error } = await createSupabaseAdminClient().storage.from(bucket).download(key);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  },

  async remove(bucket, keys) {
    await createSupabaseAdminClient().storage.from(bucket).remove(keys);
  },

  async lastModified(bucket, key) {
    const slash = key.lastIndexOf("/");
    const folder = slash === -1 ? "" : key.slice(0, slash);
    const name = key.slice(slash + 1);
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(bucket)
      .list(folder, { search: name, limit: 1 });
    if (error || !data || data.length === 0) return null;
    const stamp = data[0].updated_at ?? data[0].created_at;
    return stamp ? new Date(stamp) : null;
  },
};
