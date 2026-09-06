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
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted";
};

export const IDLE_ACTION_STATE: ActionState = {};
