/**
 * The ONE phone normalizer (M18, CLAUDE.md rule 10, docs/00 §5.1 "UX & data
 * integrity"). Every place a phone is validated, compared for duplicate
 * matching, searched on, displayed or linked goes through this file — never a
 * second regex, never a second `.replace(...)` chain. Three implementations of
 * "is this the same number" would be three different answers to "is this the
 * same person."
 *
 * Deliberately free of runtime imports beyond `lib/digits.ts` (itself
 * import-free; no `@/` aliases, no Next.js, no Prisma) so `npm run check:people`'s single-normalizer gate can both import
 * the real function and grep the rest of the tree for anything that looks
 * like a second implementation.
 *
 * Stored form (U4): E.164 — `+20` and the 10-digit national number,
 * `+201012345678`. Every phone column holds only that (docs/01 "Phone numbers").
 */
import { toAsciiDigits } from "./digits.ts";

/** The stored form, as a Postgres/JS regex source (the U4 migration and `report:phones` use it). */
export const STORED_PHONE_PATTERN = "^\\+201[0125][0-9]{8}$";
/** The pre-U4 stored form `01XXXXXXXXX` — only `report:phones` still reads it. */
export const LEGACY_PHONE_PATTERN = "^01[0125][0-9]{8}$";
/**
 * What the U4 migration accepts once spaces, dashes and a leading `+` are
 * stripped: `01XXXXXXXXX` or `201XXXXXXXXX` (so an E.164 value passes too).
 * The migration SQL spells the same pattern; `report:phones` reads this one.
 */
export const MIGRATABLE_PHONE_PATTERN = "^(0|20)1[0125][0-9]{8}$";

/** The 10-digit national number (`1012345678`), or null when it is not an Egyptian mobile. */
function nationalNumber(input: string | null | undefined): string | null {
  const digits = toAsciiDigits(input ?? "").replace(/[^\d]/g, "");
  let national = digits;
  if (national.startsWith("0020")) national = national.slice(4);
  else if (national.startsWith("20") && national.length > 11) national = national.slice(2);
  if (national.startsWith("0")) national = national.slice(1);
  return /^1[0125]\d{8}$/.test(national) ? national : null;
}

/**
 * Egyptian mobile numbers to the one stored form, E.164 `+20XXXXXXXXXX`:
 * `01012345678`, `1012345678`, `+201012345678`, `00201012345678` and
 * `201012345678` — with any spaces, dashes, dots or brackets, in ASCII,
 * Arabic-Indic (٠-٩) or Persian (۰-۹) digits — are all the same person.
 * Returns null for anything that is not an Egyptian mobile (010/011/012/015).
 */
export function normalizePhone(input: string | null | undefined): string | null {
  const national = nationalNumber(input);
  return national ? `+20${national}` : null;
}

/**
 * The one display form: `+20 101 234 5678` (docs/04 §7) — always rendered LTR
 * (`<Ltr>` or a `dir="ltr"` input). A value that is not an Egyptian mobile
 * (none should be stored) is shown as it is, never hidden.
 */
export function formatPhone(value: string | null | undefined): string {
  const national = nationalNumber(value);
  if (!national) return (value ?? "").trim();
  return `+20 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** A `tel:` link — the E.164 form. Null when the value is not a mobile. */
export function phoneTelHref(value: string | null | undefined): string | null {
  const phone = normalizePhone(value);
  return phone ? `tel:${phone}` : null;
}

/** The number a WhatsApp link (`wa.me/<n>`) takes — the E.164 digits without `+`. */
export function phoneWhatsAppNumber(value: string | null | undefined): string | null {
  const phone = normalizePhone(value);
  return phone ? phone.slice(1) : null;
}

/** Digits (either script), spaces and the punctuation a phone is written with — and nothing else. */
const PHONE_SHAPED = /^[\d\s+\-().٠-٩۰-۹]+$/;

/** Whether typed text is written like a phone (`+20 100 123`, `0100-`, `٠١٠٠`) rather than a name. */
export function looksLikePhone(query: string): boolean {
  return PHONE_SHAPED.test(query.trim());
}

/**
 * The digits a partly-typed phone query is searched by (R6 — the searchable
 * pickers). A full number would go through `normalizePhone`; a *prefix or
 * tail* of one cannot, so this keeps whatever was typed, in ASCII digits, and
 * drops only the Egypt prefix a person adds out of habit: `+20 100…`,
 * `0020100…` and `20100…` all search as `100…`, exactly as `0100…` does.
 * Local numbers never start with 20, so the prefix is only dropped before a
 * mobile prefix (10/11/12/15). Empty when no digits were typed.
 *
 * The result is always a substring of the stored E.164 form whenever it is a
 * substring of the local `01…` form — `+20` is followed by the national
 * number, so `0101…` is inside `+20101…` — which is what lets the database
 * search match on the stored column directly.
 */
export function phoneSearchDigits(input: string): string {
  const digits = toAsciiDigits(input).replace(/[^\d]/g, "");
  return digits.replace(/^(?:00)?20(?=1[0125])/, "");
}

/**
 * Whether a stored phone matches a typed query, in any format (`+20…`, `0100…`,
 * `100…`, a tail, Arabic digits). The stored value is compared in its local
 * `01…` spelling, so a query never matches on the `+2` country code alone.
 */
export function phoneMatchesQuery(phone: string | null | undefined, query: string): boolean {
  const wanted = phoneSearchDigits(query);
  if (wanted === "" || !phone) return false;
  const national = nationalNumber(phone);
  const stored = national ? `0${national}` : toAsciiDigits(phone).replace(/[^\d]/g, "");
  return stored.includes(wanted);
}
