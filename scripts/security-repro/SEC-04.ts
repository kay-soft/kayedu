/**
 * A12-1 — A VERIFIED ParentLink is never revoked: changing the student's
 * parent phone (and even deactivating the student) leaves the old parent
 * account reading the child's live schedule.
 *
 * What it proves
 *   1. `verifiedChildLinks` (lib/db/parents.ts:121-130) filters ONLY on
 *      `{ parentUserId, status: VERIFIED }` — it never re-checks the link's
 *      `matchedPhone` against the student's *current* parentPhone/parentAltPhone,
 *      nor `studentProfile.active`.
 *   2. `updateStudentAction` (app/[locale]/(center)/students/actions.ts:339-350)
 *      rewrites `parentPhone` with a plain scoped `updateMany` and touches no
 *      ParentLink row; `setStudentActiveAction` (:367) likewise. There is no
 *      revoke/delete path for ParentLink anywhere in app/ or lib/.
 *   3. So the parent page's reads (app/[locale]/(parent)/parent/page.tsx:55-64
 *      -> lib/db/student-portal.ts `studentUpcomingSessions`) still return the
 *      child's upcoming sessions (date/time/room = a minor's whereabouts) to the
 *      OLD parent account after staff replaced that phone.
 *
 * Imported vs replicated
 *   - IMPORTED (pure, relative imports only): `originateParentLinks`,
 *     `verifyParentLinkPlaceholder`, `verifiedChildLinks` from lib/db/parents.ts
 *     and `studentUpcomingSessions` from lib/db/student-portal.ts.
 *   - REPLICATED: the Server Action writes (they import `@/`/next and cannot be
 *     loaded here) — `scope.db.students.update(id, {...parentPhone})` is
 *     `prisma.studentProfile.updateMany({ where: { centerId, id }, data })`
 *     (lib/db/scoped.ts:282-289), reproduced verbatim below.
 *
 * Fixtures: one Organization + Center (slug `secrepro-a12-`), users with emails
 * `secrepro-a12-*@kayedu.test`; all removed in `finally` (and pre-cleaned).
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-04.ts
 */
import { PrismaClient } from "@prisma/client";

import {
  originateParentLinks,
  verifiedChildLinks,
  verifyParentLinkPlaceholder,
} from "../../lib/db/parents.ts";
import { studentUpcomingSessions } from "../../lib/db/student-portal.ts";

const SLUG_PREFIX = "secrepro-a12-";
const EMAIL_PREFIX = "secrepro-a12-";
// Throwaway phones in the canonical 01XXXXXXXXX shape (lib/phone.ts); chosen
// to be implausible as real numbers and checked unused below.
const OLD_PARENT_PHONE = "01599990001";
const NEW_PARENT_PHONE = "01599990002";

const prisma = new PrismaClient();

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

