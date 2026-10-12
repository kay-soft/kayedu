"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import {
  changeAttendanceStatus,
  createAttendance,
  findAttendee,
  SessionClosedError,
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
import { closeSession, WRITE_TRANSACTION_OPTIONS } from "@/lib/db/session-lifecycle";
import type { AdjustedSettlement } from "@/lib/db/settlements";
import {
  cancelSession,
  rescheduleSession,
  updateSessionShareOverride,
} from "@/lib/db/sessions";
import { claimStudentCode, studentSearchWhere } from "@/lib/db/students";
import { scopedData } from "@/lib/db/tenant-scope";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  addExistingAttendeeSchema,
  addNewAttendeeSchema,
  cancelSessionSchema,
  checkInRosterSchema,
  endSessionSchema,
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
 * Attendance: a first-time mark on a roster row is a check-in,
 * `attendance.record` (RECEPTIONIST's baseline), whose PRESENT/LATE status
 * the data layer decides from the clock (R2 — no status picker anywhere);
 * changing an already-marked row is `attendance.correct` (Owner/Manager, or a
 * granted receptionist), allowed only while the session is live, and is
 * always audited (spec §5 "Attendance"). Switching a paid student to ABSENT
 * voids their payment in the same transaction and needs `payment.void` too.
 *
 * Closed sessions (R2) refuse every write here by the data layer's own guard
 * (lib/db/session-lifecycle.ts) — the refusal comes back as the same
 * `{ error }` shape, `sessionClosed`, never a generic failure.
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

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

/**
 * Candidates for "add student to this session's roster" — a student not
 * already enrolled or already on the roster. Bound to `sessionId` via
 * `.bind(null, session.id)`. Selecting a result re-navigates to this same
 * session page with `?q=<exact student code>`, reusing the existing
 * candidate-rendering (`AddAttendeePanel`) unchanged.
 */
export async function searchAddAttendeeCandidatesAction(
  sessionId: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const { ctx, db } = await sessionScope();
  if (!ctxCan(ctx, "attendance.record")) return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const session = await db.sessions.findDetailById(sessionId);
  if (!session) return [];

  const enrollments = await db.enrollments.listForClass(session.classGroupId);
  const rosterIds = new Set<string>([
    ...enrollments
      .filter((enrollment) => enrollment.status === "ACTIVE")
      .map((enrollment) => enrollment.studentProfileId),
    ...session.attendees
      .filter((attendee): attendee is typeof attendee & { studentProfileId: string } =>
        Boolean(attendee.studentProfileId),
      )
      .map((attendee) => attendee.studentProfileId),
  ]);

  const rows = await db.students.search({
    where: {
      ...studentSearchWhere(trimmed),
      active: true,
      ...(rosterIds.size > 0 ? { NOT: { id: { in: [...rosterIds] } } } : {}),
    },
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: `${ROUTES.centerSession(sessionId)}?q=${encodeURIComponent(row.studentCode)}`,
  }));
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

/** Every `settlement.adjust` row a void's live adjustment owes (docs/00 §5). */
async function auditSettlementAdjustments(
  ctx: TenantContext,
  adjusted: AdjustedSettlement[],
  reason: "payment.void" | "payment.refund",
  paymentId: string,
): Promise<void> {
  for (const { settlement, previousTotal } of adjusted) {
    await writeAuditLog({
      centerId: ctx.center.id,
      actorUserId: ctx.user.id,
      action: "settlement.adjust",
      entityType: "Settlement",
      entityId: settlement.id,
      before: { totalAmount: previousTotal },
      after: { totalAmount: settlement.totalAmount, reason, paymentId },
    });
  }
}

// ── Check in an enrolled roster row (first mark) ───────────────────────────

/**
 * The roster's "Check in" button on an unmarked enrolled student — the same
 * `createAttendance` every check-in surface calls, which decides PRESENT vs
 * LATE itself (R2). There is no client-chosen status.
 */
export async function checkInRosterAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx, db } = await sessionScope();
  if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;

  const parsed = checkInRosterSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId, studentProfileId } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  if (await findAttendee(prisma, ctx.center.id, sessionId, studentProfileId)) {
    return { error: "alreadyOnRoster" };
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
      recordedBy: ctx.user.id,
    }),
  );
  if (!result.ok) return result.error;

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "saved" };
}

// ── Correct attendance on an already-marked roster row (live only) ─────────

