// Relative import on purpose: the gates exercise this outside Next.js.
import {
  ASSISTANT_CODE_ALPHABET,
  ASSISTANT_CODE_LENGTH,
  formatAssistantCodeForDisplay,
  normalizeAssistantCode,
} from "./assistant-catalog.ts";

/**
 * The workspace share code's shape (W10, D-W43) — pure and browser-safe, so
 * the join form, the reveal and the server share one rule. It **is** the
 * assistant code's shape (W7a): the parent code's 31 unambiguous symbols, 12
 * of them, case and separators ignored, Arabic digits folded — one
 * normalizer, not a second answer (CLAUDE.md rule 10). Hashing, issuing and
 * every write live in `lib/db/workspace-share-codes.ts`; nothing here stores a
 * code.
 */

export const WORKSPACE_SHARE_CODE_ALPHABET = ASSISTANT_CODE_ALPHABET;
export const WORKSPACE_SHARE_CODE_LENGTH = ASSISTANT_CODE_LENGTH;

/** How long an unused share code stays redeemable (D-W43 item 1). */
export const WORKSPACE_SHARE_CODE_DAYS = 7;

/** What a person typed, as a code (null when it is not one). */
export function normalizeWorkspaceShareCode(input: unknown): string | null {
  return normalizeAssistantCode(input);
}

/** XXXX-XXXX-XXXX, for display only. */
export function formatWorkspaceShareCodeForDisplay(code: string): string {
  return formatAssistantCodeForDisplay(code);
}
