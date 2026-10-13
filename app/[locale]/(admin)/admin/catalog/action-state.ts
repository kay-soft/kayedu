import type { CatalogUsage } from "@/lib/db/catalog-admin";

export type CatalogAdminActionState = {
  /** Message key under `AdminCatalog.errors`. */
  error?: string;
  /** Field name → `AdminCatalog.errors` key. */
  fieldErrors?: Record<string, string>;
  /** Set with `error: "inUse"` — what still references the entry, so the blocker can name the counts. */
  usage?: CatalogUsage;
  status?: "created" | "saved" | "deactivated" | "reactivated" | "deleted";
};

export const IDLE_CATALOG_ADMIN_ACTION_STATE: CatalogAdminActionState = {};
