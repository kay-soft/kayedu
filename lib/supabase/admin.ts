import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/supabase/env";

/**
 * Service-role Supabase client — **server only**.
 *
 * Storage writes go through this rather than the user's session client: the
 * tenant boundary for files is `lib/storage-paths.ts` (layer 1, docs/02 §5),
 * exactly as `lib/db/tenant-scope.ts` is the boundary for queries. The storage
 * RLS policies are the backstop for anything that reaches Storage directly.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is deliberately not `NEXT_PUBLIC_*`, so it is
 * never substituted into a client bundle.
 */
let cached: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient {
  if (cached) return cached;

  const { url } = requireSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey || serviceRoleKey.startsWith("[")) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured — Storage is unavailable (see .env.example).",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

/** True when Storage can be used at all — screens degrade instead of crashing. */
export function storageConfigured(): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && key && !key.startsWith("["),
  );
}