/**
 * `attendance.correct` on a live session (R2). Every real change writes a
 * `SessionAttendanceChange` row plus the `attendance.correct` audit row.
 * PRESENT/LATE → ABSENT on a student holding an active payment voids that
 * payment in the same transaction — it needs `payment.void` as well, and an
 * explicit `confirmVoid` from the roster's confirmation dialog (which says
 * plainly that the payment will be voided); the void adds its own
 * `payment.void` audit row. All of it is written by `changeAttendanceStatus`
 * inside one transaction. The reason is optional.
 */
export async function setAttendanceAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx, db } = await sessionScope();
  if (!ctxCan(ctx, "attendance.correct")) return FORBIDDEN;

  const parsed = setAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, studentProfileId, status, reason, confirmVoid } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const existing = await findAttendee(prisma, ctx.center.id, sessionId, studentProfileId);
  if (!existing) return { error: "notCheckedIn" };
  if (existing.attendanceStatus === status) return { status: "saved" };

  const mayVoidPayment = ctxCan(ctx, "payment.void");
  if (status === "ABSENT") {
    const activePayment = await prisma.payment.findFirst({
      where: { centerId: ctx.center.id, sessionAttendeeId: existing.id, voided: false, refunded: false },
      select: { id: true },
    });
    if (activePayment && !mayVoidPayment) return FORBIDDEN;
    if (activePayment && !confirmVoid) return { error: "voidConfirmationRequired" };
  }

  const result = await changeAttendanceStatus(prisma, {
    centerId: ctx.center.id,
    attendeeId: existing.id,
    status,
    changedBy: ctx.user.id,
    reason,
    mayVoidPayment,
  });
  if (!result.ok) {
    return result.error === "voidNotPermitted" ? FORBIDDEN : { error: result.error };
  }
  // The change row and its audit rows (`attendance.correct`, and
  // `payment.void`/`settlement.adjust` when a payment was voided) were
  // written by `changeAttendanceStatus` in the same transaction as the change.

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: result.voidedPayment ? "voided" : "saved" };
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
  const { locale, sessionId, studentProfileId } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

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

  const { locale, sessionId, firstName, lastName, email, phone, linkUserId } =
    parsed.data;
  const centerId = ctx.center.id;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;

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
  const { locale, sessionAttendeeId, paymentMethodId } = parsed.data;

  // The method is resolved inside the transaction, scoped to this centre and
  // to active methods only — a forged or stale id is refused there.
  const result = await prisma.$transaction(
    (tx) => recordPayment(tx, ctx.center.id, sessionAttendeeId, paymentMethodId, ctx.user.id),
    WRITE_TRANSACTION_OPTIONS,
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
      paymentMethodId: result.payment.paymentMethodId,
      methodLabelSnapshot: result.payment.methodLabelSnapshot,
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

  const result = await prisma.$transaction(
    (tx) => voidPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id),
    WRITE_TRANSACTION_OPTIONS,
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "payment.void",
    entityType: "Payment",
    entityId: result.payment.id,
    before: {
      amount: result.payment.amount,
      methodLabelSnapshot: result.payment.methodLabelSnapshot,
    },
    after: { reason },
  });
  // A void inside a pre-R2 DRAFT/APPROVED settlement's counted total
  // live-adjusts it (lib/db/settlements.ts) — audited like a refund's.
  await auditSettlementAdjustments(ctx, result.adjustedSettlements, "payment.void", result.payment.id);

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

  const result = await prisma.$transaction(
    (tx) => refundPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id),
    WRITE_TRANSACTION_OPTIONS,
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
  await auditSettlementAdjustments(ctx, result.adjustedSettlements, "payment.refund", result.payment.id);

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

/**
 * "End session" (R2) — `session.close`, audited as `session.close`. Closing
 * is irreversible: attendance and money lock for good and every enrolled
 * student with no roster row is marked ABSENT by the system. Refused on a
 * cancelled/rescheduled session, an already-closed one, and one that has
 * not started. Exposed for reuse — the reception desk's own "End session"
 * button is R7's, and calls this same action.
 */
export async function endSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const { ctx } = await sessionScope();
  if (!ctxCan(ctx, "session.close")) return FORBIDDEN;

  const parsed = endSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId } = parsed.data;

  const result = await closeSession(prisma, ctx.center.id, sessionId, { closedBy: ctx.user.id });
  if (!result.ok) {
    revalidateSessionDetail(locale, sessionId);
    return { error: result.error };
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.close",
    entityType: "Session",
    entityId: sessionId,
    before: { closedAt: null },
    after: {
      status: result.session.status,
      closeMode: result.session.closeMode,
      closedAt: result.session.closedAt,
      absentCreated: result.absentCreated,
    },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "closed" };
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
  if (!result.ok) return result.error === "sessionClosed" ? { error: "sessionClosed" } : NOT_FOUND;

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

