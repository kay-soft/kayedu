import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose: `ensureStudentProfile` (lib/db/reservations.ts)
// and the gates (`check:student-portal`, `check:people`) run this outside
// Next, so what a new branch profile is seeded with is the REAL rule.
import { centerGradeById } from "./catalog.ts";
import { writeAuditRow } from "./audit-row.ts";

/**
 * The student's own study details (F4, docs/00 §4.3 "Study details",
 * §5.1 "Two-layer grade"): `User.gradeId`, the grade **the student says they
 * are in**. It is a different thing from `StudentProfile.gradeId`, **the
 * grade a branch has on file** — the account grade seeds a *new* branch
 * profile and pre-selects Discover's grade filter, and never changes any
 * branch record (CLAUDE.md rule 4). Nothing in this file writes a
 * `StudentProfile` after it exists, except the one explicit, audited staff
 * action `applyAccountGrade`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AccountGradeResult = { ok: true; gradeId: string | null } | { ok: false; error: "notFound" };

/**
 * Sets (or clears) the caller's own account grade. A grade the platform has
 * deactivated can be kept but not newly chosen (R8, as everywhere). Touches
 * `User.gradeId` and nothing else — no branch record, no enrolment.
 */
export async function setAccountGrade(
  db: PrismaClient,
  userId: string,
  gradeId: string | null,
): Promise<AccountGradeResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { gradeId: true } });
  if (!user) return { ok: false, error: "notFound" };
  if (gradeId !== null && gradeId !== user.gradeId) {
    const grade = await db.catalogGrade.findFirst({ where: { id: gradeId, active: true }, select: { id: true } });
    if (!grade) return { ok: false, error: "notFound" };
  }
  if (gradeId === user.gradeId) return { ok: true, gradeId };
  await db.user.update({ where: { id: userId }, data: { gradeId } });
  return { ok: true, gradeId };
}

export type DeclaredParent = {
  firstName: string | null;
  lastName: string | null;
  /** Already normalized by `lib/phone.ts` when the invitation was issued. */
  phone: string;
};

/**
 * The parent this student most recently **declared** (F3 "Invite a parent"):
 * the latest of their own invitations that is still PENDING or was ACCEPTED —
 * a cancelled or replaced one is the student taking it back. Contact data
 * only: it is copied into a new branch profile as that branch's own record,
 * and it creates, matches and links nothing (a link needs a code, D-02).
 */
export async function latestDeclaredParent(db: Db, studentUserId: string): Promise<DeclaredParent | null> {
  const row = await db.familyInvitation.findFirst({
    where: {
      studentUserId,
      source: "STUDENT_INVITE",
      status: { in: ["PENDING", "ACCEPTED"] },
      declaredParentPhone: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { declaredParentFirstName: true, declaredParentLastName: true, declaredParentPhone: true },
  });
  if (!row?.declaredParentPhone) return null;
  return {
    firstName: row.declaredParentFirstName,
    lastName: row.declaredParentLastName,
    phone: row.declaredParentPhone,
  };
}

/**
 * What a brand-new branch profile starts with beyond the name and contact
 * (`ensureStudentProfile`): the account grade — only when **this branch
 * offers it** (its own active catalog pick, SEC-49: the completion form
 * accepts nothing else) — and the declared parent. When both a grade and a
 * parent phone are present the profile is already whole, so the one-time
 * completion form (M18, D-11) is not shown; otherwise it still is.
 */
export async function seedFromAccount(
  db: Db,
  centerId: string,
  user: { id: string; gradeId: string | null },
): Promise<{
  gradeId: string | null;
  parentFirstName: string | null;
  parentLastName: string | null;
  parentPhone: string | null;
  profileCompletedAt: Date | null;
}> {
  const [grade, parent] = await Promise.all([
    user.gradeId ? centerGradeById(db, centerId, user.gradeId) : null,
    latestDeclaredParent(db, user.id),
  ]);
  const gradeId = grade && grade.active && grade.catalogActive ? grade.id : null;
  return {
    gradeId,
    parentFirstName: parent?.firstName ?? null,
    parentLastName: parent?.lastName ?? null,
    parentPhone: parent?.phone ?? null,
    profileCompletedAt: gradeId && parent?.phone ? new Date() : null,
  };
}

/**
 * "Use account grade" on a student's record (F4): copies the student's own
 * account grade onto **this branch's** profile — one explicit, audited staff
 * action, `student.grade.account`, ids only (D-20). The profile is looked up
 * by `centerId`, so another branch's student id is `notFound`; the grade must
 * be one this branch offers. Touches that one `StudentProfile.gradeId`.
 */
export async function applyAccountGrade(
  db: PrismaClient,
  input: { centerId: string; studentProfileId: string; actorUserId: string },
): Promise<{ ok: true; changed: boolean } | { ok: false; error: "notFound" | "gradeNotOffered" }> {
  return db.$transaction(async (tx) => {
    const profile = await tx.studentProfile.findFirst({
      where: { id: input.studentProfileId, centerId: input.centerId },
      select: { id: true, gradeId: true, user: { select: { gradeId: true } } },
    });
    if (!profile) return { ok: false, error: "notFound" } as const;
    const accountGradeId = profile.user.gradeId;
    if (!accountGradeId) return { ok: false, error: "notFound" } as const;
    if (accountGradeId === profile.gradeId) return { ok: true, changed: false } as const;

    const grade = await centerGradeById(tx, input.centerId, accountGradeId);
    if (!grade || !grade.catalogActive) return { ok: false, error: "gradeNotOffered" } as const;

    const updated = await tx.studentProfile.updateMany({
      where: { id: profile.id, centerId: input.centerId },
      data: { gradeId: accountGradeId },
    });
    if (updated.count !== 1) return { ok: false, error: "notFound" } as const;
    await writeAuditRow(tx, {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "student.grade.account",
      entityType: "StudentProfile",
      entityId: profile.id,
      before: { gradeId: profile.gradeId },
      after: { gradeId: accountGradeId },
    });
    return { ok: true, changed: true } as const;
  });
}

/**
 * Account → Study details is for people who study: an account that signed up
 * as a STUDENT, or holds a `StudentProfile` at any branch (F4). Anyone else —
 * a parent, a teacher, staff who never studied here — sees nothing.
 */
export async function showsStudyDetails(
  db: Db,
  user: { id: string; signupIntent: "STUDENT" | "PARENT" | "TEACHER" | null },
): Promise<boolean> {
  if (user.signupIntent === "STUDENT") return true;
  return (await db.studentProfile.count({ where: { userId: user.id } })) > 0;
}

/** A platform catalog grade by id (global rows, no `centerId`) — to name the account grade beside a branch's own. */
export function catalogGradeById(db: Db, id: string) {
  return db.catalogGrade.findUnique({ where: { id }, select: { id: true, nameAr: true, nameEn: true, active: true } });
}
