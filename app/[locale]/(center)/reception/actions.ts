"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import {
  createAttendance,
  findAttendee,
  isStudentBlockedFromSession,
  SessionClosedError,
} from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { recordPayment, writePaymentRecordAudit } from "@/lib/db/payments";
import {
  resolveStudentInput,
  studentSessionState,
  validateReceptionSession,
  type ReceptionSessionRefusal,
  type ReceptionStudent,
} from "@/lib/db/reception";
import { scoped } from "@/lib/db/scoped";
import { WRITE_TRANSACTION_OPTIONS } from "@/lib/db/session-lifecycle";
import { studentSearchWhere } from "@/lib/db/students";
import { signedUrlFor } from "@/lib/db/storage";
import { formatClockTime } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";
import { AVATARS_BUCKET } from "@/lib/storage-paths";
import { storageConfigured } from "@/lib/storage";
import {
  receptionCheckInSchema,
  type SessionActionState,
} from "@/lib/validation/sessions";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import {
  parseActionArgs,
  receptionInputArgs,
  receptionStudentArgs,
  searchArgs,
} from "@/lib/validation/action-args";

/**
 * Reception Desk (spec §4.1 item 8): search a student, pick today's session
 * and a payment method, and submit **one** action that checks the student in
 * and — only for PRESENT/LATE, per "attend = pay, or not counted" (spec §2
 * "Financial model", §5 "No debt") — records the payment in the same
 * request. There is no status picker (R2): `createAttendance` decides
 * PRESENT or LATE from the clock and the class's late threshold. A student
 * already on the roster keeps their mark — a correction is the roster's job,
 * live only — and only the payment is attempted. Both writes go through the exact same shared helpers
 * `app/[locale]/(center)/sessions/actions.ts` uses
 * (`lib/db/attendance.ts`, `lib/db/payments.ts`), so there is one attendance
 * write path and one money write path in the whole app, not two.
 *
 * R7 — **session mode**: staff pick one of today's sessions and scan or type
 * students into it. `resolveReceptionInputAction` / `resolveReceptionStudent-
 * Action` only READ (who is this, are they blocked, already in?); the scan
 * never records anything. The write is still `checkInAction`, reached by one
 * explicit confirm.
 */

const FORBIDDEN: SessionActionState = { error: "forbidden" };
const NOT_FOUND: SessionActionState = { error: "notFound" };

function revalidateReception(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerReception}`);
}

function revalidateAffectedSession(locale: string, sessionId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSession(sessionId)}`);
  revalidatePath(`/${locale}${ROUTES.centerSessions}`);
}

function timeZoneOf(ctx: TenantContext): string {
  return ctx.settings?.timezone ?? DEFAULT_TIMEZONE;
}

/** A refused session id → the `Sessions.errors` key the check-in form shows. */
const SESSION_REFUSAL_ERROR: Record<ReceptionSessionRefusal, string> = {
  notFound: "notFound",
  inactive: "notFound",
  notToday: "sessionNotToday",
  cancelled: "sessionCancelled",
  rescheduled: "sessionRescheduled",
  closed: "sessionClosed",
};

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────
// The QR/scan path bypasses this entirely — a scanned payload resolves
// straight to the selected-student panel via the plain form submit
// (`parseScannedStudentInput`, `app/[locale]/(center)/reception/page.tsx`), or
// in session mode through `resolveReceptionInputAction` below — not through
// this dropdown.

export async function searchStudentsForReceptionAction(
  query: string,
): Promise<TypeAheadResult[]> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "reception.use")) return [];
  const args = parseActionArgs(searchArgs, [query]);
  if (!args) return [];
  const [trimmed] = args;
  if (trimmed.length < 2) return [];

  const rows = await scoped(ctx).students.search({
    where: { ...studentSearchWhere(trimmed), active: true },
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: `${ROUTES.centerReception}?studentId=${row.id}`,
  }));
}

// ── Session mode: who is this, and can they be checked in? ──────────────────

