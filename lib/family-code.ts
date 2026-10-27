// Relative import on purpose: the gates exercise this outside Next.js.
import { toAsciiDigits } from "./digits.ts";

/**
 * The parent code's shape (F3) — pure and browser-safe, so the join form and
 * the code dialogs share the server's one rule. Hashing and issuing live in
 * `lib/db/parents.ts`; nothing here ever stores a code.
 */

/** 31 symbols with nothing to misread: no 0 O 1 I L. */
export const FAMILY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const FAMILY_CODE_LENGTH = 8;

/**
 * What a person typed, as a code: case and separators ignored (XXXX-XXXX,
 * spaces), Arabic digits read as their Latin ones (`lib/digits.ts`, the one
 * folding rule). Anything outside the alphabet or of the wrong length is not
 * a code (null).
 */
export function normalizeFamilyCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const compact = toAsciiDigits(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== FAMILY_CODE_LENGTH) return null;
  for (const char of compact) if (!FAMILY_CODE_ALPHABET.includes(char)) return null;
  return compact;
}

/** XXXX-XXXX, for display only (a non-code is shown as typed). */
export function formatFamilyCodeForDisplay(code: string): string {
  const normalized = normalizeFamilyCode(code);
  return normalized ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : code;
}
