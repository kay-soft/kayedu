"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  createPerson,
  deletePersonIfOrphaned,
  describeMatch,
  resolveContact,
  seedLocalName,
} from "@/lib/db/identity";
import { studentCardSvg } from "@/lib/db/id-cards";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { claimStudentCode, studentDeleteBlockers } from "@/lib/db/students";
import { scopedData } from "@/lib/db/tenant-scope";
import {
  removeStoredObject,
  signedUrlFor,
  uploadIdCard,
  uploadStudentPhoto,
} from "@/lib/db/storage";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import {
  AVATARS_BUCKET,
  ID_CARDS_BUCKET,
  studentIdCardPath,
} from "@/lib/storage-paths";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  gradePromotionSchema,
  studentActionSchema,
  studentActiveSchema,
  studentCreateSchema,
  studentGradeSchema,
  studentPhotoSchema,
  studentUpdateSchema,
  type PeopleActionState,
} from "@/lib/validation/people";

/**
 * Students (M3, revised). Every action follows docs/02 §7: getTenantContext()
 * → permission check → zod → scoped write → audit if sensitive → revalidate.
 *
 * A student is a **StudentProfile** at this center, hanging off one global
 * `User` (CLAUDE.md rule 4). Registering someone who already exists links a
 * profile to that person and says so in the UI — it never creates a second
 * identity and never merges silently (spec §5).
 *
 * Name and contact details (firstName/lastName/email/phone/altPhone) are
 * **this center's own local record** for the student (docs/01-data-model.md
 * §6) — seeded from the global `User` at creation, then always editable here,
 * independently of any other center, with no lock of any kind. The student
 * code is never typed: it is claimed race-free from a per-center counter
 * (`lib/db/students.ts`) in the same transaction that creates the record.
 */

const FORBIDDEN: PeopleActionState = { error: "forbidden" };
const NOT_FOUND: PeopleActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

/** Receptionists register students; only Manager/Owner delete them (spec §3). */
async function studentScope(): Promise<Scope | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateStudentList(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerStudents}`);
}

/** List + detail — the two views that show name, grade, code and status. */
function revalidateStudentDetail(locale: string, studentId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerStudent(studentId)}`);
}

