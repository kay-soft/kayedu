/**
 * The one registry of what the `check:*` gates create (centres by slug, users
 * by email, global catalog rows by name).
 *
 * Every gate builds its fixtures from a stem of the form `<gate>-check` and
 * deletes them again in a `finally`. A gate that is still running — or one that
 * was killed before its cleanup — leaves rows of that shape behind. `seed:verify`
 * uses this list to (a) leave them out of the seed-world checks (sections 1, 3,
 * 4 and 7) and (b) report them in its own "Gate fixtures left behind" section.
 *
 * `check:gate-fixtures` scans `scripts/*-check.ts` and fails on a fixture stem
 * that is not registered here, so a new gate cannot create rows `seed:verify`
 * would then mistake for seed-world data.
 */

/** Slug / email stems (lower-case). A fixture slug or email starts with one. */
export const GATE_FIXTURE_STEMS = [
  "account-check",
  "admin-check",
  "analytics-check",
  "approvals-check",
  "assessments-check",
  "branches-check",
  "card-layout-check",
  "catalog-check",
  "class-creation-check",
  "class-periods-check",
  "classes-check",
  "config-check",
  "enrollment-check",
  "isolation-check",
  "notifications-check",
  "one-off-sessions-check",
  "parent-check",
  "payment-methods-check",
  "payments-check",
  "people-check",
  "permissions-check",
  "ratings-check",
  "reception-check",
  "rooms-check",
  "rush-performance-check",
  "security-check",
  "session-lifecycle-check",
  "settlements-check",
  "student-portal-check",
  "teacher-portal-check",
  "visibility-check",
] as const;

/**
 * The one title prefix of every assessment the e2e suite creates (W3a). Not a
 * gate fixture: `scripts/lib/e2e-assessments.ts` deletes by it.
 */
export const E2E_ASSESSMENT_PREFIX = "E2E-assessment-";

/** Other email prefixes a gate creates users under (not of the `<gate>-check` shape). */
export const GATE_FIXTURE_EXTRA_EMAIL_PREFIXES = ["isolation-family-"] as const;

/**
 * Literals that contain `-check` but are not fixtures (an idempotency token, a
 * word in prose). Anything else matching the shape must be a registered stem.
 */
export const NOT_A_FIXTURE_LITERALS = ["re-check", "spot-check", "session-check", "re-check-in"] as const;

/** A fixture older than this has outlived any gate run: it was left behind. */
export const FIXTURE_STALE_AFTER_MS = 30 * 60_000;

export const gateSlugPrefixes = (): string[] => [...GATE_FIXTURE_STEMS];
export const gateEmailPrefixes = (): string[] => [...GATE_FIXTURE_STEMS, ...GATE_FIXTURE_EXTRA_EMAIL_PREFIXES];

/**
 * The email prefixes every gate EXCEPT `gate` (a stem such as
 * `class-periods-check`) creates users under. `gate-db`'s orphan sweep uses it
 * to leave another gate's fixtures alone: two gates overlapping on one database
 * must never sweep each other's (still relation-less) actor users.
 */
export function otherGateEmailPrefixes(gate: string): string[] {
  const own = gate.toLowerCase();
  return gateEmailPrefixes().filter((prefix) => {
    if (prefix === own) return false;
    // `isolation-family-` is isolation-check's, though it is not of the `<gate>-check` shape.
    return !(own === "isolation-check" && (GATE_FIXTURE_EXTRA_EMAIL_PREFIXES as readonly string[]).includes(prefix));
  });
}

export function isGateFixtureSlug(slug: string): boolean {
  const lower = slug.toLowerCase();
  return GATE_FIXTURE_STEMS.some((stem) => lower.startsWith(stem));
}

export function isGateFixtureEmail(email: string | null | undefined): boolean {
  const lower = (email ?? "").toLowerCase();
  return gateEmailPrefixes().some((prefix) => lower.startsWith(prefix));
}

export type FixtureVerdict = "WARN" | "FAIL";

/**
 * How `seed:verify` judges a leftover fixture: younger than the stale limit it
 * may belong to a gate that is still running (WARN); older, it was left behind
 * (FAIL). `strictClean` fails any of them (the run that ends `check:all`).
 */
export function fixtureVerdict(ageMs: number, strictClean: boolean): FixtureVerdict {
  return strictClean || ageMs >= FIXTURE_STALE_AFTER_MS ? "FAIL" : "WARN";
}
