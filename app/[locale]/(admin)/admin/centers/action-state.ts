export type AdminActionState = {
  /** Message key under `AdminCenters.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved";
  /** Set on a successful create — the founding owner's invite link. */
  invitationToken?: string;
};

export const IDLE_ADMIN_ACTION_STATE: AdminActionState = {};
