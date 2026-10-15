import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/supabase/env";

/**
 * Service-role Supabase client — **server only**.
 *
 * Used only by the Storage adapter (`lib/storage/supabase.ts`, SYS) — never
 * by a page or an action. The tenant boundary for files is
 * `lib/storage-paths.ts` + `lib/db/storage.ts` (docs/02 §10), exactly as
 * `lib/db/tenant-scope.ts` is the boundary for queries; every bucket is
 * private with no `storage.objects` policy (D-19 (a)).
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
