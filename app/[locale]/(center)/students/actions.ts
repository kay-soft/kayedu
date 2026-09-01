"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import {
  countOtherCenterRelations,
  createPerson,
  deletePersonIfOrphaned,
  describeMatch,
  resolveContact,
  updatePerson,
} from "@/lib/db/identity";
import { studentCardSvg } from "@/lib/db/id-cards";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { nextStudentCode, studentDeleteBlockers } from "@/lib/db/students";
import {
  removeStoredObject,
  signedUrlFor,
  uploadIdCard,
  uploadStudentPhoto,
} from "@/lib/db/storage";
import { canEditGlobalProfile, fullName } from "@/lib/identity";
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
 * Students (M3). Every action follows docs/02 §7: getTenantContext() →
 * permission check → zod → scoped write → audit if sensitive → revalidate.
 *
 * A student is a **StudentProfile** at this center, hanging off one global
 * `User` (CLAUDE.md rule 4). Registering someone who already exists links a
 * profile to that person and says so in the UI — it never creates a second
 * identity and never merges silently (spec §5).
 */

const FORBIDDEN: PeopleActionState = { error: "forbidden" };
const NOT_FOUND: PeopleActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

/** Receptionists register students; only Manager/Owner delete them (spec §3). */
async function studentScope(): Promise<Scope | null> {
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "student.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateStudents(locale: string, studentId?: string): void {
  revalidatePath(`/${locale}${ROUTES.centerStudents}`);
  if (studentId) {
    revalidatePath(`/${locale}${ROUTES.centerStudent(studentId)}`);
    revalidatePath(`/${locale}${ROUTES.centerStudentCard(studentId)}`);
    revalidatePath(`/${locale}${ROUTES.centerStudentPaper(studentId)}`);
  }
}

function isUniqueViolation(error: unknown, target?: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  if (!target) return true;
  const fields = (error.meta?.target ?? []) as string[] | string;
  return Array.isArray(fields)
    ? fields.includes(target)
    : String(fields).includes(target);
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
    studentCode,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
    linkUserId,
  } = parsed.data;

  const grade = await resolveGrade(scope.db, gradeId);
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };

  if (
    studentCode &&
    (await scope.db.students.count({ studentCode })) > 0
  ) {
    return { fieldErrors: { studentCode: "duplicateStudentCode" } };
  }

  const contact = { email, phone };
  const resolution = await resolveContact(contact);

  // Two different people carry these details — merging identities is a manual,
  // audited admin action (docs/02 §3), not something this form decides.
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  let userId: string;

  if (resolution.kind === "matched") {
    const match = await describeMatch(
      scope.ctx.center.id,
      resolution.user,
      contact,
    );

    // Show the person before linking anything (spec §5).
    if (linkUserId !== resolution.user.id) {
      return { status: "matchFound", match };
    }
    if (match.existingHere === "student") {
      return { error: "alreadyStudent", match };
    }
    userId = resolution.user.id;
  } else {
    if (linkUserId) return { error: "matchGone" };
    try {
      const person = await createPerson({
        firstName,
        lastName,
        email,
        phone,
        altPhone,
        locale,
      });
      userId = person.id;
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "contactInUse" };
      throw error;
    }
  }

  const profileData = {
    userId,
    gradeId: grade.id,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
  };

  // Two receptionists registering at once can land on the same auto code, so
  // the unique index is the arbiter and a collision simply retries.
  let created;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    const code = studentCode ?? (await nextStudentCode(scope.db));
    try {
      created = await scope.db.students.create({
        ...profileData,
        studentCode: code,
      });
    } catch (error) {
      if (isUniqueViolation(error, "userId")) return { error: "alreadyStudent" };
      if (isUniqueViolation(error, "studentCode")) {
        if (studentCode) {
          return { fieldErrors: { studentCode: "duplicateStudentCode" } };
        }
        continue;
      }
      throw error;
    }
  }
  if (!created) return { fieldErrors: { studentCode: "duplicateStudentCode" } };

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "student.create",
    entityType: "StudentProfile",
    entityId: created.id,
    after: {
      userId,
      studentCode: created.studentCode,
      linked: resolution.kind === "matched",
    },
  });

  revalidateStudents(locale, created.id);
  return { status: "created" };
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
    studentCode,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
  } = parsed.data;

  const student = await scope.db.students.findDetailById(studentProfileId);
  if (!student) return NOT_FOUND;

  const grade = await resolveGrade(scope.db, gradeId);
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };

  const code = studentCode ?? student.studentCode;
  if (
    code !== student.studentCode &&
    (await scope.db.students.count({ studentCode: code })) > 0
  ) {
    return { fieldErrors: { studentCode: "duplicateStudentCode" } };
  }

  try {
    await scope.db.students.update(student.id, {
      studentCode: code,
      gradeId: grade.id,
      parentFirstName,
      parentLastName,
      parentPhone,
      parentAltPhone,
    });
  } catch (error) {
    if (isUniqueViolation(error, "studentCode")) {
      return { fieldErrors: { studentCode: "duplicateStudentCode" } };
    }
    throw error;
  }

  // The person's own name/email/phone are global. This center may only rewrite
  // them for someone it created who exists nowhere else (lib/identity.ts).
  const editable = canEditGlobalProfile({
    authId: student.user.authId,
    otherCenterRelations: await countOtherCenterRelations(
      student.userId,
      scope.ctx.center.id,
    ),
  });

  if (editable) {
    try {
      await updatePerson(student.userId, {
        firstName,
        lastName,
        email,
        phone,
        altPhone,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "contactInUse" };
      throw error;
    }
  }

  revalidateStudents(locale, student.id);
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

  revalidateStudents(locale, student.id);
  return { status: "saved" };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
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
      name: fullName(student.user),
    },
    after: { personDeleted, blocksRemoved: blocks.length },
  });

  revalidateStudents(locale, student.id);
  return { status: "deleted" };
}

// ── Grade promotion (end of term) ──────────────────────────────────────────

export async function promoteGradeAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
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

  revalidateStudents(locale);
  return { status: "saved" };
}

/** Move one student — the same action, one row at a time. */
export async function setStudentGradeAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
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

  revalidateStudents(locale, student.id);
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

  revalidateStudents(parsed.data.locale, student.id);
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

  revalidateStudents(parsed.data.locale, student.id);
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

  revalidateStudents(locale, student.id);
  return downloadUrl
    ? { status: "generated", downloadUrl }
    : { error: "storage" };
}
