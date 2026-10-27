"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { PICK_BRANCH, isPickBranch, requireBranchScope, type PickBranch } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import {
  changeAttendanceStatus,
  createAttendance,
  findAttendee,
  isStudentBlockedFromSession,
  SessionClosedError,
} from "@/lib/db/attendance";
import { writeAuditLog } from "@/lib/db/audit";
import {
  createManualSession,
  createOneOffSession,
  deleteManualSession,
  type CreateManualSessionResult,
} from "@/lib/db/class-sessions";
import { prisma } from "@/lib/db/client";
import {
  createPerson,
  describeMatch,
  resolveContact,
  seedLocalName,
} from "@/lib/db/identity";
import { recordPayment, voidPayment, writePaymentRecordAudit } from "@/lib/db/payments";
import { refundPayment } from "@/lib/db/refunds";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { closeSession, WRITE_TRANSACTION_OPTIONS } from "@/lib/db/session-lifecycle";
import type { AdjustedSettlement } from "@/lib/db/settlements";
import {
  cancelSession,
  rescheduleSession,
  updateSessionRooms,
  updateSessionShareOverride,
  type DatedConflict,
} from "@/lib/db/sessions";
import { describeConflicts } from "@/lib/db/slot-conflicts";
import { claimStudentCode, studentSearchWhere } from "@/lib/db/students";
import { signedUrlFor } from "@/lib/db/storage";
import { scopedData } from "@/lib/db/tenant-scope";
import { fullName, localName } from "@/lib/identity";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { AVATARS_BUCKET } from "@/lib/storage-paths";
import { storageConfigured } from "@/lib/storage";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  addNewAttendeeSchema,
  cancelSessionSchema,
  deleteSessionSchema,
  endSessionSchema,
  newClassSessionSchema,
  newOneOffSessionSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  rescheduleSessionSchema,
  sessionRoomsSchema,
  sessionShareOverrideSchema,
  setAttendanceSchema,
  voidPaymentSchema,
  type SessionActionState,
} from "@/lib/validation/sessions";
import { boundSearchArgs, parseActionArgs } from "@/lib/validation/action-args";

/**
 * Session roster, attendance and payment actions (M5 — the daily loop).
 * Every action follows docs/02 §7: getTenantContext() → permission check →
 * zod → scoped write → audit if sensitive → revalidate.
 *
 * Attendance: a first-time mark is a check-in, `attendance.record`
 * (RECEPTIONIST's baseline), whose PRESENT/LATE status the data layer decides
 * from the clock (R2 — no status picker anywhere). T2: an existing student's
 * check-in is reception's `checkInAction`, reached from the session page's
 * confirm panel — this file keeps only the new-student registration, which
 * checks its person in as a drop-in itself;
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

async function sessionScope(): Promise<Scope | PickBranch> {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  return { ctx, db: scoped(ctx) };
}

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

/**
 * Candidates for "add student to this session's roster" — a student not
 * already enrolled or already on the roster. Selecting a result (T2) opens
 * reception's confirm panel on the session page — `photoUrl` is the signed
 * photo that panel shows (the anti-impersonation control, spec §5.1); `href`
 * is only the no-JavaScript fallback (`?q=<exact student code>`).
 */
export async function searchAddAttendeeCandidatesAction(
  sessionId: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return [];
  const { ctx, db } = scope;
  if (!ctxCan(ctx, "attendance.record")) return [];
  const args = parseActionArgs(boundSearchArgs, [sessionId, query]);
  if (!args) return [];
  const [validSessionId, trimmed] = args;
  if (trimmed.length < 2) return [];

  const session = await db.sessions.findDetailById(validSessionId);
  if (!session) return [];

  // A one-time session (R5) has no class, so nobody is enrolled in it.
  const enrollments = session.classGroupId ? await db.enrollments.listForClass(session.classGroupId) : [];
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

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      primary: fullName(localName(row, row.user)),
      secondary: row.studentCode,
      href: `${ROUTES.centerSession(sessionId)}?q=${encodeURIComponent(row.studentCode)}`,
      photoUrl:
        row.photoUrl && storageConfigured()
          ? await signedUrlFor(ctx.center.id, AVATARS_BUCKET, row.photoUrl)
          : null,
    })),
  );
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