async function main(): Promise<boolean> {
  await cleanup();

  // Make sure the throwaway phones are not anyone's real data.
  const clash = await prisma.studentProfile.count({
    where: { OR: [{ parentPhone: { in: [OLD_PARENT_PHONE, NEW_PARENT_PHONE] } }, { parentAltPhone: { in: [OLD_PARENT_PHONE, NEW_PARENT_PHONE] } }] },
  });
  const userClash = await prisma.user.count({ where: { phone: { in: [OLD_PARENT_PHONE, NEW_PARENT_PHONE] } } });
  if (clash > 0 || userClash > 0) throw new Error("throwaway phone already in use — pick another");

  const center = await prisma.center.create({
    data: {
      slug: `${SLUG_PREFIX}c1`,
      name: "SecRepro A12 c1",
      organization: { create: { name: "SecRepro A12 org" } },
    },
  });
  const staff = await prisma.user.create({
    data: { firstName: "Mgr", lastName: "A12", email: `${EMAIL_PREFIX}mgr@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({ data: { centerId: center.id, userId: staff.id, role: "MANAGER" } });
  const teacher = await prisma.user.create({
    data: { firstName: "T", lastName: "A12", email: `${EMAIL_PREFIX}teacher@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({ data: { centerId: center.id, userId: teacher.id, role: "TEACHER" } });

  const childUser = await prisma.user.create({
    data: { firstName: "Child", lastName: "A12", email: `${EMAIL_PREFIX}child@kayedu.test`, locale: "en" },
  });
  const child = await prisma.studentProfile.create({
    data: {
      centerId: center.id,
      userId: childUser.id,
      studentCode: "A12-1001",
      firstName: "Child",
      lastName: "A12",
      parentPhone: OLD_PARENT_PHONE,
    },
  });

  // A class the child is enrolled in, with one future session.
  const now = new Date();
  const classGroup = await prisma.classGroup.create({
    data: {
      centerId: center.id,
      teacherId: teacher.id,
      startDate: new Date(now.getTime() - 86_400_000),
      endDate: new Date(now.getTime() + 60 * 86_400_000),
    },
  });
  await prisma.enrollment.create({
    data: { centerId: center.id, studentProfileId: child.id, classGroupId: classGroup.id },
  });
  const future = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7));
  await prisma.session.create({
    data: {
      centerId: center.id,
      teacherId: teacher.id,
      classGroupId: classGroup.id,
      date: future,
      startTime: "16:00",
      endTime: "18:00",
    },
  });

  // The (former) parent account, registered with the old parent phone.
  const oldParent = await prisma.user.create({
    data: {
      firstName: "OldParent",
      lastName: "A12",
      email: `${EMAIL_PREFIX}oldparent@kayedu.test`,
      phone: OLD_PARENT_PHONE,
      locale: "en",
    },
  });

  // signUpAction (app/[locale]/(auth)/actions.ts:153) -> PENDING link.
  const origin = await originateParentLinks(prisma, { parentUserId: oldParent.id, phone: OLD_PARENT_PHONE });
  if (!origin.ok || origin.refused || origin.createdLinkIds.length !== 1) {
    throw new Error(`unexpected origination result ${JSON.stringify(origin)}`);
  }
  // verifyParentLinkAction (students/actions.ts:662) -> VERIFIED.
  const verified = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: origin.createdLinkIds[0],
    centerId: center.id,
    verifiedByUserId: staff.id,
  });
  if (!verified.ok) throw new Error("verify failed");

  const before = await verifiedChildLinks(prisma, oldParent.id);
  console.log(`before phone change: old parent sees ${before.length} child link(s)`);

  // ── Staff correct the record: the old number is no longer this child's parent ──
  // Replica of updateStudentAction -> scoped(ctx).students.update (lib/db/scoped.ts:282-289)
  await prisma.studentProfile.updateMany({
    where: { centerId: center.id, id: child.id },
    data: { parentPhone: NEW_PARENT_PHONE, parentAltPhone: null },
  });
  // Replica of setStudentActiveAction (students/actions.ts:367)
  await prisma.studentProfile.updateMany({
    where: { centerId: center.id, id: child.id },
    data: { active: false },
  });

  const current = await prisma.studentProfile.findUniqueOrThrow({
    where: { id: child.id },
    select: { parentPhone: true, parentAltPhone: true, active: true },
  });
  console.log(`student now: parentPhone=${current.parentPhone} parentAltPhone=${current.parentAltPhone} active=${current.active}`);

  // ── What the parent portal builds on (lib/auth/tenant.ts getVerifiedParentChildren) ──
  const after = await verifiedChildLinks(prisma, oldParent.id);
  console.log(`after phone change + deactivation: old parent sees ${after.length} child link(s)`);
  for (const link of after) {
    console.log(`  link ${link.id} status=${link.status} matchedPhone=${link.matchedPhone} child=${link.studentProfile.firstName} ${link.studentProfile.lastName}`);
  }

  // ── And the schedule read the parent page runs for that child (parent/page.tsx:62) ──
  let upcomingCount = 0;
  if (after[0]) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const upcoming = await studentUpcomingSessions(prisma, after[0].centerId, after[0].studentProfileId, today);
    upcomingCount = upcoming.length;
    for (const s of upcoming) {
      console.log(`  old parent can read: session ${s.date.toISOString().slice(0, 10)} ${s.startTime}-${s.endTime} at centre ${after[0].center.name}`);
    }
  }

  const stalePhone = after.some((l) => l.matchedPhone !== current.parentPhone && l.matchedPhone !== current.parentAltPhone);
  return after.length > 0 && stalePhone && upcomingCount > 0;
}

let reproduced = false;
try {
  reproduced = await main();
} catch (error) {
  console.error("error:", error instanceof Error ? error.message : error);
} finally {
  try {
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
}
console.log(reproduced ? "REPRODUCED" : "NOT REPRODUCED");
