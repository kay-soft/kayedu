export type AdminActionState = {
  /** Message key under `AdminCenters.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  /** `branchAdded` (F1): a branch joined an existing organization — no invitation to share. */
  status?: "created" | "saved" | "branchAdded";
  /** Set on a successful create — the founding owner's invite link. */
  invitationToken?: string;
};

export const IDLE_ADMIN_ACTION_STATE: AdminActionState = {};
