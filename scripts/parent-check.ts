/**
 * Parent role & portal check — the M16 acceptance gate
 * (docs/03-build-order.md M16 "Gates"): "privileged-phone refusal,
 * inert-until-verified, and the 'never a superset of the child' assertion.
 * Isolation matters here — a parent read is a tenant read through a child's
 * StudentProfile — so the gate asserts cross-centre denial too."
 *
 * Run with:  npm run check:parent
 *
 * `lib/auth/tenant.ts` is not imported here (same reasoning as
 * `scripts/permissions-check.ts`: it pulls in Next-runtime modules). This
 * exercises `lib/db/parents.ts` — the module the auth sign-up action and the
 * `/parent` portal both call — directly, plus `lib/auth/permissions.ts`'s
 * `can()`/`permissionsFor()` (free of runtime imports) for the "no write
 * path, even against a hypothetical stored grant" assertion, plus a static
 * sweep of `app/[locale]/(parent)/` for the "no write path reachable from
 * this surface at all" assertion.
 *
 * Six parts:
 *  1. Privileged-phone refusal — a phone already on an active Membership (by
 *     either its global User.phone or its own centre-local phone/altPhone),
 *     or a platform admin's phone, refuses origination outright, even when
 *     the same phone also sits in some student's parentPhone field (the
 *     exact scenario spec §5.1 calls out: a teacher's own child attends the
 *     centre) — zero ParentLink rows are created either way.
 *  2. Inert until verified — origination only ever writes PENDING rows;
 *     `verifiedChildLinks` (the *only* read a parent-portal page may build
 *     on) returns zero rows for a PENDING link, including the parent's own.
 *  3. The OD-6 placeholder seam — since SEC-2a (D-03 (d)) it refuses to
 *     verify anything (`verificationUnavailable`), still says
 *     `alreadyVerified` for a link that is already VERIFIED,
 *     and is centre-scoped: a link cannot be "verified" through another
 *     centre's id.
 *  4. Never a superset of the child — the reads a verified parent link
 *     resolves through (`lib/db/student-portal.ts`, the same functions the
 *     student's own schedule page calls) never surface a classmate's
 *     attendance/session rows, only the linked child's own.
 *  5. Cross-centre isolation — a parent verified at Centre A's child gets
 *     nothing from a PENDING link at Centre B; a link cannot be verified by
 *     naming the wrong centre.
 *  6. No write path — PARENT can never hold any permission, however a
 *     hypothetical grants map is configured (the ceiling in `can()`), and no
 *     file under `app/[locale]/(parent)/` declares a Server Action at all.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  isPrivilegedPhone,
  originateParentLinks,
  parentLinksForStudent,
  verifiedChildLinks,
  verifyParentLinkPlaceholder,
} from "../lib/db/parents.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import { studentPastAttendance } from "../lib/db/student-portal.ts";
import { PERMISSIONS, permissionsFor, type PermissionGrants } from "../lib/auth/permissions.ts";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SLUG_A = "parent-check-a";
const SLUG_B = "parent-check-b";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "parent-check-" } } });
}

async function makeCenter(slug: string, name: string) {
  return prisma.center.create({ data: { slug, name, organization: { create: { name } } } });
}

async function makeStudent(centerId: string, tag: string, parentPhone: string | null) {
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `parent-check-${tag}@kayedu.test`, locale: "en" },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode: `PC-${tag}`,
      firstName: "S",
      lastName: tag,
      parentPhone,
    }),
  });
  return { user, profile };
}

async function makeParentUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "P", lastName: tag, email: `parent-check-${tag}@kayedu.test`, locale: "en" },
  });
}

// ── Static sweep: no Server Action reachable from /parent ──────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

function checkNoWritePathFiles() {
  console.log("Static sweep: app/[locale]/(parent)/");
  const dir = join(ROOT, "app", "[locale]", "(parent)");
  const files = walk(dir);
  check("At least one file exists under app/[locale]/(parent)/ (the sweep is exercising something)", files.length > 0);

  const serverActionFiles = files.filter((file) => /["']use server["']/.test(readFileSync(file, "utf8")));
  check(
    "No file under app/[locale]/(parent)/ declares a Server Action (\"use server\") — no write path is reachable from this surface at all",
    serverActionFiles.length === 0,
    serverActionFiles.join(", "),
  );
}

async function main() {
  await cleanup();
  checkNoWritePathFiles();

  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A, "Parent Check A");
  const centerB = await makeCenter(SLUG_B, "Parent Check B");

  // A privileged phone, on an OWNER's own local Membership contact record —
  // deliberately a phone that differs from the owner's global User.phone,
  // proving the check covers the *local* record too (M3's "contact details
  // are centre-local"), not only the global one.
  const ownerUser = await prisma.user.create({
    data: { firstName: "O", lastName: "wner", email: "parent-check-owner@kayedu.test", locale: "en" },
  });
  const PRIVILEGED_LOCAL_PHONE = "01011111111";
  await prisma.membership.create({
    data: scopedData(centerA.id, {
      userId: ownerUser.id,
      role: "OWNER",
      firstName: "O",
      lastName: "wner",
      phone: PRIVILEGED_LOCAL_PHONE,
      joinedAt: new Date(),
    }),
  });

  // A platform admin's own global phone.
  const PRIVILEGED_ADMIN_PHONE = "01022222222";
  await prisma.user.create({
    data: {
      firstName: "A",
      lastName: "dmin",
      email: "parent-check-admin@kayedu.test",
      phone: PRIVILEGED_ADMIN_PHONE,
      isPlatformAdmin: true,
      locale: "en",
    },
  });

  const NORMAL_PHONE = "01033333333";

  // ── 1. Privileged-phone refusal ───────────────────────────────────────────
  check(
    "isPrivilegedPhone is true for a phone on an active OWNER Membership's own local record",
    await isPrivilegedPhone(prisma, PRIVILEGED_LOCAL_PHONE),
  );
  check(
    "isPrivilegedPhone is true for a platform admin's global phone",
    await isPrivilegedPhone(prisma, PRIVILEGED_ADMIN_PHONE),
  );
  check(
    "isPrivilegedPhone is false for an ordinary, unclaimed phone",
    !(await isPrivilegedPhone(prisma, NORMAL_PHONE)),
  );

  // The exact scenario spec §5.1 calls out: the owner's own privileged phone
  // is ALSO listed as a student's parent phone (their own child attends the
  // centre) — origination must still refuse, not just skip the match.
  await makeStudent(centerA.id, "childOfOwner", PRIVILEGED_LOCAL_PHONE);
  const ownerAsParent = await makeParentUser("ownerAsParent");
  const privilegedAttempt = await originateParentLinks(prisma, {
    parentUserId: ownerAsParent.id,
    phone: PRIVILEGED_LOCAL_PHONE,
  });
  check(
    "A privileged phone that ALSO matches a student's parentPhone is refused as privilegedPhone",
    privilegedAttempt.ok && privilegedAttempt.refused && privilegedAttempt.reason === "privilegedPhone",
    JSON.stringify(privilegedAttempt),
  );
  const linksForOwnerAsParent = await prisma.parentLink.count({ where: { parentUserId: ownerAsParent.id } });
  check("The refused privileged-phone attempt created zero ParentLink rows", linksForOwnerAsParent === 0);

  // ── 2. Origination + inert-until-verified ─────────────────────────────────
  const { profile: childX } = await makeStudent(centerA.id, "childX", NORMAL_PHONE);
  const parent = await makeParentUser("parent1");

  const originated = await originateParentLinks(prisma, { parentUserId: parent.id, phone: NORMAL_PHONE });
  check(
    "A non-privileged phone matching a student's parentPhone creates a PENDING ParentLink",
    originated.ok && !originated.refused && originated.createdLinkIds.length === 1,
    JSON.stringify(originated),
  );
  const createdLink = await prisma.parentLink.findUniqueOrThrow({
    where: { id: originated.ok && !originated.refused ? originated.createdLinkIds[0] : "" },
  });
  check("The created ParentLink starts PENDING", createdLink.status === "PENDING");

  const reOriginated = await originateParentLinks(prisma, { parentUserId: parent.id, phone: NORMAL_PHONE });
  check(
    "Re-running origination for the same parent/phone is idempotent (no duplicate row)",
    (await prisma.parentLink.count({ where: { parentUserId: parent.id, studentProfileId: childX.id } })) === 1,
    JSON.stringify(reOriginated),
  );

  const zeroReadsBeforeVerify = await verifiedChildLinks(prisma, parent.id);
  check(
    "verifiedChildLinks yields ZERO rows for a PENDING link — inert until verified, even for the parent's own linked child",
    zeroReadsBeforeVerify.length === 0,
    JSON.stringify(zeroReadsBeforeVerify),
  );

  // ── 3. The OD-6 placeholder seam ──────────────────────────────────────────
  const wrongCenterVerify = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: createdLink.id,
    centerId: centerB.id,
    verifiedByUserId: ownerUser.id,
  });
  check(
    "Verifying a link by naming the wrong centre's id resolves to notFound",
    !wrongCenterVerify.ok && wrongCenterVerify.error === "notFound",
    JSON.stringify(wrongCenterVerify),
  );

  // SEC-03 / D-03 (d), SEC-2a: the staff stand-in no longer verifies
  // anything — it refuses, and the link stays PENDING. (Was: "flips PENDING
  // to VERIFIED".) A VERIFIED link now exists only the way the seed makes
  // them, so the fixture sets it directly for the read-side checks below.
  const verify = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: createdLink.id,
    centerId: centerA.id,
    verifiedByUserId: ownerUser.id,
  });
  check(
    "verifyParentLinkPlaceholder refuses (verificationUnavailable) and the link stays PENDING",
    !verify.ok &&
      verify.error === "verificationUnavailable" &&
      (await prisma.parentLink.findUniqueOrThrow({ where: { id: createdLink.id } })).status === "PENDING",
    JSON.stringify(verify),
  );
  await prisma.parentLink.update({
    where: { id: createdLink.id },
    data: { status: "VERIFIED", verifiedAt: new Date(), verifiedBy: ownerUser.id },
  });

  const doubleVerify = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: createdLink.id,
    centerId: centerA.id,
    verifiedByUserId: ownerUser.id,
  });
  check(
    "Verifying an already-VERIFIED link is refused as alreadyVerified",
    !doubleVerify.ok && doubleVerify.error === "alreadyVerified",
    JSON.stringify(doubleVerify),
  );

  const readsAfterVerify = await verifiedChildLinks(prisma, parent.id);
  check(
    "verifiedChildLinks now returns exactly this one link once verified",
    readsAfterVerify.length === 1 && readsAfterVerify[0].studentProfileId === childX.id,
    JSON.stringify(readsAfterVerify.map((r) => r.studentProfileId)),
  );

  const staffView = await parentLinksForStudent(prisma, centerA.id, childX.id);
  check(
    "parentLinksForStudent (the staff-side detail view) sees the same VERIFIED row",
    staffView.length === 1 && staffView[0].status === "VERIFIED",
  );

  // ── 4. Never a superset of the child ──────────────────────────────────────
  // A second student in the same centre — attendance/sessions belonging to
  // *them* must never surface through the verified parent's read of childX.
  const { profile: childY } = await makeStudent(centerA.id, "childY", null);
  const teacher = await prisma.user.create({
    data: { firstName: "T", lastName: "eacher", email: "parent-check-teacher@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerA.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "eacher", joinedAt: new Date() }),
  });
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), teacherId: teacher.id, price: 10_000 }),
  });
  const session = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: classGroup.id,
      teacherId: teacher.id,
      date: new Date(Date.now() - 24 * 60 * 60 * 1000),
      startTime: "10:00",
      endTime: "11:00",
      status: "COMPLETED",
      priceSnapshot: 10_000,
    }),
  });
  await prisma.sessionAttendee.create({
    data: scopedData(centerA.id, { sessionId: session.id, studentProfileId: childX.id, attendanceStatus: "PRESENT", recordedBy: teacher.id }),
  });
  await prisma.sessionAttendee.create({
    data: scopedData(centerA.id, { sessionId: session.id, studentProfileId: childY.id, attendanceStatus: "PRESENT", recordedBy: teacher.id }),
  });

  const today = new Date();
  const childXHistory = await studentPastAttendance(prisma, centerA.id, childX.id, today);
  check(
    "The verified parent's read of childX's past attendance contains only childX's own attendee rows, never childY's",
    childXHistory.length === 1 && childXHistory.every((row) => row.studentProfileId === childX.id),
    JSON.stringify(childXHistory.map((r) => r.studentProfileId)),
  );
  check(
    "childY has their own independent attendance row (proving the query is genuinely narrowed, not just an empty coincidence)",
    (await studentPastAttendance(prisma, centerA.id, childY.id, today)).length === 1,
  );

  // ── 5. Cross-centre isolation ──────────────────────────────────────────────
  const { profile: childAtB } = await makeStudent(centerB.id, "childAtB", NORMAL_PHONE);
  await originateParentLinks(prisma, { parentUserId: parent.id, phone: NORMAL_PHONE });
  const pendingAtB = await prisma.parentLink.findFirstOrThrow({
    where: { parentUserId: parent.id, studentProfileId: childAtB.id },
  });
  check("The same phone at Centre B produced its own (still-PENDING) link", pendingAtB.status === "PENDING");

  const verifiedAfterCrossCentreOrigination = await verifiedChildLinks(prisma, parent.id);
  check(
    "A PENDING link at Centre B never appears in verifiedChildLinks — only the already-VERIFIED Centre A link does",
    verifiedAfterCrossCentreOrigination.length === 1 &&
      verifiedAfterCrossCentreOrigination[0].centerId === centerA.id,
    JSON.stringify(verifiedAfterCrossCentreOrigination.map((r) => r.centerId)),
  );

  // ── 6. No write path ────────────────────────────────────────────────────
  const allGrantsOpen: PermissionGrants = Object.fromEntries(
    PERMISSIONS.map((permission) => [permission, true]),
  ) as PermissionGrants;
  check(
    "PARENT holds zero permissions even against a hypothetical, maximally-open grants map — the ceiling in can() denies unconditionally",
    permissionsFor("PARENT", allGrantsOpen).length === 0,
    JSON.stringify(permissionsFor("PARENT", allGrantsOpen)),
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} parent check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll parent checks passed.");
  });
