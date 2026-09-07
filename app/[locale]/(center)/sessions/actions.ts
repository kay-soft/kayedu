"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import {
  createAttendance,
  findAttendee,
  SessionClosedError,
  updateAttendanceStatus,
} from "@/lib/db/attendance";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  createPerson,
  describeMatch,
  resolveContact,
  seedLocalName,
} from "@/lib/db/identity";
import { recordPayment, voidPayment } from "@/lib/db/payments";
import { refundPayment } from "@/lib/db/refunds";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import {
  cancelSession,
  rescheduleSession,
  updateSessionShareOverride,
} from "@/lib/db/sessions";
import { claimStudentCode } from "@/lib/db/students";
import { scopedData } from "@/lib/db/tenant-scope";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  addExistingAttendeeSchema,
  addNewAttendeeSchema,
  cancelSessionSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  rescheduleSessionSchema,
  sessionShareOverrideSchema,
  setAttendanceSchema,
  voidPaymentSchema,
  type SessionActionState,
} from "@/lib/validation/sessions";

/**
 * Session roster, attendance and payment actions (M5 — the daily loop).
 * Every action follows docs/02 §7: getTenantContext() → permission check →
 * zod → scoped write → audit if sensitive → revalidate.
 *
 * Attendance: a first-time mark on a roster row is `attendance.record`
 * (RECEPTIONIST's baseline); changing an already-marked row is
 * `attendance.correct` (Owner/Manager, or a granted receptionist) and is
 * always audited (spec §5 "Attendance").
 *
 * Money: `recordPaymentAction`/`voidPaymentAction` never touch
 * `prisma.payment.*` directly — both call into `lib/db/payments.ts` inside a
 * transaction, the one place the snapshot math and the void/no-op rules live
 * (CLAUDE.md rule 3, docs/01-data-model.md §3).
 */

const FORBIDDEN: SessionActionState = { error: "forbidden" };
const NOT_FOUND: SessionActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

async function sessionScope(): Promise<Scope> {
  const ctx = await getTenantContext("center");
  return { ctx, db: scoped(ctx) };
}

function revalidateSessionDetail(locale: string, sessionId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSession(sessionId)}`);
}

function revalidateSessionList(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSessions}`);
}