/**
 * Every `settlement.adjust` row a void's or refund's live adjustment owes
 * (docs/00 §5) — on the money transaction's own client (SEC-60).
 */
async function auditSettlementAdjustments(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  adjusted: AdjustedSettlement[],
  trigger: "payment.void" | "payment.refund",
  paymentId: string,
): Promise<void> {
  for (const { settlement, previousTotal } of adjusted) {
    await writeAuditLog(
      {
        centerId: ctx.center.id,
        actorUserId: ctx.user.id,
        action: "settlement.adjust",
        entityType: "Settlement",
        entityId: settlement.id,
        before: { totalAmount: previousTotal },
        after: { totalAmount: settlement.totalAmount, trigger, paymentId },
      },
      tx,
    );
  }
}

// ── First-time check-in ─────────────────────────────────────────────────────
//
// There is no check-in action in this file (T2). Every first-time mark — the
// roster's Check in button, an existing student found by search — goes through
// reception's `checkInAction` (`app/[locale]/(center)/reception/actions.ts`)
// after the session page's confirm panel: one function writes the attendance
// and the payment, and nothing is written before its confirm. The only first-
// time mark made here is `addNewAttendeeAction` below, a registration form that
// is its own confirm.

// ── Correct attendance on an already-marked roster row (live only) ─────────

/**
 * `attendance.correct` on a live session (R2). Every real change writes a
 * `SessionAttendanceChange` row plus the `attendance.correct` audit row.
 * PRESENT/LATE → ABSENT on a student holding an active payment voids that
 * payment in the same transaction — it needs `payment.void` as well, and an
 * explicit `confirmVoid` from the roster's confirmation dialog (which says
 * plainly that the payment will be voided); the void adds its own
 * `payment.void` audit row. All of it is written by `changeAttendanceStatus`
 * inside one transaction. **A change that voids a payment needs a reason**
 * (SEC-2b, D-13) — zod, this action and the data layer each refuse one
 * without; a change that voids nothing keeps it optional.
 */
