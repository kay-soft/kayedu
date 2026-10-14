/**
 * A02-1 — A TEACHER-only member can drive centre-staff Server Actions gated on
 * `student.block` (SEC-1 audit, area A02: AuthZ).
 *
 * What it proves:
 *   Every centre Server Action resolves its role with `getTenantContext("center")`
 *   (lib/auth/tenant.ts:212) and never calls `hasExperience`/`requireExperience`.
 *   `roleForExperience(relation, "center")` (lib/auth/relations.ts:197-210) falls back
 *   to the TEACHER role when the user holds no staff role, and the default matrix
 *   (`DEFAULT_ROLE_GRANTS.TEACHER`, lib/auth/permissions.ts) grants TEACHER
 *   `student.block`. So the centre-side `blockStudentAction` / `unblockStudentAction` /
 *   `searchBlockCandidatesAction` (app/[locale]/(center)/teachers/actions.ts:104,342,394)
 *   all pass their only gate for a teacher, even though the (center) layout's
 *   `requireExperience("center")` would bounce that same user from the page.
 *
 * What is IMPORTED (real code, relative .ts imports): resolveCenterRelations +
 *   roleForExperience (lib/auth/relations.ts), loadPermissionGrants
 *   (lib/db/permissions.ts), can + isCenterStaffRole (lib/auth/permissions.ts),
 *   provisionCenterBaseline (lib/db/provision.ts), scopedWhere (lib/db/tenant-scope.ts).
 * What is REPLICATED (the action modules import `@/`, `next/*` and cannot be loaded):
 *   - `buildContext` role/grant resolution (lib/auth/tenant.ts:146-155) — same two calls.
 *   - `hasExperience(ctx,"center")` (lib/auth/tenant.ts:455-458) — same predicate.
 *   - the Prisma query shapes of searchBlockCandidatesAction (teachers/actions.ts:115-129,
 *     via lib/db/scoped.ts students.search), blockStudentAction (:356-373) and
 *     unblockStudentAction (:405-408 — note: no `block.scope` check).
 *
 * Fixtures: one throwaway org + centre (slug `secrepro-a02-*`), three users
 * (`secrepro-a02-*@kayedu.test`), all deleted in `finally` (and pre-cleaned).
 * No Supabase Auth users. Never touches seed data.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-09.ts
 * Final line: REPRODUCED | NOT REPRODUCED
 */
import { PrismaClient } from "@prisma/client";
import { resolveCenterRelations, roleForExperience } from "../../lib/auth/relations.ts";
import { loadPermissionGrants } from "../../lib/db/permissions.ts";
import { can, isCenterStaffRole } from "../../lib/auth/permissions.ts";
import { provisionCenterBaseline } from "../../lib/db/provision.ts";
import { scopedWhere } from "../../lib/db/tenant-scope.ts";

const prisma = new PrismaClient();
const SLUG = "secrepro-a02-c1";
const ORG_NAME = "secrepro-a02-org";
const EMAILS = [
  "secrepro-a02-teacher-a@kayedu.test",
  "secrepro-a02-teacher-b@kayedu.test",
  "secrepro-a02-student@kayedu.test",
];

