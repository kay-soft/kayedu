import type { ZodError } from "zod";

/**
 * Zod issues → { field: messageKey }. Messages in our schemas are i18n keys
 * under the `Auth.errors` namespace, not user-facing copy.
 */
export function fieldErrorsFrom(error: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in errors)) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

/**
 * The state every settings Server Action returns (docs/02 §7).
 * `error` and the values in `fieldErrors` are i18n keys, not copy.
 */
export type ActionState = {
  error?: string;
  /** ICU values for `error` — e.g. how many classes still use a room (R3). */
  errorValues?: Record<string, number>;
  fieldErrors?: Record<string, string>;
  /**
   * "deactivated": a delete that could not hard-delete because history
   * references the row, so it deactivated instead (R1 payment methods).
   * "voided": an expense voided with a reason (D-24) — never deleted.
   */
  status?: "created" | "saved" | "deleted" | "deactivated" | "voided";
};

export const IDLE_ACTION_STATE: ActionState = {};