export async function setAttendanceAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx, db } = scope;
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
    const activePayment = await db.payments.findActiveForAttendee(existing.id);
    if (activePayment && !mayVoidPayment) return FORBIDDEN;
    if (activePayment && !confirmVoid) return { error: "voidConfirmationRequired" };
    if (activePayment && !reason) return { fieldErrors: { reason: "reasonRequired" } };
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
    if (result.error === "voidNotPermitted") return FORBIDDEN;
    if (result.error === "reasonRequired") return { fieldErrors: { reason: "reasonRequired" } };
    return { error: result.error };
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
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx, db } = scope;
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
  const resolution = await resolveContact(
    { centerId, actorUserId: ctx.user.id, adding: "student" },
    contact,
  );
  if (resolution.kind === "rateLimited") return { error: "rateLimited" };
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  let userId: string | null = null;
  let described: Awaited<ReturnType<typeof describeMatch>> | null = null;
  if (resolution.kind === "matched") {
    const match = await describeMatch(centerId, resolution.match, contact);
    described = match;
    if (linkUserId !== resolution.match.user.id) {
      return { status: "matchFound", match };
    }
    // Already a student here: reuse that profile (below). Anyone else must be
    // linkable (SEC-2a, D-01/D-02) — a phone alone never attaches a record.
    if (!match.linkable && match.existingHere !== "student") {
      return { error: "matchGone" };
    }
    userId = resolution.match.user.id;
  } else if (linkUserId) {
    return { error: "matchGone" };
  }

  const name = seedLocalName(resolution, { firstName, lastName }, described);

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
    (await isStudentBlockedFromSession(prisma, ctx.center.id, session, student.userId))
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
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
  if (!ctxCan(ctx, "payment.record")) return FORBIDDEN;

  const parsed = recordPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionAttendeeId, paymentMethodId } = parsed.data;

  // The method is resolved inside the transaction, scoped to this centre and
  // to active methods only — a forged or stale id is refused there. The audit
  // row commits with the payment or not at all (SEC-60).
  const result = await prisma.$transaction(async (tx) => {
    const recorded = await recordPayment(tx, ctx.center.id, sessionAttendeeId, paymentMethodId, ctx.user.id);
    if (recorded.ok) await writePaymentRecordAudit(tx, ctx.center.id, ctx.user.id, recorded.payment);
    return recorded;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

  revalidateSessionDetail(locale, result.payment.sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "saved" };
}

export async function voidPaymentAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
  if (!ctxCan(ctx, "payment.void")) return FORBIDDEN;

  const parsed = voidPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, paymentId, reason } = parsed.data;

  // The reason lives on the payment row; the audit row carries ids and the
  // amount only (D-20), and commits with the void (SEC-60).
  const result = await prisma.$transaction(async (tx) => {
    const voided = await voidPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id);
    if (!voided.ok) return voided;
    await writeAuditLog(
      {
        centerId: ctx.center.id,
        actorUserId: ctx.user.id,
        action: "payment.void",
        entityType: "Payment",
        entityId: voided.payment.id,
        before: { amount: voided.payment.amount, voided: false },
        after: { voided: true, sessionId: voided.payment.sessionId },
      },
      tx,
    );
    // A void inside a pre-SEC-2b DRAFT/APPROVED settlement's counted total
    // live-adjusts it (lib/db/settlements.ts) — audited like a refund's.
    await auditSettlementAdjustments(tx, ctx, voided.adjustedSettlements, "payment.void", voided.payment.id);
    return voided;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

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
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
  if (!ctxCan(ctx, "payment.refund")) return FORBIDDEN;

  const parsed = refundPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, paymentId, reason } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const refunded = await refundPayment(tx, ctx.center.id, paymentId, reason, ctx.user.id);
    if (!refunded.ok) return refunded;
    await writeAuditLog(
      {
        centerId: ctx.center.id,
        actorUserId: ctx.user.id,
        action: "payment.refund",
        entityType: "Payment",
        entityId: refunded.payment.id,
        before: { refunded: false },
        after: {
          refunded: true,
          refundId: refunded.refund.id,
          sessionId: refunded.payment.sessionId,
          amount: refunded.refund.amount,
          centerShareReversed: refunded.refund.centerShareReversed,
          teacherShareReversed: refunded.refund.teacherShareReversed,
        },
      },
      tx,
    );
    // Any DRAFT/APPROVED settlement this payment was already claimed by just
    // had its total live-adjusted (lib/db/refunds.ts) — audited as its own
    // row, distinct from the refund itself (docs/00 §5 "Teacher settlements").
    await auditSettlementAdjustments(tx, ctx, refunded.adjustedSettlements, "payment.refund", refunded.payment.id);
    return refunded;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

  revalidateSessionDetail(locale, result.payment.sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return { status: "refunded" };
}

// ── Session lifecycle: cancel / reschedule (spec §7 acceptance criterion 11) ─

/**
 * Cancel (M10) — refused while the session holds an active payment
 * (`hasPayments`, SEC-2b D-07): staff void or refund first, each with its
 * reason. A cancelled session closes at the end of its day.
 */
export async function cancelSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
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
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
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

/** How many conflicts a form is shown — enough to act on, never a wall. */
const MAX_SHOWN_CONFLICTS = 30;

/** Conflicts → the print-ready list a form shows (R3, `SlotConflictNotice`). */
async function shownConflicts(ctx: TenantContext, conflicts: DatedConflict[]) {
  return conflicts.length > 0
    ? describeConflicts(prisma, ctx.center.id, conflicts.slice(0, MAX_SHOWN_CONFLICTS))
    : undefined;
}

const ROOM_SET_ERRORS = new Set([
  "noPrimary",
  "roomNotFound",
  "roomInactive",
  "notLinked",
  "extraIsPrimary",
  "duplicateExtra",
]);

/** A room-set refusal (R3) → the field it belongs to. */
function roomSetFieldErrors(error: string): SessionActionState {
  if (error === "noPrimary") return { fieldErrors: { roomId: "roomRequired" } };
  if (error === "roomNotFound" || error === "roomInactive") {
    return { fieldErrors: { roomId: error } };
  }
  return { fieldErrors: { extraRoomIds: error } };
}

