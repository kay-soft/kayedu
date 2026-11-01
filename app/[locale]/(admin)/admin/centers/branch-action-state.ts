/**
 * The result shape of the platform admin's branch tools (U5) — kept out of
 * the `"use server"` file, which may export only async functions.
 */
export type BranchAdminState = {
  /** Message key under `AdminBranches.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "saved" | "previewed" | "paused" | "pauseEnded" | "restored";
  /** A pause's preview, or what a confirmed pause did. */
  impact?: { sessions: number; classes: number; bookings: number; keptWithPayments: number };
  /** "End pause now": what came back and what stayed cancelled. */
  restored?: number;
  keptConflicts?: number;
  keptOther?: number;
};

export const IDLE_BRANCH_ADMIN_STATE: BranchAdminState = {};
