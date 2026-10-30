/**
 * The password policy (U1) — the one place its numbers and its rules live.
 * Applies where a password is **set** (sign-up, Account → change password),
 * never to sign-in, so an account made under an older, looser rule still logs
 * in. The zod schema (`lib/validation/auth.ts`) and the live checklist
 * (`components/shared/new-password-field.tsx`) both read this module, so the
 * client and the server cannot disagree.
 *
 * Supabase Auth enforces its own minimum too (Authentication → Policies →
 * "Minimum password length"); it should be set to `PASSWORD_MIN_LENGTH` on
 * every project so a direct API call cannot go below the app's rule
 * (docs/02-architecture.md §3).
 */
export const PASSWORD_MIN_LENGTH = 8;

/** bcrypt reads at most 72 bytes (SEC-74), so the field is bounded there. */
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordCheck = "length" | "letter" | "digit";

export const PASSWORD_CHECKS: readonly PasswordCheck[] = ["length", "letter", "digit"];

/** Which rules a candidate password meets. */
export function passwordChecks(value: string): Record<PasswordCheck, boolean> {
  return {
    length: value.length >= PASSWORD_MIN_LENGTH,
    letter: /\p{L}/u.test(value),
    digit: /\p{Nd}/u.test(value),
  };
}