/**
 * Reschedule (M15) — R3: the replacement takes the original's room set
 * unless the form picks another valid one, and the whole window is
 * re-checked. A conflict is refused with the list (DENY always; WARN until
 * `confirmConflicts`), and a confirmed one is audited by the data layer.
 */
export async function rescheduleSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx, db } = scope;
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = rescheduleSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, date, startTime, endTime, roomId, extraRoomIds, confirmConflicts } =
    parsed.data;

  const before = await db.sessions.findForEdit(sessionId);

  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  const result = await rescheduleSession(
    prisma,
    ctx.center.id,
    sessionId,
    { date, startTime, endTime, roomId, extraRoomIds },
    policy,
    locale,
    { confirmConflicts, actorUserId: ctx.user.id },
  );
  if (!result.ok) {
    if ("conflicts" in result) {
      return {
        error: result.error,
        conflicts: await shownConflicts(ctx, result.conflicts),
        conflictPolicy: policy,
      };
    }
    if (ROOM_SET_ERRORS.has(result.error)) return roomSetFieldErrors(result.error);
    return { error: result.error };
  }

  // Reschedule creates a *new* Session (M15) — the original row is left in
  // place, linked via `rescheduledToId`, not mutated into the new date/time.
  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.reschedule",
    entityType: "Session",
    entityId: sessionId,
    before: before
      ? { date: before.date, startTime: before.startTime, endTime: before.endTime, roomId: before.roomId }
      : null,
    after: {
      date: result.session.date,
      startTime,
      endTime,
      roomId: result.session.roomId,
      newSessionId: result.session.id,
    },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionDetail(locale, result.session.id);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return {
    status: "rescheduled",
    conflicts: await shownConflicts(ctx, result.conflicts),
    conflictPolicy: policy,
    newSessionId: result.session.id,
  };
}

/**
 * Changes the room set of this one session (R3) — never its class, so the
 * class's enrolment cap is untouched. Same permission as reschedule
 * (`session.manage`), same combination rule, same conflict contract.
 */
export async function updateSessionRoomsAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx, db } = scope;
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = sessionRoomsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, roomId, extraRoomIds, confirmConflicts } = parsed.data;

  const before = await db.sessions.findForEdit(sessionId);
  if (!before) return NOT_FOUND;

  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  const result = await updateSessionRooms(
    prisma,
    ctx.center.id,
    sessionId,
    { roomId, extraRoomIds },
    policy,
    locale,
    { confirmConflicts, actorUserId: ctx.user.id },
  );
  if (!result.ok) {
    if ("conflicts" in result) {
      return {
        error: result.error,
        conflicts: await shownConflicts(ctx, result.conflicts),
        conflictPolicy: policy,
      };
    }
    if (ROOM_SET_ERRORS.has(result.error)) return roomSetFieldErrors(result.error);
    return { error: result.error };
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.rooms.update",
    entityType: "Session",
    entityId: sessionId,
    before: {
      roomId: before.roomId,
      extraRoomIds: before.extraRooms.map((extra) => extra.roomId),
    },
    after: { roomId, extraRoomIds: roomId ? extraRoomIds : [] },
  });

  revalidateSessionDetail(locale, sessionId);
  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  return {
    status: "roomsUpdated",
    conflicts: await shownConflicts(ctx, result.conflicts),
    conflictPolicy: policy,
  };
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
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx, db } = scope;
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = sessionShareOverrideSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, override } = parsed.data;

  const before = await db.sessions.findForEdit(sessionId);
  if (!before) return NOT_FOUND;

  const result = await updateSessionShareOverride(prisma, ctx.center.id, sessionId, override);
  if (!result.ok) {
    if (result.error === "sessionClosed" || result.error === "cutRequired") return { error: result.error };
    return NOT_FOUND;
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "session.shareOverride.update",
    entityType: "Session",
    entityId: sessionId,
    before: { centerShareType: before.centerShareType, centerShareValue: before.centerShareValue },
    after: override,
  });

  revalidateSessionDetail(locale, sessionId);
  return { status: "shareUpdated" };
}

// ── New session: an extra session on a class, or a one-time one (R5) ──────

