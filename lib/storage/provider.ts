import type { StorageBucket } from "@/lib/storage-paths";

/**
 * The storage seam (SYS, docs/02 §10) — everything the app asks of a file
 * store, and nothing provider-specific. `lib/storage/index.ts` picks the one
 * adapter; `lib/db/storage.ts` (the tenant-scoped API every caller uses)
 * builds keys, re-checks them against the centre and types uploads by their
 * bytes **before** anything reaches a provider. Swapping providers means
 * writing one adapter that satisfies this type — no caller changes.
 *
 * Every bucket is private. A file reaches a browser only through
 * `signedUrl` (short-lived): student photos are minors' data.
 */
export type StorageProvider = {
  /** Whether the provider is configured at all — screens degrade instead of crashing. */
  configured(): boolean;
  /** Writes (or replaces) one object. `false` when the provider refused. */
  upload(bucket: StorageBucket, key: string, body: Uint8Array | Blob, contentType: string): Promise<boolean>;
  /** A short-lived URL a browser may fetch the object from, or null. */
  signedUrl(bucket: StorageBucket, key: string, ttlSeconds: number): Promise<string | null>;
  /** The object's bytes, or null when it is missing or unreadable. */
  download(bucket: StorageBucket, key: string): Promise<Uint8Array | null>;
  /** Deletes the objects; a missing one is not an error. */
  remove(bucket: StorageBucket, keys: string[]): Promise<void>;
  /** When the object was last written, or null when it does not exist. */
  lastModified(bucket: StorageBucket, key: string): Promise<Date | null>;
};