function revalidateReceptionDesk(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerReception}`);
}

/** Active-enrollment lookup shared by every "add/mark" path below. */
async function resolveEnrollment(
  db: ScopedDb,
  classGroupId: string,
  studentProfileId: string,
): Promise<{ enrollmentId: string | null; isDropIn: boolean }> {
  const enrollment = await db.enrollments.findExisting(classGroupId, studentProfileId);
  const active = enrollment?.status === "ACTIVE";
  return { enrollmentId: active ? enrollment!.id : null, isDropIn: !active };
}

/**
 * Runs an attendance write and turns `SessionClosedError` (M15, spec §7
 * criterion 17 — the cancelled/rescheduled-session guard) into the same
 * `{ error }` shape every other refusal in this file already returns.
 */
async function writeAttendance<T>(
  write: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: SessionActionState }> {
  try {
    return { ok: true, value: await write() };
  } catch (error) {
    if (error instanceof SessionClosedError) {
      return { ok: false, error: { error: error.reason } };
    }
    throw error;
  }
}

/** EXCUSED is offered only when the session's class allows it (M10). */
async function excusedAllowed(db: ScopedDb, classGroupId: string): Promise<boolean> {
  const classGroup = await db.classGroups.findById(classGroupId);
  return classGroup?.allowExcused ?? true;
}

async function isBlockedFromSession(
  db: ScopedDb,
  classGroupId: string,
  teacherId: string,
  studentUserId: string,
): Promise<boolean> {
  const [classBlocked, teacherBlocked] = await Promise.all([
    db.studentBlocks.isBlocked("CLASS", classGroupId, studentUserId),
    db.studentBlocks.isBlocked("TEACHER", teacherId, studentUserId),
  ]);
  return classBlocked || teacherBlocked;
}

// ── Mark / correct attendance on an already-listed roster row ──────────────

export async function setAttendanceAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx, db } = await sessionScope();

  const parsed = setAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId, studentProfileId, status } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;
  if (status === "EXCUSED" && !(await excusedAllowed(db, session.classGroupId))) {
    return { error: "excusedNotAllowed" };
  }

  const existing = await findAttendee(prisma, ctx.center.id, sessionId, studentProfileId);

  if (existing) {
    if (!ctxCan(ctx, "attendance.correct")) return FORBIDDEN;
    if (existing.attendanceStatus === status) return { status: "saved" };

    const before = existing.attendanceStatus;
    const result = await writeAttendance(() =>
      updateAttendanceStatus(prisma, existing, status, ctx.user.id),
    );
    if (!result.ok) return result.error;

    await writeAuditLog({
      centerId: ctx.center.id,
      actorUserId: ctx.user.id,
      action: "attendance.correct",
      entityType: "SessionAttendee",
      entityId: existing.id,
      before: { attendanceStatus: before },
      after: { attendanceStatus: status },
    });
  } else {
    if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;
    const { enrollmentId, isDropIn } = await resolveEnrollment(
      db,
      session.classGroupId,
      studentProfileId,
    );
    const result = await writeAttendance(() =>
      createAttendance(prisma, {
        centerId: ctx.center.id,
        sessionId,
        studentProfileId,
        enrollmentId,
        isDropIn,
        status,
        recordedBy: ctx.user.id,
      }),
    );
    if (!result.ok) return result.error;
  }

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "saved" };
}

// ── Add a student to the session's roster (spec §4.1 item 7) ───────────────

/** An existing student, found by search — enrolled-but-unmarked or a drop-in. */
export async function addExistingAttendeeAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx, db } = await sessionScope();
  if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;

  const parsed = addExistingAttendeeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId, studentProfileId, status } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;
  if (status === "EXCUSED" && !(await excusedAllowed(db, session.classGroupId))) {
    return { error: "excusedNotAllowed" };
  }

  if (await db.attendees.findExisting(sessionId, studentProfileId)) {
    return { error: "alreadyOnRoster" };
  }
  if (await isBlockedFromSession(db, session.classGroupId, session.teacherId, student.userId)) {
    return { error: "studentBlocked" };
  }

  const { enrollmentId, isDropIn } = await resolveEnrollment(
    db,
    session.classGroupId,
    studentProfileId,
  );
  const result = await writeAttendance(() =>
    createAttendance(prisma, {
      centerId: ctx.center.id,
      sessionId,
      studentProfileId,
      enrollmentId,
      isDropIn,
      status,
      recordedBy: ctx.user.id,
    }),
  );
  if (!result.ok) return result.error;

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "created" };
}

/**
 * A brand-new student, added straight to this session as a drop-in — reusing
 * M3's duplicate-match flow exactly (`lib/db/identity.ts`): a contact that
 * already belongs to someone surfaces the match and waits for confirmation
 * rather than ever creating a second identity (spec §5). If that person
 * already has a `StudentProfile` at this center, it is reused rather than
 * duplicated — this form is for "who is this," not "is this a new record."
 */
export async function addNewAttendeeAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx, db } = await sessionScope();
  if (!ctxCan(ctx, "attendance.record") || !ctxCan(ctx, "student.manage")) {
    return FORBIDDEN;
  }

  const parsed = addNewAttendeeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, sessionId, firstName, lastName, email, phone, status, linkUserId } =
    parsed.data;
  const centerId = ctx.center.id;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  if (status === "EXCUSED" && !(await excusedAllowed(db, session.classGroupId))) {
    return { error: "excusedNotAllowed" };
  }

  const contact = { email, phone };
  const resolution = await resolveContact(contact);
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  let userId: string | null = null;
  if (resolution.kind === "matched") {
    const match = await describeMatch(centerId, resolution.match, contact);
    if (linkUserId !== resolution.match.user.id) {
      return { status: "matchFound", match };
    }
    userId = resolution.match.user.id;
  } else if (linkUserId) {
    return { error: "matchGone" };
  }

  const name = seedLocalName(resolution, { firstName, lastName });

  let studentProfileId: string;
  try {
    const profile = await prisma.$transaction(async (tx) => {
      const personId =
        userId ??
        (
          await createPerson(
            { firstName, lastName, email, phone, altPhone: null, locale },
            tx,
          )
        ).id;

      // Already registered at this center under another flow? Reuse that
      // profile instead of creating a second one for the same person here.
      const existingProfile = await tx.studentProfile.findFirst({
        where: { userId: personId, centerId },
      });
      if (existingProfile) return existingProfile;

      const code = await claimStudentCode(tx, centerId);
      return tx.studentProfile.create({
        data: scopedData(centerId, {
          userId: personId,
          studentCode: code,
          firstName: name.firstName,
          lastName: name.lastName,
          email,
          phone,
        }),
      });
    });
    studentProfileId = profile.id;
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

  if (await db.attendees.findExisting(sessionId, studentProfileId)) {
    return { error: "alreadyOnRoster" };
  }
  const student = await db.students.findById(studentProfileId);
  if (
    student &&
    (await isBlockedFromSession(db, session.classGroupId, session.teacherId, student.userId))
  ) {
    return { error: "studentBlocked" };
  }

  const attendanceResult = await writeAttendance(() =>
    createAttendance(prisma, {
      centerId,
      sessionId,
      studentProfileId,
      enrollmentId: null,
      isDropIn: true,
      status,
      recordedBy: ctx.user.id,
    }),
  );
  if (!attendanceResult.ok) return attendanceResult.error;

  await writeAuditLog({
    centerId,
    actorUserId: ctx.user.id,
    action: "student.create",
    entityType: "StudentProfile",
    entityId: studentProfileId,
    after: { linked: resolution.kind === "matched", dropIn: true, sessionId },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "created" };
}

// ── Payment (money-critical) ────────────────────────────────────────────────

export async function recordPaymentAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "payment.record")) return FORBIDDEN;

  const parsed = recordPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionAttendeeId, method } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    recordPayment(tx, ctx.center.id, sessionAttendeeId, method, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "payment.record",
    entityType: "Payment",
    entityId: result.payment.id,
    after: {
      amount: result.payment.amount,
      method: result.payment.method,
      centerShareSnapshot: result.payment.centerShareSnapshot,
      teacherShareSnapshot: result.payment.teacherShareSnapshot,
    },
  });

  revalidateSessionDetail(locale, result.payment.sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "saved" };
}

export async function voidPaymentAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "payment.void")) return FORBIDDEN;

  const parsed = voidPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, paymentId, reason } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    voidPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "payment.void",
    entityType: "Payment",
    entityId: result.payment.id,
    before: { amount: result.payment.amount, method: result.payment.method },
    after: { reason },
  });

  revalidateSessionDetail(locale, result.payment.sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "voided" };
}

/**
 * Cash back to the student, no balance created anywhere (M14, spec §4.1
 * item 12, §5 "Void vs. refund"). Never touches the original `Payment`
 * row's money fields — `lib/db/refunds.ts`'s `refundPayment` only flips
 * `Payment.refunded` and writes the reversal onto a new `Refund` row.
 */
export async function refundPaymentAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "payment.refund")) return FORBIDDEN;

  const parsed = refundPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, paymentId, reason } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    refundPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "payment.refund",
    entityType: "Payment",
    entityId: result.payment.id,
    before: { refunded: false },
    after: {
      refunded: true,
      amount: result.refund.amount,
      centerShareReversed: result.refund.centerShareReversed,
      teacherShareReversed: result.refund.teacherShareReversed,
      reason,
    },
  });

  // Any DRAFT/APPROVED settlement this payment was already claimed by just
  // had its total live-adjusted (lib/db/refunds.ts) — audited as its own
  // row, distinct from the refund itself (docs/00 §5 "Teacher settlements").
  for (const { settlement, previousTotal } of result.adjustedSettlements) {
    await writeAuditLog({
      centerId: ctx.center.id,
      actorUserId: ctx.user.id,
      action: "settlement.adjust",
      entityType: "Settlement",
      entityId: settlement.id,
      before: { totalAmount: previousTotal },
      after: { totalAmount: settlement.totalAmount, reason: "payment.refund", paymentId: result.payment.id },
    });
  }

  revalidateSessionDetail(locale, result.payment.sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "refunded" };
}

// ── Session lifecycle: cancel / reschedule (spec §7 acceptance criterion 11) ─

export async function cancelSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "session.cancel")) return FORBIDDEN;

  const parsed = cancelSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId } = parsed.data;

  const result = await cancelSession(prisma, ctx.center.id, sessionId);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.cancel",
    entityType: "Session",
    entityId: sessionId,
    before: { status: "SCHEDULED" },
    after: { status: "CANCELLED" },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "cancelled" };
}

export async function rescheduleSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = rescheduleSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, date, startTime, endTime } = parsed.data;

  const before = await prisma.session.findFirst({
    where: { centerId: ctx.center.id, id: sessionId },
    select: { date: true, startTime: true, endTime: true },
  });

  const result = await rescheduleSession(
    prisma,
    ctx.center.id,
    sessionId,
    { date, startTime, endTime },
    ctx.settings?.scheduleConflictPolicy ?? "WARN",
    locale,
  );
  if (!result.ok) return { error: result.error };

  // Reschedule creates a *new* Session (M15) — the original row is left in
  // place, linked via `rescheduledToId`, not mutated into the new date/time.
  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.reschedule",
    entityType: "Session",
    entityId: sessionId,
    before,
    after: { date: result.session.date, startTime, endTime, newSessionId: result.session.id },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionDetail(locale, result.session.id);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "rescheduled", conflicts: result.conflicts, newSessionId: result.session.id };
}

/**
 * Sets or clears this one session's centre-cut override (M13, spec §5.1
 * "Center cut" — "overridable per class and per session"). Money
 * configuration, so it is audited exactly like a class's own cut edit
 * (`classGroup.update` in `app/[locale]/(center)/classes/actions.ts`); it
 * never rewrites an already-recorded payment's frozen snapshots — only
 * `recordPayment`, called after this, ever reads it.
 */
export async function updateSessionShareOverrideAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = sessionShareOverrideSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, override } = parsed.data;

  const before = await prisma.session.findFirst({
    where: { centerId: ctx.center.id, id: sessionId },
    select: { centerShareType: true, centerShareValue: true },
  });
  if (!before) return NOT_FOUND;

  const result = await updateSessionShareOverride(prisma, ctx.center.id, sessionId, override);
  if (!result.ok) return NOT_FOUND;

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.shareOverride.update",
    entityType: "Session",
    entityId: sessionId,
    before,
    after: override,
  });

  revalidateSessionDetail(locale, sessionId);
  return { status: "shareUpdated" };
}