/** Which form field a manual-session refusal belongs to. */
const NEW_SESSION_FIELD_ERRORS: Record<string, string> = {
  pastDate: "date",
  invalidTimeRange: "endTime",
  classNotFound: "classGroupId",
  teacherNotFound: "teacherId",
  teacherRequired: "teacherId",
  subjectNotFound: "subjectId",
  gradeNotFound: "gradeId",
  invalidTitle: "title",
  titleRequired: "title",
  invalidPrice: "price",
  priceRequired: "price",
  invalidCut: "shareValue",
  cutRequired: "shareValue",
};

/**
 * "New session" on the Sessions tab (R5) — `session.manage`, the same matrix
 * action that gates reschedule and a session's rooms; no new role check.
 * Two modes (the dialog's segmented control posts `mode`): **for a class**
 * (`lib/db/class-sessions.ts`'s `createManualSession` — price and cut stay
 * the class's) or **one-time** (`createOneOffSession` — its own title,
 * price and cut). Both refuse a past date by the centre's clock, take the
 * R3 confirmation contract (the refusal carries the conflict list), and
 * write their own `session.create` audit row in the same transaction.
 */
export async function createSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const raw = Object.fromEntries(formData);
  const centerId = ctx.center.id;
  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  let locale: string;
  let result: CreateManualSessionResult;

  if (raw.mode === "oneOff") {
    const parsed = newOneOffSessionSchema.safeParse(raw);
    if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
    const value = parsed.data;
    locale = value.locale;
    result = await createOneOffSession(
      prisma,
      centerId,
      {
        title: value.title,
        subjectId: value.subjectId,
        gradeId: value.gradeId,
        teacherId: value.teacherId,
        roomId: value.roomId,
        extraRoomIds: value.extraRoomIds,
        date: value.date,
        startTime: value.startTime,
        endTime: value.endTime,
        price: value.price,
        centerShareType: value.centerShareType,
        centerShareValue: value.centerShareValue,
      },
      { confirmConflicts: value.confirmConflicts, actorUserId: ctx.user.id, locale },
    );
  } else {
    const parsed = newClassSessionSchema.safeParse(raw);
    if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
    const value = parsed.data;
    locale = value.locale;
    result = await createManualSession(
      prisma,
      centerId,
      {
        classGroupId: value.classGroupId,
        teacherId: value.teacherId,
        roomId: value.roomId,
        extraRoomIds: value.extraRoomIds,
        date: value.date,
        startTime: value.startTime,
        endTime: value.endTime,
      },
      { confirmConflicts: value.confirmConflicts, actorUserId: ctx.user.id, locale },
    );
  }

  if (!result.ok) {
    if ("conflicts" in result) {
      return {
        error: result.error,
        conflicts: await shownConflicts(ctx, result.conflicts),
        conflictPolicy: policy,
      };
    }
    if (ROOM_SET_ERRORS.has(result.error)) return roomSetFieldErrors(result.error);
    const field = NEW_SESSION_FIELD_ERRORS[result.error];
    if (field) return { fieldErrors: { [field]: result.error } };
    return { error: result.error };
  }

  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  revalidatePath(`/${locale}${ROUTES.centerDashboard}`);
  return {
    status: "created",
    newSessionId: result.sessionId,
    conflicts: await shownConflicts(ctx, result.conflicts),
    conflictPolicy: policy,
  };
}

/**
 * Deletes a manual or one-time session (R5) — only one that has not started
 * and has nothing on it (`deleteManualSession` re-checks both under a row
 * lock and refuses by direct call otherwise; a closed session never
 * qualifies). Audited by the data layer as `session.delete`. The control
 * lives on the session's own page, so success leaves for the list (the M18
 * delete-redirect rule) rather than re-rendering a page that no longer exists.
 */
export async function deleteSessionAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const scope = await sessionScope();
  if (isPickBranch(scope)) return scope;
  const { ctx } = scope;
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;

  const parsed = deleteSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId } = parsed.data;

  const result = await deleteManualSession(prisma, ctx.center.id, sessionId, {
    actorUserId: ctx.user.id,
  });
  if (!result.ok) {
    revalidateSessionDetail(locale, sessionId);
    return { error: result.error };
  }

  revalidateSessionList(locale);
  revalidateReceptionDesk(locale);
  redirect({ href: ROUTES.centerSessions, locale });
  return { status: "deleted" };
}