/** What the confirm panel is shown — `ready` carries everything it renders. */
export type ReceptionResolution =
  | {
      kind: "ready";
      student: { id: string; name: string; code: string; photoUrl: string | null };
      /** Actively enrolled in the session's class; otherwise a drop-in. */
      enrolled: boolean;
      /** F6 — booked this session online: "Booked" instead of Drop-in. */
      booked: boolean;
    }
  | { kind: "candidates"; students: { id: string; name: string; code: string }[] }
  | { kind: "already"; name: string; time: string; status: "PRESENT" | "LATE" | "ABSENT" }
  | { kind: "blocked"; name: string }
  | { kind: "inactive"; name: string }
  | { kind: "notFound" }
  | { kind: "otherBranch" }
  | { kind: "unreadable" }
  | { kind: "empty" }
  | { kind: "sessionInvalid"; reason: ReceptionSessionRefusal }
  | { kind: "forbidden" };

const MAX_INPUT_LENGTH = 200;

async function describeStudent(
  ctx: TenantContext,
  session: Extract<Awaited<ReturnType<typeof validateReceptionSession>>, { ok: true }>["session"],
  student: ReceptionStudent,
  locale: string,
): Promise<ReceptionResolution> {
  const state = await studentSessionState(prisma, {
    centerId: ctx.center.id,
    session,
    student,
  });
  if (state.outcome === "blocked") return { kind: "blocked", name: student.name };
  if (state.outcome === "already") {
    return {
      kind: "already",
      name: student.name,
      time: formatClockTime(state.recordedAt, locale, timeZoneOf(ctx)),
      status: state.status,
    };
  }
  // The anti-impersonation control the static QR decision rests on (spec §5.1
  // "Check-in & the QR payload"): the photo is shown for a human to compare.
  const photoUrl =
    student.photoPath && storageConfigured()
      ? await signedUrlFor(ctx.center.id, AVATARS_BUCKET, student.photoPath)
      : null;
  return {
    kind: "ready",
    student: { id: student.id, name: student.name, code: student.code, photoUrl },
    enrolled: state.enrolled,
    booked: state.booked,
  };
}

async function sessionModeScope(sessionId: string) {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "reception.use") || !ctxCan(ctx, "attendance.record")) {
    return { ok: false as const, resolution: { kind: "forbidden" } satisfies ReceptionResolution };
  }
  // Re-validated on EVERY request: the id in the URL is untrusted input.
  const check = await validateReceptionSession(prisma, {
    centerId: ctx.center.id,
    sessionId,
    timeZone: timeZoneOf(ctx),
    now: new Date(),
  });
  if (!check.ok) {
    return {
      ok: false as const,
      resolution: { kind: "sessionInvalid", reason: check.reason } satisfies ReceptionResolution,
    };
  }
  return { ok: true as const, ctx, session: check.session };
}

/** A scan or a typed value, in session mode. Reads only — a scan never records money. */
export async function resolveReceptionInputAction(
  sessionId: string,
  raw: string,
  locale: string,
): Promise<ReceptionResolution> {
  const args = parseActionArgs(receptionInputArgs, [sessionId, raw, locale]);
  if (!args) return { kind: "notFound" };
  const [validSessionId, input, validLocale] = args;
  const scope = await sessionModeScope(validSessionId);
  if (!scope.ok) return scope.resolution;
  const { ctx, session } = scope;

  const resolved = await resolveStudentInput(prisma, {
    centerId: ctx.center.id,
    raw: input.slice(0, MAX_INPUT_LENGTH),
  });

  switch (resolved.kind) {
    case "student":
      return describeStudent(ctx, session, resolved.student, validLocale);
    case "inactive":
      return { kind: "inactive", name: resolved.student.name };
    case "candidates":
      return {
        kind: "candidates",
        students: resolved.students.map(({ id, name, code }) => ({ id, name, code })),
      };
    default:
      return resolved;
  }
}

