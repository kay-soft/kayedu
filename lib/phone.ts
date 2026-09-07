/**
 * The ONE phone normalizer (M18, CLAUDE.md rule 10, docs/00 §5.1 "UX & data
 * integrity"). Every place a phone is validated, compared for duplicate
 * matching, or searched on goes through `normalizePhone` — never a second
 * regex, never a second `.replace(...)` chain. Three implementations of "is
 * this the same number" would be three different answers to "is this the
 * same person."
 *
 * Deliberately free of runtime imports (no `@/` aliases, no Next.js, no
 * Prisma) so `npm run check:people`'s single-normalizer gate can both import
 * the real function and grep the rest of the tree for anything that looks
 * like a second implementation.
 */

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

/** Shape guard only — no normalization. Used to decide whether a raw search
 * token even looks like a phone before bothering to normalize it. */
export function looksLikePhone(input: string): boolean {
  return /\d{4,}/.test(input.replace(/[^\d]/g, ""));
}
