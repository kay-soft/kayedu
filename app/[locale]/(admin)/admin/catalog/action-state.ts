export type CatalogAdminActionState = {
  /** Message key under `AdminCatalog.errors`. */
  error?: string;
  status?: "approved" | "rejected";
};

export const IDLE_CATALOG_ADMIN_ACTION_STATE: CatalogAdminActionState = {};
