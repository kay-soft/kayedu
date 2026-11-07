// Relative import on purpose: the gates exercise this outside Next.js.
import { toAsciiDigits } from "./digits.ts";
import { FAMILY_CODE_ALPHABET } from "./family-code.ts";

/**
 * Assistants (W7a, D-W16, D-W17, D-W36) — the fixed permission catalogue, the
 * three presets and the invite code's shape. Pure and browser-safe, so the
 * teacher's toggles, the redemption confirmation and the server share the one
 * rule. Hashing, issuing and every write live in `lib/db/assistants.ts`.
 *
 * **Deny-by-default.** A link may do exactly the permissions granted on it
 * (`AssistantPermissionGrant` rows); a name outside this catalogue is refused
 * before any write. In W7a nothing acts on a grant yet: an assistant has a
 * shell and a landing page that lists what was granted, and no centre data.
 */

/** The catalogue, in the order the teacher's page lists it. */
export const ASSISTANT_PERMISSIONS = [
  "assessments.review",
  "assessments.manage",
  "classes.view",
  "requests.manage",
  "checkin.workspace",
  "payments.workspace",
  "analytics.view",
  "students.phones",
] as const;

export type AssistantPermission = (typeof ASSISTANT_PERMISSIONS)[number];

export const ASSISTANT_PRESETS = ["GRADER", "CO_TEACHER", "FULL"] as const;
export type AssistantPresetName = (typeof ASSISTANT_PRESETS)[number];
/** What a link's grants read as: one of the presets, or "CUSTOM" (never stored). */
export type AssistantPresetView = AssistantPresetName | "CUSTOM";

/** The preset a new invite starts on (D-W17). */
export const DEFAULT_ASSISTANT_PRESET: AssistantPresetName = "CO_TEACHER";

const GRADER: readonly AssistantPermission[] = ["assessments.review"];
const CO_TEACHER: readonly AssistantPermission[] = [
  ...GRADER,
  "assessments.manage",
  "classes.view",
  "requests.manage",
  "checkin.workspace",
  "payments.workspace",
];
const FULL: readonly AssistantPermission[] = [...CO_TEACHER, "analytics.view"];

/** Each preset's grants. `students.phones` is in none of them: only a toggle grants it. */
export const PRESET_PERMISSIONS: Readonly<Record<AssistantPresetName, readonly AssistantPermission[]>> = {
  GRADER,
  CO_TEACHER,
  FULL,
};

export function isAssistantPermission(value: unknown): value is AssistantPermission {
  return typeof value === "string" && (ASSISTANT_PERMISSIONS as readonly string[]).includes(value);
}

export function isAssistantPreset(value: unknown): value is AssistantPresetName {
  return typeof value === "string" && (ASSISTANT_PRESETS as readonly string[]).includes(value);
}

/** A set of grants in catalogue order, duplicates dropped (unknown names are the caller's refusal). */
export function sortPermissions(permissions: readonly string[]): AssistantPermission[] {
  const held = new Set(permissions);
  return ASSISTANT_PERMISSIONS.filter((permission) => held.has(permission));
}

/** The preset these grants are exactly, else "CUSTOM". */
export function detectPreset(permissions: readonly string[]): AssistantPresetView {
  const held = new Set(permissions);
  for (const preset of ASSISTANT_PRESETS) {
    const wanted = PRESET_PERMISSIONS[preset];
    if (wanted.length === held.size && wanted.every((permission) => held.has(permission))) return preset;
  }
  return "CUSTOM";
}

// ── The invite code ──────────────────────────────────────────────────────

export const ASSISTANT_LIMITS = {
  /** Active links + pending invites, per teacher (D-W16). */
  slotsPerTeacher: 5,
  /** How long an unused invite stays redeemable. */
  inviteDays: 7,
} as const;

/** The parent code's 31 unambiguous symbols (no 0 O 1 I L) — the one alphabet. */
export const ASSISTANT_CODE_ALPHABET = FAMILY_CODE_ALPHABET;
export const ASSISTANT_CODE_LENGTH = 12;

/**
 * What a person typed, as a code: case and separators ignored, Arabic digits
 * read as Latin ones (`lib/digits.ts`). Anything outside the alphabet or of the
 * wrong length is not a code (null).
 */
export function normalizeAssistantCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const compact = toAsciiDigits(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== ASSISTANT_CODE_LENGTH) return null;
  for (const char of compact) if (!ASSISTANT_CODE_ALPHABET.includes(char)) return null;
  return compact;
}

/** XXXX-XXXX-XXXX, for display only (a non-code is shown as typed). */
export function formatAssistantCodeForDisplay(code: string): string {
  const normalized = normalizeAssistantCode(code);
  return normalized ? `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}` : code;
}
