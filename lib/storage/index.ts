import type { StorageProvider } from "@/lib/storage/provider";
import { supabaseStorage } from "@/lib/storage/supabase";

/**
 * The one storage entry point (SYS, docs/02 §10). Callers use the
 * tenant-scoped API in `lib/db/storage.ts`, which reaches the provider only
 * through `storage()`; to change providers, add an adapter beside
 * `supabase.ts` and return it here. Nothing else imports an adapter.
 */
export function storage(): StorageProvider {
  return supabaseStorage;
}

/** True when file storage can be used at all — screens degrade instead of crashing. */
export function storageConfigured(): boolean {
  return storage().configured();
}

export type { StorageProvider } from "@/lib/storage/provider";
