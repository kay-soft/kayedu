/**
 * A08-1 — the receptionist phone-lookup rate limit (spec §5.1, the control
 * that keeps "phone -> person" from being an enumeration API) is bypassable
 * and is per-instance only, so a staff member at centre A can resolve
 * phone numbers to the names of people (minors included) known only to
 * centre B, at unbounded volume, with no audit trail.
 *
 * What is IMPORTED (real code):
 *   - `resolveContact` / `describeMatch` from lib/db/identity.ts — the exact
 *     pair `lookupPersonByPhoneAction` (students/actions.ts:157-178) and the
 *     `matchFound` branch of `createStudentAction` (students/actions.ts:211-218)
 *     run.
 *   - `checkRateLimit` from lib/rate-limit.ts, loaded as two separate module
 *     instances (`?instance=` query) to stand in for two Vercel instances.
 * What is REPLICATED / statically checked: the Server Actions themselves
 * import via `@/` and `next/*`, so they cannot be loaded here. The script
 * instead reads their source and asserts that the call to `resolveContact`
 * in createStudentAction, addNewAttendeeAction (sessions/actions.ts) and
 * addTeacherMembership (lib/db/teacher-membership.ts:89, called by createTeacherAction via createTeacherMembership) is NOT preceded by
 * any `checkRateLimit` call in the same function — i.e. the same disclosure
 * is reachable with no limiter at all.
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-11.ts
 * Fixtures: centres with slug prefix `secrepro-a08-`, users with email prefix
 * `secrepro-a08-` (@kayedu.test). Pre-cleaned and deleted in finally.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { describeMatch, resolveContact } from "../../lib/db/identity.ts";

const prisma = new PrismaClient();
const SLUG_PREFIX = "secrepro-a08-";
const EMAIL_PREFIX = "secrepro-a08-";

async function cleanup(): Promise<void> {
  const centers = await prisma.center.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, organizationId: true },
  });
  const centerIds = centers.map((c) => c.id);
  const orgIds = [...new Set(centers.map((c) => c.organizationId))];
  if (centerIds.length) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: centerIds } } });
    await prisma.center.deleteMany({ where: { id: { in: centerIds } } });
  }
  if (orgIds.length) {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds }, centers: { none: {} } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

/** Body of `export async function <name>(` up to the next top-level export. */
function functionBody(path: string, name: string): string {
  const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = src.indexOf("\nexport ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

async function unusedPhone(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const phone = `0109${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const [u, s, m] = await Promise.all([
      prisma.user.count({ where: { phone } }),
      prisma.studentProfile.count({ where: { phone } }),
      prisma.membership.count({ where: { phone } }),
    ]);
    if (u + s + m === 0) return phone;
  }
  throw new Error("could not find an unused phone");
}

async function main() {
  await cleanup();
  let ok = true;

  // ── 1. Two "instances" of the in-process limiter ──────────────────────────
  // A query string makes Node load a second, independent copy of the module —
  // the same thing a second serverless instance is. Built at runtime so tsc
  // doesn't try to resolve the specifier.
  type RateLimitModule = typeof import("../../lib/rate-limit.ts");
  const rateLimitPath = "../../lib/rate-limit.ts";
  const instA = (await import(`${rateLimitPath}?instance=a`)) as RateLimitModule;
  const instB = (await import(`${rateLimitPath}?instance=b`)) as RateLimitModule;
  const key = "people.phoneLookup:attacker";
  let allowed = 0;
  for (let i = 0; i < 25; i++) if (instA.checkRateLimit(key, 20, 60_000)) allowed++;
  for (let i = 0; i < 25; i++) if (instB.checkRateLimit(key, 20, 60_000)) allowed++;
  console.log(`limiter: 50 calls across 2 instances in <1 min -> ${allowed} allowed (single-instance cap is 20)`);
  if (allowed <= 20) ok = false;

  // ── 2. The create paths reach resolveContact with no limiter ──────────────
  const paths: [string, string][] = [
    ["app/[locale]/(center)/students/actions.ts", "createStudentAction"],
    ["app/[locale]/(center)/sessions/actions.ts", "addNewAttendeeAction"],
    ["lib/db/teacher-membership.ts", "addTeacherMembership"],
    ["app/[locale]/(center)/students/actions.ts", "lookupPersonByPhoneAction"],
  ];
  for (const [path, name] of paths) {
    const body = functionBody(path, name);
    const resolves = body.includes("resolveContact(");
    const limited = body.includes("checkRateLimit(");
    console.log(`${name}: reaches resolveContact=${resolves} rate-limited=${limited}`);
    if (name !== "lookupPersonByPhoneAction" && (!resolves || limited)) ok = false;
  }

  // ── 3. Cross-centre phone -> name disclosure, at volume ──────────────────
  const victimPhone = await unusedPhone();
  const mkCenter = (tag: string) =>
    prisma.center.create({
      data: {
        slug: `${SLUG_PREFIX}${tag}`,
        name: `SecRepro A08 ${tag}`,
        organization: { create: { name: `SecRepro A08 ${tag}` } },
      },
    });
  const centerA = await mkCenter("attacker");
  const centerB = await mkCenter("victim");
  // A minor known ONLY to centre B: the phone sits on B's local record, not
  // on the global User (contact details are centre-local, docs/01 §6).
  const minor = await prisma.user.create({
    data: { firstName: "Victim", lastName: "Minor-A08", email: `${EMAIL_PREFIX}minor@kayedu.test`, locale: "en" },
  });
  await prisma.studentProfile.create({
    data: {
      centerId: centerB.id,
      userId: minor.id,
      studentCode: "A08001",
      firstName: "Victim",
      lastName: "Minor-A08",
      phone: victimPhone,
    },
  });

  const ROUNDS = 100;
  let disclosed = 0;
  let name = "";
  for (let i = 0; i < ROUNDS; i++) {
    // Exactly createStudentAction's pre-write branch, as centre A's staff.
    const resolution = await resolveContact({ email: null, phone: victimPhone });
    if (resolution.kind !== "matched") continue;
    const match = await describeMatch(centerA.id, resolution.match, { email: null, phone: victimPhone });
    if (match.name.includes("Minor-A08")) {
      disclosed++;
      name = match.name;
    }
  }
  const writes = await prisma.studentProfile.count({ where: { centerId: centerA.id } });
  const audits = await prisma.auditLog.count({ where: { centerId: centerA.id } });
  console.log(`centre A resolved centre-B-only phone -> "${name}" in ${disclosed}/${ROUNDS} calls; rows written at A=${writes}, audit rows at A=${audits}`);
  if (disclosed !== ROUNDS || writes !== 0) ok = false;

  console.log(ok ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((error) => {
    console.error(error);
    console.log("NOT REPRODUCED");
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await prisma.$disconnect();
  });