/** A student picked from the suggestions or the candidate list, in session mode. */
export async function resolveReceptionStudentAction(
  sessionId: string,
  studentProfileId: string,
  locale: string,
): Promise<ReceptionResolution> {
  const args = parseActionArgs(receptionStudentArgs, [sessionId, studentProfileId, locale]);
  if (!args) return { kind: "notFound" };
  const [validSessionId, validStudentId, validLocale] = args;
  const scope = await sessionModeScope(validSessionId);
  if (!scope.ok) return scope.resolution;
  const { ctx, session } = scope;

  const row = await prisma.studentProfile.findFirst({
    where: { id: validStudentId, centerId: ctx.center.id },
    include: { user: true },
  });
  if (!row) return { kind: "notFound" };
  const student: ReceptionStudent = {
    id: row.id,
    userId: row.userId,
    name: fullName(localName(row, row.user)),
    code: row.studentCode,
    photoPath: row.photoUrl,
    active: row.active,
  };
  if (!student.active) return { kind: "inactive", name: student.name };
  return describeStudent(ctx, session, student, validLocale);
}

// ── The check-in itself (unchanged path: attendance + payment) ──────────────

export async function checkInAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "reception.use")) return FORBIDDEN;
  const db = scoped(ctx);
  const centerId = ctx.center.id;

  const parsed = receptionCheckInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId, studentProfileId, paymentMethodId } = parsed.data;

  // R7: the desk only ever checks in to *today's* open sessions of this
  // centre — re-checked here for every submit, not just hidden in the UI.
  const check = await validateReceptionSession(prisma, {
    centerId,
    sessionId,
    timeZone: timeZoneOf(ctx),
    now: new Date(),
  });
  if (!check.ok) return { error: SESSION_REFUSAL_ERROR[check.reason] };
  const session = check.session;

  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  let attendee = await findAttendee(prisma, centerId, sessionId, studentProfileId);
  let alreadyCheckedIn = attendee !== null;

  if (!attendee) {
    if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;
    // A blocked student (either scope) is refused before anything is written.
    if (await isStudentBlockedFromSession(prisma, centerId, session, student.userId)) {
      return { error: "studentBlocked" };
    }
    // A one-time session (R5) has no class: everyone is a drop-in.
    const enrollment = session.classGroupId
      ? await db.enrollments.findExisting(session.classGroupId, studentProfileId)
      : null;
    const active = enrollment?.status === "ACTIVE";
    try {
      attendee = await createAttendance(prisma, {
        centerId,
        sessionId,
        studentProfileId,
        enrollmentId: active ? enrollment!.id : null,
        isDropIn: !active,
        recordedBy: ctx.user.id,
      });
    } catch (error) {
      // Cancelled, rescheduled or closed session (M15/R2) — refused
      // server-side here too, not just hidden in the Reception UI.
      if (error instanceof SessionClosedError) return { error: error.reason };
      // Two desks scanned the same card at once: the unique (session, student)
      // key let one row in. The other is a duplicate — report it, never a 500.
      const raced = await findAttendee(prisma, centerId, sessionId, studentProfileId);
      if (!raced) throw error;
      attendee = raced;
      alreadyCheckedIn = true;
    }
  }

  // "Attend = pay, or not counted" — only PRESENT/LATE is ever payable
  // (lib/db/payments.ts `recordPayment` enforces this too, and refuses a
  // closed session on its own; this check just avoids an unnecessary
  // transaction when it plainly cannot apply).
  const payable = attendee.attendanceStatus === "PRESENT" || attendee.attendanceStatus === "LATE";
  if (paymentMethodId && payable) {
    if (!ctxCan(ctx, "payment.record")) return FORBIDDEN;

    // The audit row commits with the payment or not at all (SEC-60).
    const result = await prisma.$transaction(async (tx) => {
      const recorded = await recordPayment(tx, centerId, attendee.id, paymentMethodId, ctx.user.id);
      if (recorded.ok) await writePaymentRecordAudit(tx, centerId, ctx.user.id, recorded.payment);
      return recorded;
    }, WRITE_TRANSACTION_OPTIONS);

    if (!result.ok && result.error !== "alreadyPaid") {
      // "alreadyPaid" is fine to swallow — the check-in itself still
      // succeeded, they simply already have an active payment on file.
      revalidateReception(locale);
      revalidateAffectedSession(locale, sessionId);
      return { error: result.error };
    }
  }

  revalidateReception(locale);
  revalidateAffectedSession(locale, sessionId);
  return { status: "saved", attendanceStatus: attendee.attendanceStatus, alreadyCheckedIn };
}