async function cleanup() {
  const centers = await prisma.center.findMany({ where: { slug: { startsWith: "secrepro-a02-" } }, select: { id: true, organizationId: true } });
  if (centers.length) {
    await prisma.center.deleteMany({ where: { id: { in: centers.map((c) => c.id) } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
  }
  await prisma.organization.deleteMany({ where: { name: ORG_NAME } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
}

let reproduced = false;
try {
  await cleanup();

  const center = await prisma.center.create({
    data: { slug: SLUG, name: "SecRepro A02", organization: { create: { name: ORG_NAME } } },
  });
  await provisionCenterBaseline(prisma, center.id); // the real baseline every centre gets

  const [teacherA, teacherB, studentUser] = await Promise.all(
    EMAILS.map((email, i) => prisma.user.create({ data: { email, firstName: ["TeacherA", "TeacherB", "Student"][i], lastName: "SecRepro" } })),
  );
  await prisma.membership.create({ data: { centerId: center.id, userId: teacherA.id, role: "TEACHER", joinedAt: new Date() } });
  await prisma.membership.create({ data: { centerId: center.id, userId: teacherB.id, role: "TEACHER", joinedAt: new Date() } });
  const student = await prisma.studentProfile.create({
    data: { centerId: center.id, userId: studentUser.id, studentCode: "SECREPRO-1", firstName: "Minor", lastName: "Student", phone: "01000000000" },
  });
  // A CLASS-scope block placed by staff (refId = a class id; no FK on refId).
  const staffBlock = await prisma.studentBlock.create({
    data: { centerId: center.id, scope: "CLASS", refId: "00000000-0000-4000-8000-000000000a02", blockedUserId: studentUser.id, reason: "staff decision" },
  });

  // ── 1. What getTenantContext("center") resolves for the TEACHER-only attacker ──
  const relations = await resolveCenterRelations(prisma, teacherA.id);
  const relation = relations.find((r) => r.center.id === center.id);
  if (!relation) throw new Error("teacher relation not resolved");
  const hasCenterExperience = relation.roles.some((role) => isCenterStaffRole(role)); // hasExperience(ctx,"center")
  const role = roleForExperience(relation, "center");
  const grants = role === "STUDENT" ? {} : await loadPermissionGrants(prisma, center.id, role);
  const gatePasses = can(role, "student.block", grants);
  console.log(`relation roles=${JSON.stringify(relation.roles)} hasExperience(center)=${hasCenterExperience}`);
  console.log(`getTenantContext("center").role=${role}  ctxCan(student.block)=${gatePasses}`);

  // ── 2. searchBlockCandidatesAction: full-roster search the teacher never taught ──
  const taughtByA = await prisma.sessionAttendee.count({ where: { centerId: center.id, session: { teacherId: teacherA.id } } });
  const rosterLeak = await prisma.studentProfile.findMany({
    where: scopedWhere(center.id, { active: true, OR: [{ firstName: { contains: "Min", mode: "insensitive" as const } }] }),
    select: { id: true, studentCode: true, firstName: true },
    take: 8,
  });
  console.log(`students taught by attacker=${taughtByA}; roster rows returned to attacker=${rosterLeak.length}`);

  // ── 3. blockStudentAction: block the student from ANOTHER teacher (teacherUserId from the form) ──
  const victimTeacher = await prisma.membership.findFirst({ where: scopedWhere(center.id, { userId: teacherB.id, role: "TEACHER" as const }) });
  const target = await prisma.studentProfile.findFirst({ where: scopedWhere(center.id, { id: student.id }) });
  let blockCreated = false;
  if (gatePasses && victimTeacher && target) {
    await prisma.studentBlock.create({
      data: { centerId: center.id, scope: "TEACHER", refId: teacherB.id, blockedUserId: target.userId, reason: "forged by teacher A" },
    });
    blockCreated = true;
  }
  console.log(`block on teacher B's list created by teacher A: ${blockCreated}`);

  // ── 4. unblockStudentAction: remove the staff CLASS block (no scope check in the action) ──
  let staffBlockRemoved = false;
  if (gatePasses) {
    const block = await prisma.studentBlock.findFirst({ where: scopedWhere(center.id, { id: staffBlock.id }) });
    if (block) {
      await prisma.studentBlock.delete({ where: { id: block.id } });
      staffBlockRemoved = true;
    }
  }
  console.log(`staff CLASS-scope block removed by teacher A: ${staffBlockRemoved}`);

  reproduced = !hasCenterExperience && role === "TEACHER" && gatePasses && rosterLeak.length > 0 && taughtByA === 0 && blockCreated && staffBlockRemoved;
} catch (error) {
  console.log(`error: ${(error as Error).message}`);
} finally {
  await cleanup().catch((e) => console.log(`cleanup error: ${(e as Error).message}`));
  await prisma.$disconnect();
}
console.log(reproduced ? "REPRODUCED" : "NOT REPRODUCED");
