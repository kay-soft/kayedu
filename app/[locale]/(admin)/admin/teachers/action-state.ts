import type { PremiumStatus } from "@/lib/auth/premium";

/** One account as the Teachers page shows it (W6, D-W35) — status worked out on the server. */
export type PremiumAccountView = {
  userId: string;
  name: string;
  email: string | null;
  status: PremiumStatus;
};

export type PremiumActionState = {
  /** The account in view; `null` after a lookup that matched nobody. */
  account?: PremiumAccountView | null;
  /** A key under `AdminPremium.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "granted" | "extended" | "revoked";
};

export const IDLE_PREMIUM_ACTION_STATE: PremiumActionState = {};
