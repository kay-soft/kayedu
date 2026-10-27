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
import { issueBranchCode, revokeBranchCode, revokeFamilyLink } from "@/lib/db/parents";
import { scoped, scopedIgnoringVisibilityWindow, type ScopedDb } from "@/lib/db/scoped";
import {
  claimStudentCode,
  studentDeleteBlockers,
  studentSearchWhere,
} from "@/lib/db/students";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { scopedData } from "@/lib/db/tenant-scope";
import {
  removeStoredObject,
  signedUrlFor,
  uploadIdCard,
  uploadStudentPhoto,
} from "@/lib/db/storage";
import { fullName, localName } from "@/lib/identity";
import { redirect } from "@/lib/i18n/navigation";
import { normalizePhone } from "@/lib/phone";
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
  type PhoneLookupResult,
} from "@/lib/validation/people";
import { branchCodeSchema, branchRevokeLinkSchema, type FamilyActionState } from "@/lib/validation/parents";
import { parseActionArgs, phoneLookupArgs, searchArgs } from "@/lib/validation/action-args";
import { logBestEffort } from "@/lib/log";

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
  // A freshly registered student must be findable by the Reception Desk's
  // search immediately (M5) — not just on the Students list.
  revalidatePath(`/${locale}${ROUTES.centerReception}`);
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

/**
 * Re-resolves a form-supplied grade inside this center. A grade the platform
 * has deactivated cannot be newly assigned (R8) — only kept, when it is the
 * student's current one (`currentGradeId`).
 */
async function resolveGrade(
  db: ScopedDb,
  gradeId: string | null,
  currentGradeId: string | null = null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (gradeId === null) return { ok: true, id: null };
  const grade = await db.grades.findById(gradeId);
  if (!grade) return { ok: false };
  if (!grade.catalogActive && gradeId !== currentGradeId) return { ok: false };
  return { ok: true, id: gradeId };
}

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

/**
 * Bounded, server-checked results for the Students list's live search — the
 * exact same `studentSearchWhere` the full-page search already uses, just
 * capped short for a dropdown instead of paginated. Re-checks permission
 * itself rather than trusting that the page that rendered the input did —
 * every action in this file follows that rule.
 */
export async function searchStudentsTypeAheadAction(
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await studentScope();
  if (!scope) return [];
  const args = parseActionArgs(searchArgs, [query]);
  if (!args) return [];
  const [trimmed] = args;
  if (trimmed.length < 2) return [];

  const rows = await scope.db.students.search({
    where: studentSearchWhere(trimmed),
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: ROUTES.centerStudent(row.id),
  }));
}

// ── Receptionist phone lookup (M18, spec §5.1) ──────────────────────────────
// Explicitly NOT a raw "phone → full record" endpoint: it is the exact same
// duplicate-match workflow (`resolveContact`/`describeMatch`) the add-student
// form already runs on submit, just reachable from a phone alone, before the
// rest of the form is filled in — minimum fields, rate-limited inside
// `resolveContact` (the shared store, SEC-11), and a match still requires the
// form's own explicit "link" submit to attach anything. Since SEC-2a (D-02) a
// phone is never a link key, so a phone alone only ever finds someone who is
// already a student here.