/** Card + paper only — the views affected by a photo or a printable field. */
function revalidateStudentPrintables(locale: string, studentId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerStudentCard(studentId)}`);
  revalidatePath(`/${locale}${ROUTES.centerStudentPaper(studentId)}`);
}

/** Re-resolves a form-supplied grade inside this center. */
async function resolveGrade(
  db: ScopedDb,
  gradeId: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (gradeId === null) return { ok: true, id: null };
  return (await db.grades.findById(gradeId)) ? { ok: true, id: gradeId } : { ok: false };
}

// ── Add ────────────────────────────────────────────────────────────────────

export async function createStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    gradeId,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
    linkUserId,
  } = parsed.data;
  const centerId = scope.ctx.center.id;

  const grade = await resolveGrade(scope.db, gradeId);
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };

  const contact = { email, phone };
  const resolution = await resolveContact(contact);

  // Two different people carry these details — merging identities is a manual,
  // audited admin action (docs/02 §3), not something this form decides.
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  let userId: string | null = null;

  if (resolution.kind === "matched") {
    const match = await describeMatch(centerId, resolution.match, contact);

    // Show the person before linking anything (spec §5).
    if (linkUserId !== resolution.match.user.id) {
      return { status: "matchFound", match };
    }
    if (match.existingHere === "student") {
      return { error: "alreadyStudent", match };
    }
    userId = resolution.match.user.id;
  } else if (linkUserId) {
    return { error: "matchGone" };
  }

  // The name to seed onto this center's record: the existing person's real
  // name when linking to a match, or the form's own input for a brand-new
  // person (docs/01 §6) — editable here immediately either way, no lock.
  const name = seedLocalName(resolution, { firstName, lastName });

  // The code claim, the (possible) new person, and the profile all happen in
  // one transaction: a rollback for any reason undoes the claim too, so a
  // crash never burns a code into a permanent gap (docs/01 §6).
  try {
    const created = await prisma.$transaction(async (tx) => {
      const personId =
        userId ??
        (
          await createPerson(
            { firstName, lastName, email, phone, altPhone, locale },
            tx,
          )
        ).id;

      const code = await claimStudentCode(tx, centerId);

      return tx.studentProfile.create({
        data: scopedData(centerId, {
          userId: personId,
          studentCode: code,
          gradeId: grade.id,
          firstName: name.firstName,
          lastName: name.lastName,
          email,
          phone,
          altPhone,
          parentFirstName,
          parentLastName,
          parentPhone,
          parentAltPhone,
        }),
      });
    });

    await writeAuditLog({
      centerId,
      actorUserId: scope.ctx.user.id,
      action: "student.create",
      entityType: "StudentProfile",
      entityId: created.id,
      after: {
        userId: created.userId,
        studentCode: created.studentCode,
        linked: resolution.kind === "matched",
      },
    });

    revalidateStudentList(locale);
    return { status: "created" };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { error: "contactInUse" };
    }
    throw error;
  }
}

// ── Edit ───────────────────────────────────────────────────────────────────

export async function updateStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    studentProfileId,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    gradeId,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
  } = parsed.data;

  const student = await scope.db.students.findDetailById(studentProfileId);
  if (!student) return NOT_FOUND;

  const grade = await resolveGrade(scope.db, gradeId);
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };

  // This center's own record — name included — is always editable, with no
  // lock of any kind (docs/01 §6). The student code is never part of this
  // form; it was assigned once, at creation.
  await scope.db.students.update(student.id, {
    firstName,
    lastName,
    gradeId: grade.id,
    email,
    phone,
    altPhone,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
  });

  revalidateStudentDetail(locale, student.id);
  revalidateStudentPrintables(locale, student.id);
  revalidateStudentList(locale);
  return { status: "saved" };
}

export async function setStudentActiveAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { studentProfileId, active, locale } = parsed.data;
  const student = await scope.db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;
  if (student.active === active) return { status: "saved" };

  await scope.db.students.update(student.id, { active });

  // Active/inactive shows on the list row and the detail header only.
  revalidateStudentList(locale);
  revalidateStudentDetail(locale, student.id);
  return { status: "saved" };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  // Delete is a Manager/Owner action, never a receptionist's (spec §3).
  if (!ctxCan(ctx, "student.delete")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = studentActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { studentProfileId, locale } = parsed.data;
  const student = await db.students.findDetailById(studentProfileId);
  if (!student) return NOT_FOUND;

  // Attendance and money are append-only (CLAUDE.md rule 2): a student with
  // history is deactivated, not deleted.
  if ((await studentDeleteBlockers(db, student.id)) > 0) {
    return { error: "studentInUse" };
  }

  // Their files go with the record; both paths are re-checked against this
  // center before anything is removed.
  if (student.photoUrl) {
    await removeStoredObject(
      ctx.center.id,
      AVATARS_BUCKET,
      student.photoUrl,
    ).catch(() => undefined);
  }
  await removeStoredObject(
    ctx.center.id,
    ID_CARDS_BUCKET,
    studentIdCardPath(ctx.center.id, student.id),
  ).catch(() => undefined);

  await db.students.remove(student.id);

  const blocks = await db.studentBlocks.list({ blockedUserId: student.userId });
  for (const block of blocks) await db.studentBlocks.remove(block.id);

  const personDeleted = await deletePersonIfOrphaned(student.userId);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.delete",
    entityType: "StudentProfile",
    entityId: student.id,
    before: {
      userId: student.userId,
      studentCode: student.studentCode,
      name: fullName(localName(student, student.user)),
    },
    after: { personDeleted, blocksRemoved: blocks.length },
  });

  revalidateStudentList(locale);
  return { status: "deleted" };
}

// ── Grade promotion (end of term) ──────────────────────────────────────────

export async function promoteGradeAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.promote")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = gradePromotionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { fromGradeId, toGradeId, locale } = parsed.data;

  // Both grades are re-resolved here — a grade id from another center is not a
  // grade at all as far as this center is concerned.
  const [from, to] = await Promise.all([
    db.grades.findById(fromGradeId),
    db.grades.findById(toGradeId),
  ]);
  if (!from || !to) return { fieldErrors: { fromGradeId: "notFound" } };

  const result = await db.students.promoteGrade(from.id, to.id);
  if (result.count === 0) return { error: "noStudentsToPromote" };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.promote",
    entityType: "Grade",
    entityId: from.id,
    before: { gradeId: from.id, gradeName: from.name },
    after: { gradeId: to.id, gradeName: to.name, students: result.count },
  });

  revalidateStudentList(locale);
  return { status: "saved" };
}

/** Move one student — the same action, one row at a time. */
export async function setStudentGradeAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.promote")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = studentGradeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { studentProfileId, gradeId, locale } = parsed.data;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  const grade = await resolveGrade(db, gradeId);
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };
  if (student.gradeId === grade.id) return { status: "saved" };

  await db.students.update(student.id, { gradeId: grade.id });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.promote",
    entityType: "StudentProfile",
    entityId: student.id,
    before: { gradeId: student.gradeId },
    after: { gradeId: grade.id },
  });

  revalidateStudentList(locale);
  revalidateStudentDetail(locale, student.id);
  return { status: "saved" };
}

// ── Photo (Supabase Storage) ───────────────────────────────────────────────

export async function uploadStudentPhotoAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentPhotoSchema.safeParse({
    locale: formData.get("locale"),
    studentProfileId: formData.get("studentProfileId"),
  });
  if (!parsed.success) return NOT_FOUND;

  const student = await scope.db.students.findById(parsed.data.studentProfileId);
  if (!student) return NOT_FOUND;

  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { error: "photoMissing" };

  const uploaded = await uploadStudentPhoto(
    scope.ctx.center.id,
    student.id,
    file,
  );
  if (!uploaded.ok) return { error: uploaded.error };

  const previous = student.photoUrl;
  await scope.db.students.update(student.id, { photoUrl: uploaded.path });
  if (previous && previous !== uploaded.path) {
    await removeStoredObject(scope.ctx.center.id, AVATARS_BUCKET, previous).catch(
      () => undefined,
    );
  }

  revalidateStudentPrintables(parsed.data.locale, student.id);
  return { status: "saved" };
}

export async function removeStudentPhotoAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const student = await scope.db.students.findById(parsed.data.studentProfileId);
  if (!student) return NOT_FOUND;
  if (!student.photoUrl) return { status: "saved" };

  await removeStoredObject(
    scope.ctx.center.id,
    AVATARS_BUCKET,
    student.photoUrl,
  ).catch(() => undefined);
  await scope.db.students.update(student.id, { photoUrl: null });

  revalidateStudentPrintables(parsed.data.locale, student.id);
  return { status: "deleted" };
}

// ── ID card generation ─────────────────────────────────────────────────────

/**
 * Renders the card from `CenterSettings.cardLayout` and stores it under
 * `id-cards/{centerId}/{studentProfileId}.svg` (docs/02 §10), returning a
 * short-lived signed link for download.
 */
export async function generateIdCardAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await studentScope();
  if (!scope) return FORBIDDEN;

  const parsed = studentActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { studentProfileId, locale } = parsed.data;
  const student = await scope.db.students.findDetailById(studentProfileId);
  if (!student) return NOT_FOUND;

  const t = await getTranslations({ locale, namespace: "Students" });
  const svg = await studentCardSvg(scope.ctx, student, {
    dir: locale === "ar" ? "rtl" : "ltr",
    codeLabel: t("card.codeLabel"),
  });

  const stored = await uploadIdCard(scope.ctx.center.id, student.id, svg);
  if (!stored.ok) return { error: "storage" };

  const downloadUrl = await signedUrlFor(
    scope.ctx.center.id,
    ID_CARDS_BUCKET,
    stored.path,
  );

  revalidateStudentPrintables(locale, student.id);
  return downloadUrl
    ? { status: "generated", downloadUrl }
    : { error: "storage" };
}
