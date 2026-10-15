/**
 * The ONE phone normalizer (M18, CLAUDE.md rule 10, docs/00 §5.1 "UX & data
 * integrity"). Every place a phone is validated, compared for duplicate
 * matching, or searched on goes through `normalizePhone` — never a second
 * regex, never a second `.replace(...)` chain. Three implementations of "is
 * this the same number" would be three different answers to "is this the
 * same person."
 *
 * Deliberately free of runtime imports beyond `lib/digits.ts` (itself
 * import-free; no `@/` aliases, no Next.js, no Prisma) so `npm run check:people`'s single-normalizer gate can both import
 * the real function and grep the rest of the tree for anything that looks
 * like a second implementation.
 */
import { toAsciiDigits } from "./digits.ts";

/**
 * Egyptian mobile numbers, 11-15 raw digits, to one canonical `01XXXXXXXXX`:
 * `+201012345678`, `00201012345678`, `201012345678` and `01012345678` are all
 * the same person. Returns null for anything that is not a valid Egyptian
 * mobile once normalized.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/[^\d]/g, "");
  if (digits.length < 9 || digits.length > 15) return null;

  let local = digits;
  if (local.startsWith("0020")) local = local.slice(4);
  else if (local.startsWith("20") && local.length > 11) local = local.slice(2);
  if (!local.startsWith("0")) local = `0${local}`;

  return /^01[0125]\d{8}$/.test(local) ? local : null;
}

/**
 * The digits a partly-typed phone query is searched by (R6 — the searchable
 * pickers). A full number would go through `normalizePhone`; a *prefix or
 * tail* of one cannot, so this keeps whatever was typed, in ASCII digits, and
 * drops only the Egypt prefix a person adds out of habit: `+20 100…`,
 * `0020100…` and `20100…` all search as `100…`, exactly as `0100…` does.
 * Local numbers never start with 20, so the prefix is only dropped before a
 * mobile prefix (10/11/12/15). Empty when no digits were typed.
 */
export function phoneSearchDigits(input: string): string {
  const digits = toAsciiDigits(input).replace(/[^\d]/g, "");
  return digits.replace(/^(?:00)?20(?=1[0125])/, "");
}

/**
 * Whether a stored phone matches a typed query, in any format (`+20…`, `0100…`,
 * `100…`, a tail, Arabic digits). The stored value is the canonical form
 * `normalizePhone` produced; a legacy un-normalized value is normalized here
 * first so both sides are compared in the one canonical shape.
 */
export function phoneMatchesQuery(phone: string | null | undefined, query: string): boolean {
  const wanted = phoneSearchDigits(query);
  if (wanted === "" || !phone) return false;
  const stored = normalizePhone(phone) ?? phone.replace(/[^\d]/g, "");
  return stored.includes(wanted);
}