export async function lookupPersonByPhoneAction(
  phone: string,
): Promise<PhoneLookupResult> {
  const scope = await studentScope();
  if (!scope) return { status: "notFound" };
  const args = parseActionArgs(phoneLookupArgs, [phone]);
  if (!args) return { status: "notFound" };

  const normalized = normalizePhone(args[0]);
  if (!normalized) return { status: "notFound" };

  const resolution = await resolveContact(
    { centerId: scope.ctx.center.id, actorUserId: scope.ctx.user.id, adding: "student" },
    { phone: normalized },
  );
  if (resolution.kind === "rateLimited") return { status: "rateLimited" };
  if (resolution.kind !== "matched") return { status: "notFound" };

  const match = await describeMatch(scope.ctx.center.id, resolution.match, {
    phone: normalized,
  });
  return { status: "found", match };
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
  const resolution = await resolveContact(
    { centerId, actorUserId: scope.ctx.user.id, adding: "student" },
    contact,
  );
  if (resolution.kind === "rateLimited") return { error: "rateLimited" };

  // Two different people carry these details — merging identities is a manual,
  // audited admin action (docs/02 §3), not something this form decides.
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  let userId: string | null = null;
  let described: Awaited<ReturnType<typeof describeMatch>> | null = null;

  if (resolution.kind === "matched") {
    const match = await describeMatch(centerId, resolution.match, contact);
    described = match;

    // Show the person before linking anything (spec §5).
    if (linkUserId !== resolution.match.user.id) {
      return { status: "matchFound", match };
    }
    if (match.existingHere === "student" || !match.linkable) {
      return { error: "alreadyStudent", match };
    }
    userId = resolution.match.user.id;
  } else if (linkUserId) {
    return { error: "matchGone" };
  }

  // The name to seed onto this center's record: the existing person's real
  // name when linking to a match (unless it is masked, D-08), or the form's
  // own input for a brand-new person (docs/01 §6) — editable here immediately
  // either way, no lock.
  const name = seedLocalName(resolution, { firstName, lastName }, described);

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
          // A receptionist fills the same fields a self-registering student
          // would later complete themselves (M18, spec §4.3 item 4) — this
          // profile is already whole, so it never triggers that one-time gate.
          profileCompletedAt: new Date(),
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

  const grade = await resolveGrade(scope.db, gradeId, student.gradeId);
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

  // F3: the parent phone on this record is contact data only — changing it
  // touches no family link (only explicit, audited revocation ends one).

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
  // history is deactivated, not deleted. The whole history counts, not just
  // what the visibility window shows (SEC-62's "integrity" opt-out).
  if ((await studentDeleteBlockers(scopedIgnoringVisibilityWindow(ctx, "integrity"), student.id)) > 0) {
    return { error: "studentInUse" };
  }

  // Their files go with the record; both paths are re-checked against this
  // center before anything is removed.
  if (student.photoUrl) {
    await removeStoredObject(
      ctx.center.id,
      AVATARS_BUCKET,
      student.photoUrl,
    ).catch(logBestEffort("deleted student's photo clean-up"));
  }
  await removeStoredObject(
    ctx.center.id,
    ID_CARDS_BUCKET,
    studentIdCardPath(ctx.center.id, student.id),
  ).catch(logBestEffort("deleted student's ID card clean-up"));

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
    },
    after: { personDeleted, blocksRemoved: blocks.length },
  });

  revalidateStudentList(locale);
  // The delete control lives on this very record's own detail page
  // (/students/[id]) — without a redirect, Next's automatic post-action
  // refresh of that same route re-fetches the now-deleted row and 404s
  // (docs/00-master-product-spec.md §7.1's "student-delete 404" gap). Send
  // the user back to the list instead of leaving them staring at a 404 for
  // the record they just removed.
  redirect({ href: ROUTES.centerStudents, locale });
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
  // Students may be moved *out of* a grade the platform has deactivated, never into one (R8).
  if (!to.catalogActive) return { fieldErrors: { toGradeId: "notFound" } };

  const result = await db.students.promoteGrade(from.id, to.id);
  if (result.count === 0) return { error: "noStudentsToPromote" };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.promote",
    entityType: "Grade",
    entityId: from.id,
    before: { gradeId: from.id },
    after: { gradeId: to.id, students: result.count },
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

  const grade = await resolveGrade(db, gradeId, student.gradeId);
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
      logBestEffort("replaced photo clean-up"),
    );
  }

  // D-28: the photo is reception's anti-impersonation check (§5.1), so every
  // change to it is audited — who, when, and whether one was replaced. No
  // storage path goes into the log.
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "student.photo.update",
    entityType: "StudentProfile",
    entityId: student.id,
    before: { hadPhoto: Boolean(previous) },
    after: { hasPhoto: true },
  });

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
  ).catch(logBestEffort("removed photo clean-up"));
  await scope.db.students.update(student.id, { photoUrl: null });

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "student.photo.remove",
    entityType: "StudentProfile",
    entityId: student.id,
    before: { hadPhoto: true },
    after: { hasPhoto: false },
  });

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

// ── Parent access (F3) ──────────────────────────────────────────────────────

/**
 * The "Parent access" card on `/students/[id]` (F3, OD-6 decided). Every
 * action needs `parent.link.manage` (MANAGER_BASELINE — OWNER/MANAGER by
 * default, configurable like any other post-M12 action) on a non-denied
 * centre context, and resolves the student through `ctx.center.id` inside
 * `lib/db/parents.ts`, so another branch's student id is `notFound`. The
 * data layer writes the audit row in the same transaction.
 */
async function parentAccessContext() {
  const ctx = await getTenantContext("center");
  return ctxCan(ctx, "parent.link.manage") ? ctx : null;
}

/** "Generate parent code": the code comes back once, in this answer only. */
export async function generateParentCodeAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const ctx = await parentAccessContext();
  if (!ctx) return { error: "forbidden" };
  const parsed = branchCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await issueBranchCode(prisma, {
    centerId: ctx.center.id,
    studentProfileId: parsed.data.studentProfileId,
    actorUserId: ctx.user.id,
  });
  if (!result.ok) return { error: result.error };
  revalidateStudentDetail(parsed.data.locale, parsed.data.studentProfileId);
  return { status: "issued", code: result.code };
}

/** Cancels this branch's waiting code for the student. */
export async function cancelParentCodeAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const ctx = await parentAccessContext();
  if (!ctx) return { error: "forbidden" };
  const parsed = branchCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await revokeBranchCode(prisma, {
    centerId: ctx.center.id,
    studentProfileId: parsed.data.studentProfileId,
    actorUserId: ctx.user.id,
  });
  if (!result.ok) return { error: result.error };
  revalidateStudentDetail(parsed.data.locale, parsed.data.studentProfileId);
  return { status: "revoked" };
}

/** "Remove access": ends one parent's link, with a reason kept on the link. */
export async function revokeParentLinkAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const ctx = await parentAccessContext();
  if (!ctx) return { error: "forbidden" };
  const parsed = branchRevokeLinkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  // The link must belong to a student who is on this branch's books.
  const profile = await scoped(ctx).students.findById(parsed.data.studentProfileId);
  if (!profile) return { error: "notFound" };

  const result = await revokeFamilyLink(prisma, {
    by: "branch",
    linkId: parsed.data.linkId,
    actorUserId: ctx.user.id,
    centerId: ctx.center.id,
    studentUserId: profile.userId,
    reason: parsed.data.reason,
  });
  if (!result.ok) return { error: result.error };
  revalidateStudentDetail(parsed.data.locale, profile.id);
  return { status: "revoked" };
}
