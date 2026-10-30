import type {
  ConflictPolicy,
  Prisma,
  PrismaClient,
  Role,
  SessionBookingMode,
  SessionStatus,
  ShareType,
} from "@prisma/client";

// Relative imports on purpose: `npm run check:class-periods` (and the seed)
// exercise this module directly, outside the Next.js runtime — the same
// reason lib/db/sessions.ts and lib/db/room-sets.ts are written this way
// (docs/02 §5). The Prisma client is injected, never imported.
import { MAX_PRICE_PIASTRES, centerCutError, type CenterCutError } from "../money.ts";
import { effectiveRoomIds } from "../rooms.ts";
import {
  DEFAULT_TIMEZONE,
  classPeriodError,
  dateKey,
  decideConflicts,
  findSessionConflicts,
  generateOccurrenceDates,
  parseTimeToMinutes,
  todayInTimezone,
  weeklySlotsError,
  zonedClock,
  type ClassPeriodError,
  type ExistingSession,
  type WeeklySlotsError,
} from "../scheduling.ts";
import { centerGradeById, centerSubjectById, isPairLinked } from "./catalog.ts";
import { resolveRoomSet, writeClassExtraRooms, writeSessionExtraRooms, type RoomSetError } from "./room-sets.ts";
import {
  cancelSession,
  oneOffSessionShapeError,
  type ConflictRefusal,
  type DatedConflict,
  type OneOffShapeError,
} from "./sessions.ts";
import { writeAuditRow } from "./audit-row.ts";

export type { ConflictRefusal, DatedConflict };
import type { PersonInput } from "./identity.ts";
import { sessionTimeZone, WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import {
  addTeacherMembership,
  isUniqueViolation,
  type TeacherMembershipResult,
  type TeacherRefusal,
} from "./teacher-membership.ts";
import type { MatchCandidate } from "../validation/people.ts";
import {
  loadSessionOccupancy,
  NOT_MOVED_SESSION,
  slotTakenError,
  writeConfirmedConflictAudit,
} from "./slot-conflicts.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * The class-sessions engine (R4, docs/02-architecture.md §11,
 * docs/00-master-product-spec.md §5.1 "Class periods and centre terms").
 * **The single owner of creating, re-fitting and removing a class's
 * sessions.** There is no rolling window and no generator: a class has a
 * period (`startDate`–`endDate`), and its sessions exist for every matching
 * `ClassSchedule` weekday in that period from now on, skipping the centre's
 * holiday calendar.
 *
 * - **Materialize** — a new class (or a reactivated one) gets every session
 *   from `max(startDate, today in the centre's timezone)` through `endDate`.
 *   An occurrence whose start time has already passed today is not created:
 *   a session that was never real would otherwise be auto-closed at the end
 *   of the day with every enrolled student marked Absent (R2).
 * - **Resync** — an edit to a class's slots, period, teacher or rooms
 *   re-fits its **future** sessions (not yet started). Only **pristine**
 *   sessions are touched (`sessionDisqualifiers` — nothing recorded on them
 *   and nothing customised, teacher and room set still the class's values
 *   before the edit): pristine ones that no longer match are deleted,
 *   matching ones take the new teacher/room set, missing dates are created.
 *   Everything else is left exactly as it is and **reported** as kept.
 * - **Conflicts are one decision for the whole range** (R3's contract):
 *   every session that would be created or re-roomed is checked against the
 *   centre's dated occupancy; DENY refuses the whole write, WARN refuses it
 *   with the full list unless `confirmConflicts`, then writes everything and
 *   audits the confirmed conflicts. No partial write, no "held back" state.
 *
 * - **Manual sessions** (R5) — an extra session on a class and a one-time
 *   session with no class are created and deleted here too
 *   (`createManualSession`, `createOneOffSession`, `deleteManualSession`),
 *   so every session delete in the codebase lives in this one module and
 *   passes through the pristine predicate. A manual session (`isManual`) is
 *   **never** pristine to the engine: no resync, period change, holiday or
 *   class edit deletes or rewrites it. Deactivating its class treats it by
 *   the normal rule (deleted if otherwise pristine, else cancelled).
 *
 * Every public write here takes `confirmConflicts` as a **required**
 * parameter (no default, no "missing means save") and runs in one
 * transaction with the class write that triggered it, so a refusal rolls
 * the class write back too. `@@unique([classGroupId, date, startTime])` on
 * `Session` stays as the idempotency backstop: re-running any of these with
 * nothing changed creates and deletes nothing.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const SCHEDULED: SessionStatus = "SCHEDULED";
const CANCELLED: SessionStatus = "CANCELLED";

// ── Inputs and results ─────────────────────────────────────────────────────

export type ClassSlot = { dayOfWeek: number; startTime: string; endTime: string };

/** The R3 confirmation contract, required on every write here (R4). */
export type ClassSessionsOptions = {
  confirmConflicts: boolean;
  actorUserId?: string | null;
  /** Injectable clock — the gate pins it; the app passes nothing. */
  now?: Date;
  /** Only labels a conflict for display. */
  locale?: string;
};

/** Why a future session is not pristine — each one keeps it out of a resync. */
export type SessionDisqualifier =
  | "notScheduled"
  | "closed"
  | "attendees"
  | "payments"
  | "settlement"
  | "ratings"
  /** F6 — a student holds a PENDING or CONFIRMED booking on it. */
  | "bookings"
  | "shareOverride"
  | "description"
  | "rescheduled"
  | "teacherChanged"
  | "roomsChanged"
  /** R5 — created by hand; the engine never deletes or rewrites it. */
  | "manual";

/** A future session a resync left alone, and why. */
export type KeptSession = {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  reasons: SessionDisqualifier[];
};

export type SessionSyncReport = {
  created: number;
  deleted: number;
  /** Pristine sessions that took the class's new teacher/room set. */
  updated: number;
  kept: KeptSession[];
  /** The conflicts that were confirmed (empty unless WARN + confirmed). */
  conflicts: DatedConflict[];
};

export type ClassPeriodRefusal = { ok: false; error: ClassPeriodError };

// ── The clock ──────────────────────────────────────────────────────────────

type CentreClock = { todayKey: string; today: Date; minutes: number };

async function centreScheduling(
  db: Db,
  centerId: string,
): Promise<{ timeZone: string; policy: ConflictPolicy }> {
  const settings = await db.centerSettings.findUnique({
    where: { centerId },
    select: { timezone: true, scheduleConflictPolicy: true },
  });
  return {
    timeZone: settings?.timezone ?? DEFAULT_TIMEZONE,
    policy: settings?.scheduleConflictPolicy ?? "WARN",
  };
}

function centreClock(now: Date, timeZone: string): CentreClock {
  const clock = zonedClock(now, timeZone);
  return { todayKey: clock.dayKey, today: todayInTimezone(timeZone, now), minutes: clock.minutes };
}

/** True once a session's start has come, in the centre's timezone. */
function hasStarted(session: { date: Date; startTime: string }, clock: CentreClock): boolean {
  const key = dateKey(session.date);
  if (key !== clock.todayKey) return key < clock.todayKey;
  return parseTimeToMinutes(session.startTime) <= clock.minutes;
}

// ── Pristine ───────────────────────────────────────────────────────────────

/** Everything `sessionDisqualifiers` reads, selected once. */
const SESSION_STATE_SELECT = {
  id: true,
  isManual: true,
  date: true,
  startTime: true,
  endTime: true,
  status: true,
  closedAt: true,
  teacherId: true,
  roomId: true,
  centerShareType: true,
  centerShareValue: true,
  description: true,
  rescheduledToId: true,
  rescheduledFrom: { select: { id: true } },
  extraRooms: { select: { roomId: true } },
  // D-14 — "has it started" is the session's own frozen timezone.
  timezone: true,
  _count: {
    select: {
      attendees: true,
      payments: true,
      settlements: true,
      ratings: true,
      bookings: { where: { status: { in: ["PENDING", "CONFIRMED"] } } },
    },
  },
} satisfies Prisma.SessionSelect;

type SessionState = Prisma.SessionGetPayload<{ select: typeof SESSION_STATE_SELECT }>;

type Baseline = { teacherId: string; roomIds: readonly string[] };

function sameRooms(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sessionRoomIds(session: SessionState): string[] {
  return effectiveRoomIds(session.roomId, session.extraRooms.map((extra) => extra.roomId));
}

/**
 * Why a future session may not be touched by a resync, deactivation or
 * holiday — empty = **pristine**. A session is pristine only when ALL hold:
 * SCHEDULED, not closed, no attendees, no payments, no settlement, no
 * ratings, no per-session share override, no description, not rescheduled
 * from or to, its teacher and room set still equal `baseline` (the class's
 * values before the edit), and — R5 — not created by hand (`isManual`) and —
 * F6 — no open (PENDING/CONFIRMED) booking, so a booked session is cancelled
 * (its bookings with it) rather than silently deleted. The one definition
 * every caller shares.
 */
export function sessionDisqualifiers(
  session: {
    /** Optional so a pure fixture predating R5 can omit it (= false). */
    isManual?: boolean;
    status: SessionStatus;
    closedAt: Date | null;
    teacherId: string;
    centerShareType: ShareType | null;
    centerShareValue: number | null;
    description: string | null;
    rescheduledToId: string | null;
    rescheduledFrom: { id: string } | null;
    /** `bookings` optional so a fixture predating F6 can omit it (= 0). */
    _count: { attendees: number; payments: number; settlements: number; ratings: number; bookings?: number };
  },
  roomIds: readonly string[],
  baseline: Baseline,
): SessionDisqualifier[] {
  const reasons: SessionDisqualifier[] = [];
  if (session.status !== SCHEDULED) reasons.push("notScheduled");
  if (session.closedAt) reasons.push("closed");
  if (session._count.attendees > 0) reasons.push("attendees");
  if (session._count.payments > 0) reasons.push("payments");
  if (session._count.settlements > 0) reasons.push("settlement");
  if (session._count.ratings > 0) reasons.push("ratings");
  if ((session._count.bookings ?? 0) > 0) reasons.push("bookings");
  if (session.centerShareType !== null || session.centerShareValue !== null) reasons.push("shareOverride");
  if (session.description !== null && session.description.trim() !== "") reasons.push("description");
  if (session.rescheduledToId || session.rescheduledFrom) reasons.push("rescheduled");
  if (session.teacherId !== baseline.teacherId) reasons.push("teacherChanged");
  if (!sameRooms(roomIds, baseline.roomIds)) reasons.push("roomsChanged");
  if (session.isManual) reasons.push("manual");
  return reasons;
}

/**
 * Nothing has happened on this session — the part of "pristine" every
 * delete shares (R5: including `deleteManualSession`): still SCHEDULED, not
 * closed, no attendee, payment, settlement or rating, no open booking (F6),
 * no reschedule link.
 * A closed session can therefore never match any session delete.
 */
const UNTOUCHED = {
  status: SCHEDULED,
  closedAt: null,
  rescheduledToId: null,
  rescheduledFrom: { is: null },
  attendees: { none: {} },
  payments: { none: {} },
  settlements: { none: {} },
  ratings: { none: {} },
  bookings: { none: { status: { in: ["PENDING", "CONFIRMED"] } } },
} satisfies Prisma.SessionWhereInput;

/** `UNTOUCHED`, and no per-session centre-cut override. */
const NO_OVERRIDE = {
  ...UNTOUCHED,
  centerShareType: null,
  centerShareValue: null,
} satisfies Prisma.SessionWhereInput;

/**
 * The database's own restatement of "pristine" (minus the teacher/room
 * comparison, already decided), re-asserted inside every engine delete. A
 * check-in or payment that lands between the classification and the delete
 * makes the row no longer match, so it is kept instead of being deleted
 * under it. R5: a manual session never matches.
 */
const STILL_PRISTINE = {
  ...NO_OVERRIDE,
  isManual: false,
} satisfies Prisma.SessionWhereInput;

/** A class's sessions that have not started yet, with their state. */
async function futureSessions(
  db: Db,
  centerId: string,
  classGroupId: string,
  clock: CentreClock,
): Promise<SessionState[]> {
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, { classGroupId, date: { gte: clock.today } }),
    select: SESSION_STATE_SELECT,
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  return rows.filter((row) => !hasStarted(row, clock));
}

// ── The plan ───────────────────────────────────────────────────────────────

/** What a class's sessions should look like after a write. */
export type ClassSessionPlan = {
  classGroupId: string;
  teacherId: string;
  roomId: string | null;
  extraRoomIds: string[];
  price: number;
  startDate: Date;
  endDate: Date;
  slots: ClassSlot[];
};

type Occurrence = ClassSlot & { date: Date };

function occurrenceKey(date: Date, startTime: string): string {
  return `${dateKey(date)}|${startTime}`;
}

async function holidayKeys(db: Db, centerId: string, from: Date, to: Date): Promise<Set<string>> {
  const rows = await db.holiday.findMany({
    where: scopedWhere(centerId, { date: { gte: from, lte: to } }),
    select: { date: true },
  });
  return new Set(rows.map((row) => dateKey(row.date)));
}

/**
 * Every occurrence the plan asks for: each slot's weekday in
 * `[max(startDate, today), endDate]`, holidays skipped, and nothing whose
 * start has already passed.
 */
async function plannedOccurrences(
  db: Db,
  centerId: string,
  plan: ClassSessionPlan,
  clock: CentreClock,
): Promise<Occurrence[]> {
  const from = plan.startDate.getTime() > clock.today.getTime() ? plan.startDate : clock.today;
  if (from.getTime() > plan.endDate.getTime() || plan.slots.length === 0) return [];
  const holidays = await holidayKeys(db, centerId, from, plan.endDate);
  const occurrences: Occurrence[] = [];
  for (const slot of plan.slots) {
    for (const date of generateOccurrenceDates(slot, from, plan.endDate, holidays)) {
      const occurrence = { ...slot, date };
      if (!hasStarted(occurrence, clock)) occurrences.push(occurrence);
    }
  }
  return occurrences;
}

// ── The engine ─────────────────────────────────────────────────────────────

/**
 * Thrown inside a transaction when the whole-range conflict decision refuses
 * the write, so the caller's entire transaction — the class write included —
 * rolls back. `inClassTransaction` turns it back into a `ConflictRefusal`.
 */
export class ClassSessionsRefusedError extends Error {
  readonly refusal: ConflictRefusal;
  constructor(refusal: ConflictRefusal) {
    super("Class write refused over conflicts.");
    this.name = "ClassSessionsRefusedError";
    this.refusal = refusal;
  }
}

/** What a resync would do — computed without writing anything. */
type SyncPlan = {
  toDelete: string[];
  toUpdate: string[];
  toCreate: Occurrence[];
  kept: KeptSession[];
  conflicts: DatedConflict[];
  policy: ConflictPolicy;
  today: Date;
};

/**
 * Classifies a class's future sessions against `plan` and checks every
 * session that would be created or re-roomed against the centre's dated
 * occupancy — ONE list for the whole period. Read-only: the write path
 * (`applySync`) and the live preview (`previewClassSessions`) share it, so
 * the preview can never disagree with what a save would decide.
 */
async function computeSync(
  db: Db,
  centerId: string,
  plan: ClassSessionPlan,
  baseline: Baseline,
  options: { now?: Date; locale?: string },
): Promise<SyncPlan> {
  const { timeZone, policy } = await centreScheduling(db, centerId);
  const clock = centreClock(options.now ?? new Date(), timeZone);
  const newRoomIds = effectiveRoomIds(plan.roomId, plan.extraRoomIds);

  const [existing, desired, held] = await Promise.all([
    futureSessions(db, centerId, plan.classGroupId, clock),
    plannedOccurrences(db, centerId, plan, clock),
    // Every key this class already holds from today on (any status, started
    // or not). U2: this deliberately includes a slot that was rescheduled
    // away or cancelled — the partial unique index would now accept a new row
    // at a moved slot, but the engine never recreates one: a moved or
    // cancelled occurrence stays moved or cancelled, however often the class
    // is resynced (check:session-lifecycle asserts it).
    db.session.findMany({
      where: scopedWhere(centerId, { classGroupId: plan.classGroupId, date: { gte: clock.today } }),
      select: { date: true, startTime: true },
    }),
  ]);
  const desiredByKey = new Map(desired.map((occurrence) => [occurrenceKey(occurrence.date, occurrence.startTime), occurrence]));
  const heldKeys = new Set(held.map((row) => occurrenceKey(row.date, row.startTime)));

  const toDelete: string[] = [];
  const toUpdate: SessionState[] = [];
  const kept: KeptSession[] = [];
  const teacherOrRoomsChange = plan.teacherId !== baseline.teacherId || !sameRooms(newRoomIds, baseline.roomIds);

  for (const session of existing) {
    const key = occurrenceKey(session.date, session.startTime);
    const wanted = desiredByKey.get(key);
    const matches = wanted !== undefined && wanted.endTime === session.endTime;
    const roomIds = sessionRoomIds(session);
    const reasons = sessionDisqualifiers(session, roomIds, baseline);

    // R5: a manual session is deliberately off the class's plan. It is never
    // deleted or rewritten (it is not pristine), and it is not reported as
    // "kept" either — nothing about it needs staff attention. Its slot stays
    // in `heldKeys`, so the class never creates a second session on top of it.
    if (session.isManual) continue;

    if (reasons.length === 0) {
      if (!matches) {
        toDelete.push(session.id);
        heldKeys.delete(key);
      } else if (teacherOrRoomsChange) {
        toUpdate.push(session);
      }
      continue;
    }
    // Not pristine: left exactly as it is. Reported when it no longer fits
    // the class (a slot, date, teacher or room set the class no longer has).
    const conforms = matches && session.teacherId === plan.teacherId && sameRooms(roomIds, newRoomIds);
    if (!conforms && session.status !== CANCELLED) {
      kept.push({
        sessionId: session.id,
        date: dateKey(session.date),
        startTime: session.startTime,
        endTime: session.endTime,
        reasons,
      });
    }
  }

  const toCreate = desired.filter((occurrence) => !heldKeys.has(occurrenceKey(occurrence.date, occurrence.startTime)));

  // ── One conflict list for the whole range ──────────────────────────────
  const candidates = [
    ...toCreate.map(({ date, startTime, endTime }) => ({ date, startTime, endTime })),
    ...toUpdate.map(({ date, startTime, endTime }) => ({ date, startTime, endTime })),
  ];
  const conflicts: DatedConflict[] = [];
  if (candidates.length > 0) {
    const times = candidates.map((candidate) => candidate.date.getTime());
    const occupancy = await loadSessionOccupancy(
      db,
      centerId,
      options.locale ?? "en",
      new Date(Math.min(...times)),
      new Date(Math.max(...times)),
    );
    const byDay = new Map<string, ExistingSession[]>();
    for (const row of occupancy) {
      const key = dateKey(row.date);
      byDay.set(key, [...(byDay.get(key) ?? []), row]);
    }
    for (const candidate of candidates) {
      const sameDay = byDay.get(dateKey(candidate.date));
      if (!sameDay) continue;
      conflicts.push(
        ...findSessionConflicts(
          {
            classGroupId: plan.classGroupId,
            teacherId: plan.teacherId,
            roomId: plan.roomId,
            roomIds: newRoomIds,
            date: candidate.date,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
          },
          sameDay,
        ).map((conflict) => ({ ...conflict, date: dateKey(candidate.date) })),
      );
    }
  }

  return {
    toDelete,
    toUpdate: toUpdate.map((session) => session.id),
    toCreate,
    kept,
    conflicts,
    policy,
    today: clock.today,
  };
}

/**
 * **Resync** — re-fits a class's future sessions to `plan`, inside the
 * caller's transaction. `baseline` is the teacher and room set the class
 * had BEFORE the write — what decides which sessions are pristine. Throws
 * `ClassSessionsRefusedError` on a refused conflict decision so the caller's
 * whole transaction (the class write included) rolls back.
 */
export async function resyncClassSessions(
  tx: Tx,
  centerId: string,
  plan: ClassSessionPlan,
  baseline: Baseline,
  options: ClassSessionsOptions,
  context: string,
): Promise<SessionSyncReport> {
  const sync = await computeSync(tx, centerId, plan, baseline, options);
  const { conflicts } = sync;
  const decision = decideConflicts(conflicts.length, sync.policy, options.confirmConflicts);
  if (decision === "denied") throw new ClassSessionsRefusedError({ ok: false, error: "conflict", conflicts });
  if (decision === "needsConfirmation") {
    throw new ClassSessionsRefusedError({ ok: false, error: "conflictsNeedConfirmation", conflicts });
  }

  const extraRoomIds = plan.roomId ? plan.extraRoomIds : [];

  let deleted = 0;
  if (sync.toDelete.length > 0) {
    deleted = (
      await tx.session.deleteMany({
        where: scopedWhere(centerId, { id: { in: sync.toDelete }, ...STILL_PRISTINE }),
      })
    ).count;
  }

  let updated = 0;
  for (const sessionId of sync.toUpdate) {
    const moved = await tx.session.updateMany({
      where: scopedWhere(centerId, { id: sessionId, ...STILL_PRISTINE }),
      data: { teacherId: plan.teacherId, roomId: plan.roomId },
    });
    if (moved.count === 0) continue;
    updated += 1;
    await writeSessionExtraRooms(tx, centerId, sessionId, extraRoomIds);
  }

  let created = 0;
  if (sync.toCreate.length > 0) {
    created = (
      await tx.session.createMany({
        data: sync.toCreate.map((occurrence) =>
          scopedData(centerId, {
            classGroupId: plan.classGroupId,
            teacherId: plan.teacherId,
            roomId: plan.roomId,
            date: occurrence.date,
            startTime: occurrence.startTime,
            endTime: occurrence.endTime,
            priceSnapshot: plan.price,
          }),
        ),
        skipDuplicates: true,
      })
    ).count;
    // Copy the class's extra rooms onto every session just created (R3).
    if (extraRoomIds.length > 0) {
      const createdKeys = new Set(sync.toCreate.map((occurrence) => occurrenceKey(occurrence.date, occurrence.startTime)));
      const rows = await tx.session.findMany({
        where: scopedWhere(centerId, {
          classGroupId: plan.classGroupId,
          date: { gte: sync.today },
          extraRooms: { none: {} },
        }),
        select: { id: true, date: true, startTime: true },
      });
      const extras = rows
        .filter((row) => createdKeys.has(occurrenceKey(row.date, row.startTime)))
        .flatMap((row) => extraRoomIds.map((roomId) => scopedData(centerId, { sessionId: row.id, roomId })));
      if (extras.length > 0) await tx.sessionRoom.createMany({ data: extras, skipDuplicates: true });
    }
  }

  if (options.confirmConflicts && conflicts.length > 0) {
    await writeConfirmedConflictAudit(tx, {
      centerId,
      actorUserId: options.actorUserId ?? null,
      entityType: "ClassGroup",
      entityId: plan.classGroupId,
      context,
      conflicts,
    });
  }

  return { created, deleted, updated, kept: sync.kept, conflicts: options.confirmConflicts ? conflicts : [] };
}

/**
 * **Materialize** — creates every session of a class's period from
 * `max(startDate, today at the centre)` through `endDate` (as of `from`,
 * the injectable clock), inside the caller's transaction. The class as
 * stored is the plan and its own teacher/room set the baseline, so for a
 * class that already has sessions this is a no-op resync: nothing it
 * already has is touched, missing dates are added. Throws
 * `ClassSessionsRefusedError` like `resyncClassSessions`.
 */
export async function materializeClassSessions(
  tx: Tx,
  centerId: string,
  classGroupId: string,
  options: Omit<ClassSessionsOptions, "now"> & { from?: Date },
): Promise<SessionSyncReport> {
  const current = await loadPlan(tx, centerId, classGroupId);
  if (!current) throw new Error(`Class ${classGroupId} not found in this centre.`);
  const { from, ...rest } = options;
  return resyncClassSessions(tx, centerId, current.plan, current.baseline, { ...rest, now: from }, "classGroup.materialize");
}

/**
 * Runs a class write and its resync in one transaction; a refused conflict
 * decision rolls it all back and comes back as the `ConflictRefusal`.
 */
export async function inClassTransaction<T>(
  db: PrismaClient,
  fn: (tx: Tx) => Promise<T>,
): Promise<T | ConflictRefusal> {
  try {
    return await db.$transaction(fn, WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ClassSessionsRefusedError) return error.refusal;
    throw error;
  }
}

/** A class's current plan, as stored. */
async function loadPlan(db: Db, centerId: string, classGroupId: string) {
  const row = await db.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: {
      id: true,
      active: true,
      teacherId: true,
      roomId: true,
      price: true,
      startDate: true,
      endDate: true,
      extraRooms: { select: { roomId: true }, orderBy: { createdAt: "asc" } },
      schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  });
  if (!row) return null;
  const extraRoomIds = row.roomId ? row.extraRooms.map((extra) => extra.roomId) : [];
  const plan: ClassSessionPlan = {
    classGroupId: row.id,
    teacherId: row.teacherId,
    roomId: row.roomId,
    extraRoomIds,
    price: row.price,
    startDate: row.startDate,
    endDate: row.endDate,
    slots: row.schedules,
  };
  return { active: row.active, plan, baseline: { teacherId: row.teacherId, roomIds: effectiveRoomIds(row.roomId, extraRoomIds) } };
}

async function audit(
  tx: Db,
  input: {
    centerId: string;
    actorUserId: string | null | undefined;
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await writeAuditRow(tx, {
    centerId: input.centerId,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
  });
}

function reportJson(report: SessionSyncReport): Prisma.InputJsonValue {
  return { created: report.created, deleted: report.deleted, updated: report.updated, kept: report.kept.length };
}

// ── Create ─────────────────────────────────────────────────────────────────

export type ClassInput = {
  teacherId: string;
  subjectId: string | null;
  gradeId: string | null;
  educationSystemId: string | null;
  roomId: string;
  extraRoomIds: string[];
  price: number;
  centerShareType: ShareType;
  centerShareValue: number;
  lateThresholdMinutes: number;
  acceptsNewStudents: boolean;
  requiresConfirmation: boolean;
  /** F6 — omitted keeps the stored value (a new class: OFF). */
  sessionBookingMode?: SessionBookingMode;
  /** F6 — null = no extra cap; omitted keeps the stored value. */
  maxBookingSeats?: number | null;
  startDate: Date;
  endDate: Date;
};

export type CreateClassResult =
  | { ok: true; classGroupId: string; report: SessionSyncReport }
  | ConflictRefusal
  | ClassPeriodRefusal
  | { ok: false; error: RoomSetError | WeeklySlotsError | ClassMoneyError };

/** A class's price/cut refused by the one money rule (lib/money.ts, D-15). */
export type ClassMoneyError = "invalidPrice" | CenterCutError;

/**
 * The class's money configuration, by direct call (SEC-2b, D-15 (c), D-17):
 * a whole-piastre price within `MAX_PRICE_PIASTRES`, and a cut valid for that
 * price — a FIXED cut above it is refused. The same rule runs on create and
 * on every edit, so **lowering a price below the class's FIXED cut is
 * refused** too, never silently clamped at payment time.
 */
export function classMoneyError(input: {
  price: number;
  centerShareType: ShareType;
  centerShareValue: number;
}): ClassMoneyError | null {
  if (!Number.isInteger(input.price) || input.price < 0 || input.price > MAX_PRICE_PIASTRES) return "invalidPrice";
  return centerCutError(input.price, input.centerShareType, input.centerShareValue);
}

/**
 * The create write itself, on the caller's transaction client (R6): the class
 * row, its extra rooms, its weekly slots and — through the engine's one
 * resync — every session of its period, plus the `classGroup.create` audit.
 * `createClassWithSessions` wraps it in its own transaction;
 * `createClassWithNewTeacher` runs it in the same transaction as the teacher
 * it creates. Throws `ClassSessionsRefusedError` on a refused conflict
 * decision so whichever transaction it is in rolls back whole.
 */
async function writeClassWithSessions(
  tx: Tx,
  centerId: string,
  input: ClassInput & { slots: ClassSlot[] },
  roomIds: readonly string[],
  options: ClassSessionsOptions,
): Promise<{ ok: true; classGroupId: string; report: SessionSyncReport }> {
  const { slots, extraRoomIds, ...fields } = input;
  const row = await tx.classGroup.create({ data: scopedData(centerId, fields) });
  await writeClassExtraRooms(tx, centerId, row.id, extraRoomIds);
  if (slots.length > 0) {
    await tx.classSchedule.createMany({
      data: slots.map((slot) => scopedData(centerId, { classGroupId: row.id, ...slot })),
    });
  }
  const report = await resyncClassSessions(
    tx,
    centerId,
    { classGroupId: row.id, teacherId: input.teacherId, roomId: input.roomId, extraRoomIds, price: input.price, startDate: input.startDate, endDate: input.endDate, slots },
    { teacherId: input.teacherId, roomIds },
    options,
    "classGroup.create",
  );
  // A class's price and centre cut are money configuration (CLAUDE.md
  // rule 7) — never rewrites recorded payments, but the config is audited.
  await audit(tx, {
    centerId,
    actorUserId: options.actorUserId,
    action: "classGroup.create",
    entityType: "ClassGroup",
    entityId: row.id,
    after: {
      price: input.price,
      centerShareType: input.centerShareType,
      centerShareValue: input.centerShareValue,
      teacherId: input.teacherId,
      roomId: input.roomId,
      extraRoomIds,
      startDate: dateKey(input.startDate),
      endDate: dateKey(input.endDate),
      sessionBookingMode: input.sessionBookingMode ?? "OFF",
      maxBookingSeats: input.maxBookingSeats ?? null,
      sessions: reportJson(report),
    },
  });
  return { ok: true as const, classGroupId: row.id, report };
}

/**
 * Creates a class, its weekly slots and every session of its period in ONE
 * transaction (R4). The room set is validated here (R3); the teacher and
 * catalog references are resolved by the caller inside the same centre.
 * Any refusal — including a conflict decision — writes nothing at all.
 * (R6: the rows are checked by the one rule, `weeklySlotsError` — a valid
 * range each, none overlapping on a weekday; "at least one row" is the new
 * class dialog's rule, enforced by its schema and by `createClassWithNewTeacher`.)
 */
export async function createClassWithSessions(
  db: PrismaClient,
  centerId: string,
  input: ClassInput & { slots: ClassSlot[] },
  options: ClassSessionsOptions,
): Promise<CreateClassResult> {
  const periodError = classPeriodError(input.startDate, input.endDate);
  if (periodError) return { ok: false, error: periodError };
  const moneyError = classMoneyError(input);
  if (moneyError) return { ok: false, error: moneyError };
  const slotsProblem = weeklySlotsError(input.slots, { required: false });
  if (slotsProblem) return { ok: false, error: slotsProblem.error };
  const rooms = await resolveRoomSet(db, centerId, input.roomId, input.extraRoomIds);
  if (!rooms.ok) return { ok: false, error: rooms.error };

  return inClassTransaction(db, (tx) => writeClassWithSessions(tx, centerId, input, rooms.set.roomIds, options));
}

// ── Create, with a brand-new teacher (R6) ──────────────────────────────────

/** The permission actions "create a class with a new teacher" needs — both. */
export type NewTeacherClassPermission = "teacher.manage" | "class.manage";

export type NewTeacherClassInput = {
  /** The new teacher's typed details (the Add teacher form's own fields). */
  teacher: PersonInput;
  /** Set only after staff confirmed a match ("Use this person"). */
  linkUserId: string | null;
  /** U1: the new membership's trusted flag; omitted = the column default (trusted). */
  isTrustedTeacher?: boolean;
  /** The class, without its teacher — the teacher is created first. */
  class: Omit<ClassInput, "teacherId">;
  slots: ClassSlot[];
};

export type NewTeacherClassOptions = ClassSessionsOptions & {
  /**
   * The caller's permission check (`ctxCan` in the action, the stored matrix
   * in a gate). Both `teacher.manage` and `class.manage` are required; either
   * missing refuses before anything is read or written.
   */
  can: (permission: NewTeacherClassPermission) => boolean;
};

export type NewTeacherClassResult =
  | {
      ok: true;
      classGroupId: string;
      teacherUserId: string;
      teacherOutcome: "created" | "linked" | "reactivated";
      report: SessionSyncReport;
    }
  | { ok: false; part: "permission"; error: "forbidden" }
  /** The teacher step refused (`matchFound` carries the match to confirm). */
  | { ok: false; part: "teacher"; error: TeacherRefusal | "matchFound"; match?: MatchCandidate }
  /** The class step refused — everything, the teacher included, was rolled back. */
  | { ok: false; part: "class"; error: ClassPeriodError | RoomSetError | WeeklySlotsError | ClassMoneyError }
  | { ok: false; part: "class"; error: ConflictRefusal["error"]; conflicts: DatedConflict[] };

class TeacherStepRefusedError extends Error {
  readonly refusal: Extract<TeacherMembershipResult, { ok: false }>;
  constructor(refusal: Extract<TeacherMembershipResult, { ok: false }>) {
    super("Teacher step refused.");
    this.name = "TeacherStepRefusedError";
    this.refusal = refusal;
  }
}

/**
 * **Create a class with a brand-new teacher, atomically** (R6, docs/00 §5.1).
 * One transaction, in this order: the teacher (`addTeacherMembership` — the
 * one teacher-creation path, run on this transaction's client), then the class
 * + its weekly slots + every session (`writeClassWithSessions` → the engine's
 * single resync). Any error — validation, a duplicate phone awaiting
 * confirmation, a privileged phone, a conflict refusal under DENY or an
 * unconfirmed WARN, an engine failure — rolls the whole transaction back:
 * no orphan `User`, `Membership` or audit row. Which half refused comes back
 * as `part`, so the form can say "The teacher could not be created" or "The
 * class could not be created".
 *
 * Both `teacher.manage` and `class.manage` are required (`options.can`),
 * checked first. Audit rows — `membership.create` for the teacher,
 * `classGroup.create` (+ `schedule.conflict.confirm` when confirmed) for the
 * class — are written in the same transaction.
 */
export async function createClassWithNewTeacher(
  db: PrismaClient,
  centerId: string,
  input: NewTeacherClassInput,
  options: NewTeacherClassOptions,
): Promise<NewTeacherClassResult> {
  if (!options.can("teacher.manage") || !options.can("class.manage")) {
    return { ok: false, part: "permission", error: "forbidden" };
  }

  // The class half's cheap, read-only checks first, so an invalid class never
  // gets as far as creating anyone.
  const periodError = classPeriodError(input.class.startDate, input.class.endDate);
  if (periodError) return { ok: false, part: "class", error: periodError };
  const moneyError = classMoneyError(input.class);
  if (moneyError) return { ok: false, part: "class", error: moneyError };
  const slotsProblem = weeklySlotsError(input.slots, { required: true });
  if (slotsProblem) return { ok: false, part: "class", error: slotsProblem.error };
  const rooms = await resolveRoomSet(db, centerId, input.class.roomId, input.class.extraRoomIds);
  if (!rooms.ok) return { ok: false, part: "class", error: rooms.error };

  try {
    return await db.$transaction(async (tx) => {
      const teacher = await addTeacherMembership(tx, centerId, input.teacher, {
        actorUserId: options.actorUserId ?? null,
        linkUserId: input.linkUserId,
        via: "class.create",
        refusePrivileged: true,
        isTrustedTeacher: input.isTrustedTeacher,
      });
      if (!teacher.ok) throw new TeacherStepRefusedError(teacher);

      const created = await writeClassWithSessions(
        tx,
        centerId,
        { ...input.class, teacherId: teacher.userId, slots: input.slots },
        // The teacher is new, so the baseline room set is the class's own.
        rooms.set.roomIds,
        options,
      );
      return {
        ok: true as const,
        classGroupId: created.classGroupId,
        teacherUserId: teacher.userId,
        teacherOutcome: teacher.outcome,
        report: created.report,
      };
    }, WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof TeacherStepRefusedError) {
      return { ok: false, part: "teacher", error: error.refusal.error, ...(error.refusal.match ? { match: error.refusal.match } : {}) };
    }
    if (error instanceof ClassSessionsRefusedError) {
      return { ok: false, part: "class", error: error.refusal.error, conflicts: error.refusal.conflicts };
    }
    if (isUniqueViolation(error)) return { ok: false, part: "teacher", error: "contactInUse" };
    throw error;
  }
}

/**
 * The live, read-only preview for a class that does not exist yet (the New
 * class dialog, R6): every session the create would make across the whole
 * period, checked against the centre's occupancy by the engine's own
 * `computeSync` — so the list a person confirms is the list the save checks.
 * `teacherId` is null while a brand-new teacher is typed (nobody to clash
 * with, only the rooms). Writes nothing.
 */
export async function previewNewClassSessions(
  db: Db,
  centerId: string,
  input: {
    teacherId: string | null;
    roomId: string | null;
    extraRoomIds: string[];
    startDate: Date;
    endDate: Date;
    slots: ClassSlot[];
  },
  options: { now?: Date; locale?: string } = {},
): Promise<{ conflicts: DatedConflict[]; created: number }> {
  const none = { conflicts: [], created: 0 };
  if (!input.roomId || input.slots.length === 0) return none;
  if (classPeriodError(input.startDate, input.endDate)) return none;
  if (weeklySlotsError(input.slots, { required: true })) return none;
  const rooms = await resolveRoomSet(db, centerId, input.roomId, input.extraRoomIds);
  if (!rooms.ok) return none;
  const plan: ClassSessionPlan = {
    // No such class yet: nothing to match, nothing to delete, only the
    // sessions it WOULD create to compare against the centre's bookings.
    classGroupId: "new-class-preview",
    teacherId: input.teacherId ?? "",
    roomId: input.roomId,
    extraRoomIds: input.extraRoomIds,
    price: 0,
    startDate: input.startDate,
    endDate: input.endDate,
    slots: input.slots,
  };
  const sync = await computeSync(db, centerId, plan, { teacherId: plan.teacherId, roomIds: [] }, options);
  return { conflicts: sync.conflicts, created: sync.toCreate.length };
}

// ── Edit ───────────────────────────────────────────────────────────────────

/**
 * What a class price edit did to the class's own sessions (SYS, docs/00 §5.1
 * "A class price edit reprices its open sessions"). Counts only — the audit
 * row and the form's notice carry these.
 */
export type RepriceReport = {
  /** Sessions from today on, not closed, with no payment — now at the new price. */
  repriced: number;
  /** Sessions that already hold a payment (any, voided included) — price kept. */
  keptWithPayments: number;
  /** Sessions whose own FIXED cut override is above the new price — price kept (D-15). */
  keptCutAbovePrice: number;
};

/**
 * **The price decision (SYS).** Editing a class's price reprices the class's
 * sessions dated today or later (the centre's day) that are not closed, not
 * cancelled, not a rescheduled original, and hold **no payment at all** —
 * extra (manual) sessions of the class included, since their price was the
 * class's. A session with any payment keeps its price, and a recorded
 * payment is never touched (CLAUDE.md rule 2 is about payments: each one
 * froze its own `priceSnapshot`). The centre cut needs no equivalent: a
 * payment reads the cut at payment time already (`recordPayment`).
 *
 * Runs inside the class edit's transaction. The candidate sessions are
 * row-locked first and the payment fact is re-read by a fresh statement
 * after the lock (READ COMMITTED — docs/02 §7), so a payment in flight
 * (which holds the session's shared lock) is either seen here or waits and
 * then reads the new price itself (`lockAttendeeRow` re-reads it).
 */
async function repriceClassSessions(
  tx: Tx,
  centerId: string,
  classGroupId: string,
  price: number,
  now: Date,
): Promise<RepriceReport> {
  const { timeZone } = await centreScheduling(tx, centerId);
  const today = todayInTimezone(timeZone, now);
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "Session" s
    WHERE s."centerId" = ${centerId} AND s."classGroupId" = ${classGroupId}
      AND s."date" >= ${today} AND s."closedAt" IS NULL
      AND s."status" <> 'CANCELLED' AND s."rescheduledToId" IS NULL
      AND s."priceSnapshot" <> ${price}
    ORDER BY s."id"
    FOR UPDATE OF s`;
  if (locked.length === 0) return { repriced: 0, keptWithPayments: 0, keptCutAbovePrice: 0 };

  // A NEW statement, after the locks are held.
  const rows = await tx.session.findMany({
    where: scopedWhere(centerId, { id: { in: locked.map((row) => row.id) } }),
    select: { id: true, centerShareType: true, centerShareValue: true, _count: { select: { payments: true } } },
  });
  const toReprice: string[] = [];
  let keptWithPayments = 0;
  let keptCutAbovePrice = 0;
  for (const row of rows) {
    if (row._count.payments > 0) keptWithPayments += 1;
    else if (
      row.centerShareType !== null &&
      row.centerShareValue !== null &&
      centerCutError(price, row.centerShareType, row.centerShareValue) !== null
    ) {
      keptCutAbovePrice += 1;
    } else toReprice.push(row.id);
  }
  const repriced =
    toReprice.length === 0
      ? 0
      : (
          await tx.session.updateMany({
            where: scopedWhere(centerId, { id: { in: toReprice }, closedAt: null, payments: { none: {} } }),
            data: { priceSnapshot: price },
          })
        ).count;
  return { repriced, keptWithPayments, keptCutAbovePrice };
}

export type UpdateClassResult =
  | { ok: true; report: SessionSyncReport | null; reprice: RepriceReport | null }
  | ConflictRefusal
  | ClassPeriodRefusal
  | { ok: false; error: "notFound" | RoomSetError | ClassMoneyError };

/**
 * Edits a class. When its period, teacher or room set changes (and the class
 * is active), its future sessions are resynced in the same transaction
 * (resolves OD-9): pristine ones follow the class, the rest are reported as
 * kept. A refused conflict decision rolls the whole edit back. When its
 * price changes, its open sessions without payments take the new price
 * (`repriceClassSessions`, the SYS price decision), audited with the counts.
 */
export async function updateClassWithSessions(
  db: PrismaClient,
  centerId: string,
  classGroupId: string,
  input: ClassInput,
  options: ClassSessionsOptions,
): Promise<UpdateClassResult> {
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current) return { ok: false, error: "notFound" };
  const periodError = classPeriodError(input.startDate, input.endDate);
  if (periodError) return { ok: false, error: periodError };
  // D-15: a price lowered below the class's FIXED cut is refused here too.
  const moneyError = classMoneyError(input);
  if (moneyError) return { ok: false, error: moneyError };
  // A room deactivated after this class chose it may stay; it just cannot
  // be newly picked.
  const rooms = await resolveRoomSet(db, centerId, input.roomId, input.extraRoomIds, {
    requireActiveExcept: current.baseline.roomIds,
  });
  if (!rooms.ok) return { ok: false, error: rooms.error };

  const before = await db.classGroup.findFirstOrThrow({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: { price: true, centerShareType: true, centerShareValue: true },
  });
  const plan: ClassSessionPlan = {
    ...current.plan,
    teacherId: input.teacherId,
    roomId: input.roomId,
    extraRoomIds: input.extraRoomIds,
    price: input.price,
    startDate: input.startDate,
    endDate: input.endDate,
  };
  const shapeChanged =
    plan.teacherId !== current.plan.teacherId ||
    !sameRooms(rooms.set.roomIds, current.baseline.roomIds) ||
    dateKey(plan.startDate) !== dateKey(current.plan.startDate) ||
    dateKey(plan.endDate) !== dateKey(current.plan.endDate);

  return inClassTransaction(db, async (tx) => {
    const { extraRoomIds, ...fields } = input;
    await tx.classGroup.updateMany({ where: scopedWhere(centerId, { id: classGroupId }), data: fields });
    await writeClassExtraRooms(tx, centerId, classGroupId, extraRoomIds);
    const report =
      current.active && shapeChanged
        ? await resyncClassSessions(tx, centerId, plan, current.baseline, options, "classGroup.update")
        : null;
    // After the resync, so sessions it just created (already at the new
    // price) are not counted and pristine ones it deleted are not repriced.
    const reprice =
      input.price !== before.price
        ? await repriceClassSessions(tx, centerId, classGroupId, input.price, options.now ?? new Date())
        : null;
    await audit(tx, {
      centerId,
      actorUserId: options.actorUserId,
      action: "classGroup.update",
      entityType: "ClassGroup",
      entityId: classGroupId,
      before: {
        ...before,
        teacherId: current.plan.teacherId,
        roomId: current.plan.roomId,
        extraRoomIds: current.plan.extraRoomIds,
        startDate: dateKey(current.plan.startDate),
        endDate: dateKey(current.plan.endDate),
      },
      after: {
        price: input.price,
        centerShareType: input.centerShareType,
        centerShareValue: input.centerShareValue,
        teacherId: input.teacherId,
        roomId: input.roomId,
        extraRoomIds,
        startDate: dateKey(input.startDate),
        endDate: dateKey(input.endDate),
        ...(input.sessionBookingMode !== undefined ? { sessionBookingMode: input.sessionBookingMode } : {}),
        ...(input.maxBookingSeats !== undefined ? { maxBookingSeats: input.maxBookingSeats } : {}),
        ...(report ? { sessions: reportJson(report) } : {}),
        ...(reprice ? { reprice } : {}),
      },
    });
    return { ok: true as const, report, reprice };
  });
}

// ── Weekly slots ───────────────────────────────────────────────────────────

export type SlotWriteResult =
  | { ok: true; scheduleId: string | null; report: SessionSyncReport | null }
  | ConflictRefusal
  | { ok: false; error: "notFound" };

type SlotChange =
  | { kind: "add"; classGroupId: string; slot: ClassSlot }
  | { kind: "update"; scheduleId: string; classGroupId: string; slot: ClassSlot }
  | { kind: "remove"; scheduleId: string };

/**
 * Adds, moves or removes one weekly slot, and resyncs the class's future
 * sessions in the same transaction (an inactive class has none to resync).
 */
export async function writeClassSlot(
  db: PrismaClient,
  centerId: string,
  change: SlotChange,
  options: ClassSessionsOptions,
): Promise<SlotWriteResult> {
  let classGroupId: string;
  if (change.kind === "add") {
    classGroupId = change.classGroupId;
  } else {
    const schedule = await db.classSchedule.findFirst({
      where: scopedWhere(centerId, { id: change.scheduleId }),
      select: { classGroupId: true },
    });
    if (!schedule) return { ok: false, error: "notFound" };
    if (change.kind === "update" && schedule.classGroupId !== change.classGroupId) {
      return { ok: false, error: "notFound" };
    }
    classGroupId = schedule.classGroupId;
  }
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current) return { ok: false, error: "notFound" };

  return inClassTransaction(db, async (tx) => {
    let scheduleId: string | null = null;
    let action: string;
    if (change.kind === "add") {
      scheduleId = (
        await tx.classSchedule.create({ data: scopedData(centerId, { classGroupId, ...change.slot }) })
      ).id;
      action = "classSchedule.create";
    } else if (change.kind === "update") {
      await tx.classSchedule.updateMany({ where: scopedWhere(centerId, { id: change.scheduleId }), data: change.slot });
      scheduleId = change.scheduleId;
      action = "classSchedule.update";
    } else {
      await tx.classSchedule.deleteMany({ where: scopedWhere(centerId, { id: change.scheduleId }) });
      action = "classSchedule.delete";
    }
    const slots = await tx.classSchedule.findMany({
      where: scopedWhere(centerId, { classGroupId }),
      select: { dayOfWeek: true, startTime: true, endTime: true },
    });
    const report = current.active
      ? await resyncClassSessions(tx, centerId, { ...current.plan, slots }, current.baseline, options, action)
      : null;
    if (report && report.created + report.deleted + report.updated > 0) {
      await audit(tx, {
        centerId,
        actorUserId: options.actorUserId,
        action: "classGroup.sessions.resync",
        entityType: "ClassGroup",
        entityId: classGroupId,
        after: { trigger: action, ...(reportJson(report) as object) },
      });
    }
    return { ok: true as const, scheduleId, report };
  });
}

// ── Deactivate / reactivate ────────────────────────────────────────────────

export type DeactivateClassResult =
  | { ok: true; deleted: number; cancelled: number }
  | { ok: false; error: "notFound" | "alreadyInactive" };

/**
 * Deactivates a class in one transaction: `active = false`, its pristine
 * future sessions deleted, every other future session CANCELLED through the
 * existing `cancelSession` rules (attendance and payments untouched).
 * Sessions that already started or closed are not touched. Enrolments stay
 * ACTIVE, so reactivating restores the class as it was. Audited.
 */
export async function deactivateClass(
  db: PrismaClient,
  centerId: string,
  classGroupId: string,
  options: { actorUserId?: string | null; now?: Date } = {},
): Promise<DeactivateClassResult> {
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current) return { ok: false, error: "notFound" };
  if (!current.active) return { ok: false, error: "alreadyInactive" };
  const now = options.now ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.classGroup.updateMany({ where: scopedWhere(centerId, { id: classGroupId }), data: { active: false } });
    const { timeZone } = await centreScheduling(tx, centerId);
    const sessions = await futureSessions(tx, centerId, classGroupId, centreClock(now, timeZone));
    const pristine: string[] = [];
    const others: SessionState[] = [];
    for (const session of sessions) {
      // R5: deactivation is the one engine path where a manual session
      // follows the normal rule — deleted if nothing else disqualifies it,
      // cancelled otherwise — so "manual" alone does not keep it.
      const reasons = sessionDisqualifiers(session, sessionRoomIds(session), current.baseline).filter(
        (reason) => reason !== "manual",
      );
      if (reasons.length === 0) pristine.push(session.id);
      else others.push(session);
    }
    const deleted =
      pristine.length > 0
        ? (await tx.session.deleteMany({ where: scopedWhere(centerId, { id: { in: pristine }, ...NO_OVERRIDE }) })).count
        : 0;
    // A pristine row that stopped being pristine since it was read survived
    // the delete above — cancel it like any other kept session.
    const survivors = pristine.length > deleted
      ? await tx.session.findMany({ where: scopedWhere(centerId, { id: { in: pristine } }), select: { id: true } })
      : [];
    let cancelled = 0;
    for (const id of [...others.map((session) => session.id), ...survivors.map((row) => row.id)]) {
      const result = await cancelSession(tx, centerId, id, { now });
      if (result.ok) cancelled += 1;
    }
    await audit(tx, {
      centerId,
      actorUserId: options.actorUserId,
      action: "classGroup.deactivate",
      entityType: "ClassGroup",
      entityId: classGroupId,
      before: { active: true },
      after: { active: false, sessionsDeleted: deleted, sessionsCancelled: cancelled },
    });
    return { ok: true as const, deleted, cancelled };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type ReactivateClassResult =
  | { ok: true; report: SessionSyncReport }
  | ConflictRefusal
  | { ok: false; error: "notFound" | "alreadyActive" | "periodEnded" };

/**
 * Reactivates a class — only while its period has not ended (otherwise
 * `periodEnded`: extend the end date first). Its sessions are regenerated
 * from now through `endDate` under the full confirmation contract; a
 * refusal leaves the class inactive.
 */
export async function reactivateClass(
  db: PrismaClient,
  centerId: string,
  classGroupId: string,
  options: ClassSessionsOptions,
): Promise<ReactivateClassResult> {
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current) return { ok: false, error: "notFound" };
  if (current.active) return { ok: false, error: "alreadyActive" };
  const { timeZone } = await centreScheduling(db, centerId);
  const clock = centreClock(options.now ?? new Date(), timeZone);
  if (dateKey(current.plan.endDate) < clock.todayKey) return { ok: false, error: "periodEnded" };

  return inClassTransaction(db, async (tx) => {
    await tx.classGroup.updateMany({ where: scopedWhere(centerId, { id: classGroupId }), data: { active: true } });
    const report = await resyncClassSessions(tx, centerId, current.plan, current.baseline, options, "classGroup.reactivate");
    await audit(tx, {
      centerId,
      actorUserId: options.actorUserId,
      action: "classGroup.reactivate",
      entityType: "ClassGroup",
      entityId: classGroupId,
      before: { active: false },
      after: { active: true, sessions: reportJson(report) },
    });
    return { ok: true as const, report };
  });
}

// ── Delete ─────────────────────────────────────────────────────────────────

export type ClassDeleteBlockers = {
  /** Sessions whose start has come (cancelled and moved-away ones excluded) or that are closed. */
  started: number;
  attendees: number;
  payments: number;
  settlements: number;
  ratings: number;
  rescheduled: number;
  enrollments: number;
  reservations: number;
  /** F6 — single-session bookings on any of its sessions, any status. */
  bookings: number;
};

/**
 * What keeps a class from being deleted (R4): a class may be deleted only if
 * it never ran — no session started or closed, none with attendees,
 * payments, a settlement, ratings or a reschedule link, and no enrolments or
 * reservations or session bookings at all. Anything else can only be
 * deactivated.
 */
export async function classDeleteBlockers(
  db: Db,
  centerId: string,
  classGroupId: string,
  now: Date = new Date(),
): Promise<ClassDeleteBlockers> {
  const { timeZone } = await centreScheduling(db, centerId);
  const clock = centreClock(now, timeZone);
  const inClass = { classGroupId };
  const [sessions, attendees, payments, settlements, ratings, rescheduled, enrollments, reservations, bookings] =
    await Promise.all([
      db.session.findMany({
        where: scopedWhere(centerId, { ...inClass, date: { lte: clock.today } }),
        select: { date: true, startTime: true, status: true, closedAt: true, rescheduledToId: true },
      }),
      db.sessionAttendee.count({ where: scopedWhere(centerId, { session: inClass }) }),
      db.payment.count({ where: scopedWhere(centerId, { session: inClass }) }),
      db.settlement.count({ where: scopedWhere(centerId, { session: inClass }) }),
      db.sessionRating.count({ where: { session: { centerId, classGroupId } } }),
      db.session.count({
        where: scopedWhere(centerId, {
          ...inClass,
          OR: [{ rescheduledToId: { not: null } }, { rescheduledFrom: { isNot: null } }],
        }),
      }),
      db.enrollment.count({ where: scopedWhere(centerId, inClass) }),
      db.reservation.count({ where: scopedWhere(centerId, inClass) }),
      db.sessionBooking.count({ where: scopedWhere(centerId, { session: inClass }) }),
    ]);
  const started = sessions.filter(
    (session) =>
      session.closedAt !== null ||
      (session.status !== CANCELLED && !session.rescheduledToId && hasStarted(session, clock)),
  ).length;
  return { started, attendees, payments, settlements, ratings, rescheduled, enrollments, reservations, bookings };
}

export function hasDeleteBlockers(blockers: ClassDeleteBlockers): boolean {
  return Object.values(blockers).some((count) => count > 0);
}

export type DeleteClassResult =
  | { ok: true }
  | { ok: false; error: "notFound" }
  | { ok: false; error: "classInUse"; blockers: ClassDeleteBlockers };

/**
 * Hard-deletes a class that never ran — its pristine future sessions, weekly
 * slots and extra rooms go with it (cascade). Refused by direct call
 * whenever `classDeleteBlockers` finds anything. Audited.
 */
export async function deleteClass(
  db: PrismaClient,
  centerId: string,
  classGroupId: string,
  options: { actorUserId?: string | null; now?: Date } = {},
): Promise<DeleteClassResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.classGroup.findFirst({
      where: scopedWhere(centerId, { id: classGroupId }),
      select: { id: true, teacherId: true, price: true, startDate: true, endDate: true },
    });
    if (!existing) return { ok: false as const, error: "notFound" as const };
    // Lock the class row so an enrolment or check-in cannot slip in between
    // the blocker count and the delete.
    await tx.$queryRaw`SELECT "id" FROM "ClassGroup" WHERE "id" = ${classGroupId} AND "centerId" = ${centerId} FOR UPDATE`;
    const blockers = await classDeleteBlockers(tx, centerId, classGroupId, options.now);
    if (hasDeleteBlockers(blockers)) return { ok: false as const, error: "classInUse" as const, blockers };
    await tx.classGroup.deleteMany({ where: scopedWhere(centerId, { id: classGroupId }) });
    await audit(tx, {
      centerId,
      actorUserId: options.actorUserId,
      action: "classGroup.delete",
      entityType: "ClassGroup",
      entityId: classGroupId,
      before: {
        teacherId: existing.teacherId,
        price: existing.price,
        startDate: dateKey(existing.startDate),
        endDate: dateKey(existing.endDate),
      },
    });
    return { ok: true as const };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Holidays ───────────────────────────────────────────────────────────────

/**
 * A holiday added after sessions exist: every **pristine** session on that
 * date, of every active class, is deleted (a holiday means no class that
 * day); anything with records or custom changes is kept and counted, for
 * staff to cancel by hand. Runs in the caller's transaction, beside the
 * holiday insert. Removing a holiday does not bring sessions back — see
 * OD-10 (docs/00 §2.2).
 *
 * R5: a manual session — an extra session on a class, or a one-time session
 * with no class — is never deleted by a holiday (it was put on its date by
 * hand, and a holiday never blocks one); it is counted with the kept ones so
 * staff see it and can cancel it if the holiday means it too.
 */
export async function removeSessionsOnHoliday(
  tx: Tx,
  centerId: string,
  date: Date,
  now: Date = new Date(),
): Promise<{ deleted: number; kept: number }> {
  const { timeZone } = await centreScheduling(tx, centerId);
  const clock = centreClock(now, timeZone);
  if (dateKey(date) < clock.todayKey) return { deleted: 0, kept: 0 };
  const rows = await tx.session.findMany({
    where: scopedWhere(centerId, { date, OR: [{ classGroupId: null }, { classGroup: { active: true } }] }),
    select: {
      ...SESSION_STATE_SELECT,
      classGroup: { select: { teacherId: true, roomId: true, extraRooms: { select: { roomId: true }, orderBy: { createdAt: "asc" } } } },
    },
  });
  const pristine: string[] = [];
  let kept = 0;
  for (const row of rows) {
    if (hasStarted(row, clock)) continue;
    if (!row.classGroup) {
      if (row.status !== CANCELLED && !row.rescheduledToId) kept += 1;
      continue;
    }
    const baseline = {
      teacherId: row.classGroup.teacherId,
      roomIds: effectiveRoomIds(row.classGroup.roomId, row.classGroup.extraRooms.map((extra) => extra.roomId)),
    };
    if (sessionDisqualifiers(row, sessionRoomIds(row), baseline).length === 0) pristine.push(row.id);
    else if (row.status !== CANCELLED && !row.rescheduledToId) kept += 1;
  }
  const deleted =
    pristine.length > 0
      ? (await tx.session.deleteMany({ where: scopedWhere(centerId, { id: { in: pristine }, ...STILL_PRISTINE }) })).count
      : 0;
  return { deleted, kept: kept + (pristine.length - deleted) };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * The future sessions of a class that no longer fit it and were kept
 * because they carry records or custom changes — what the class detail page
 * reports after a resync (R4). The resync's own classification, read
 * against the class as it is now.
 */
export async function keptClassSessions(
  db: Db,
  centerId: string,
  classGroupId: string,
  now: Date = new Date(),
): Promise<KeptSession[]> {
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current || !current.active) return [];
  return (await computeSync(db, centerId, current.plan, current.baseline, { now })).kept;
}

/** A proposed change to a class, as the forms preview it. */
export type ClassSessionsChange = {
  teacherId?: string;
  roomId?: string | null;
  extraRoomIds?: string[];
  startDate?: Date;
  endDate?: Date;
  /** A weekly slot being added (no id) or moved (its id). */
  slot?: ClassSlot & { scheduleId?: string };
};

/**
 * The live, read-only preview of a class write (`checkSlotConflictsAction`):
 * every conflict the change would meet across the whole period — the exact
 * computation the save runs (`computeSync`), so the list the person
 * confirms is the list the save checks. Writes nothing; an inactive class
 * has no sessions to check.
 */
export async function previewClassSessions(
  db: Db,
  centerId: string,
  classGroupId: string,
  change: ClassSessionsChange,
  options: { now?: Date; locale?: string } = {},
): Promise<{ conflicts: DatedConflict[]; created: number; deleted: number; kept: number }> {
  const none = { conflicts: [], created: 0, deleted: 0, kept: 0 };
  const current = await loadPlan(db, centerId, classGroupId);
  if (!current || !current.active) return none;
  const { slot } = change;
  const slots = !slot
    ? current.plan.slots
    : slot.scheduleId
      ? await db.classSchedule
          .findMany({ where: scopedWhere(centerId, { classGroupId }), select: { id: true, dayOfWeek: true, startTime: true, endTime: true } })
          .then((rows) =>
            rows.map((row) =>
              row.id === slot.scheduleId
                ? { dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime }
                : { dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime },
            ),
          )
      : [...current.plan.slots, { dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime }];
  const roomId = change.roomId !== undefined ? change.roomId : current.plan.roomId;
  const plan: ClassSessionPlan = {
    ...current.plan,
    teacherId: change.teacherId ?? current.plan.teacherId,
    roomId,
    extraRoomIds: roomId ? (change.extraRoomIds ?? current.plan.extraRoomIds) : [],
    startDate: change.startDate ?? current.plan.startDate,
    endDate: change.endDate ?? current.plan.endDate,
    slots,
  };
  if (classPeriodError(plan.startDate, plan.endDate)) return none;
  const sync = await computeSync(db, centerId, plan, current.baseline, options);
  return {
    conflicts: sync.conflicts,
    created: sync.toCreate.length,
    deleted: sync.toDelete.length,
    kept: sync.kept.length,
  };
}

/**
 * How many sessions a class has, cancelled ones aside — for list and detail.
 * U2: a session rescheduled away is not counted; its replacement is.
 */
export async function classSessionCounts(
  db: Db,
  centerId: string,
  classGroupIds: string[],
): Promise<Map<string, number>> {
  if (classGroupIds.length === 0) return new Map();
  const rows = await db.session.groupBy({
    by: ["classGroupId"],
    where: scopedWhere(centerId, {
      classGroupId: { in: classGroupIds },
      status: { not: CANCELLED },
      ...NOT_MOVED_SESSION,
    }),
    _count: { _all: true },
  });
  return new Map(
    rows.flatMap((row) => (row.classGroupId ? [[row.classGroupId, row._count._all] as const] : [])),
  );
}

// ── Manual sessions (R5) ───────────────────────────────────────────────────
//
// Two modes, one entry point ("New session" on the Sessions tab,
// docs/00 §5.1 "Manual and one-time sessions"):
// - **For a class** (`createManualSession`) — an extra session on an active
//   class. Price and cut are the class's, exactly as for a generated session
//   (`priceSnapshot` frozen now, cut read at payment time); the teacher
//   defaults to the class's and may be a substitute. Its enrolled students
//   are its roster and are marked absent at close like any class session.
// - **One-time** (`createOneOffSession`) — no class at all: its own title,
//   optional catalog subject/grade, teacher, room set, price and centre cut.
//   Everyone attending is a drop-in; late threshold = the centre's default.
//
// Both are `isManual`, so the engine never deletes or rewrites them. Both
// refuse a date before today in the centre's timezone (no backdating, ever —
// a time earlier today is fine), take R3's confirmation contract with a
// required `confirmConflicts`, and never refuse a holiday (the result says
// one is there, for a non-blocking notice).

const MAX_TITLE_LENGTH = 80;
const TEACHER: Role = "TEACHER";

/** What both modes share: who teaches, where, and when. */
export type ManualSessionSlot = {
  teacherId: string;
  roomId: string;
  extraRoomIds: string[];
  /** UTC-midnight day marker, like `Session.date`. */
  date: Date;
  startTime: string;
  endTime: string;
};

export type ManualSessionInput = ManualSessionSlot & { classGroupId: string };

export type OneOffSessionInput = ManualSessionSlot & {
  title: string;
  subjectId: string | null;
  gradeId: string | null;
  /** Piastres. */
  price: number;
  centerShareType: ShareType;
  /** A percent (PERCENTAGE) or the piastres the centre takes (FIXED). */
  centerShareValue: number;
};

export type ManualSessionError =
  | "pastDate"
  | "invalidTimeRange"
  | "classNotFound"
  | "teacherNotFound"
  | "subjectNotFound"
  | "gradeNotFound"
  | "subjectNotInGrade"
  | "invalidTitle"
  | "invalidPrice"
  | "invalidCut"
  | "fixedAbovePrice"
  | "duplicateSlot"
  | "duplicateSlotCancelled"
  | OneOffShapeError
  | RoomSetError;

export type CreateManualSessionResult =
  | { ok: true; sessionId: string; conflicts: DatedConflict[]; holiday: boolean }
  | ConflictRefusal
  | { ok: false; error: ManualSessionError };

type ManualSessionOptions = {
  confirmConflicts: boolean;
  actorUserId?: string | null;
  /** Injectable clock — the gate pins it; the app passes nothing. */
  now?: Date;
  locale?: string;
};

type CheckedSlot = {
  extraRoomIds: string[];
  conflicts: DatedConflict[];
  policy: ConflictPolicy;
  holiday: boolean;
};

/**
 * Everything both modes validate about the slot, read inside the write's own
 * transaction: the time range, no backdating (centre timezone), an active
 * teacher of THIS centre, a valid room set of this centre, the slot not
 * already held by the class, the holiday flag, and the conflict list. A
 * manual session is checked against **every** booking that day — its own
 * class's included (a substitute double-booked with the class's regular
 * session is a real clash), which is why the candidate carries no class.
 */
async function checkManualSlot(
  db: Db,
  centerId: string,
  slot: ManualSessionSlot,
  classGroupId: string | null,
  options: { now?: Date; locale?: string },
): Promise<{ ok: true; checked: CheckedSlot } | { ok: false; error: ManualSessionError }> {
  if (!isValidSlotTime(slot.startTime) || !isValidSlotTime(slot.endTime) || slot.startTime >= slot.endTime) {
    return { ok: false, error: "invalidTimeRange" };
  }
  const { timeZone, policy } = await centreScheduling(db, centerId);
  const clock = centreClock(options.now ?? new Date(), timeZone);
  if (dateKey(slot.date) < clock.todayKey) return { ok: false, error: "pastDate" };

  const teacher = await db.membership.findFirst({
    where: scopedWhere(centerId, { userId: slot.teacherId, role: TEACHER, active: true }),
    select: { id: true },
  });
  if (!teacher) return { ok: false, error: "teacherNotFound" };

  if (!slot.roomId) return { ok: false, error: "noPrimary" };
  const rooms = await resolveRoomSet(db, centerId, slot.roomId, slot.extraRoomIds);
  if (!rooms.ok) return { ok: false, error: rooms.error };

  // U2: a session rescheduled away no longer holds its slot; a cancelled one does.
  const taken = await slotTakenError(db, centerId, classGroupId, slot.date, slot.startTime);
  if (taken) return { ok: false, error: taken };

  const [occupancy, holiday] = await Promise.all([
    loadSessionOccupancy(db, centerId, options.locale ?? "en", slot.date, slot.date),
    db.holiday.count({ where: scopedWhere(centerId, { date: slot.date }) }),
  ]);
  const conflicts: DatedConflict[] = findSessionConflicts(
    {
      classGroupId: null,
      teacherId: slot.teacherId,
      roomId: slot.roomId,
      roomIds: rooms.set.roomIds,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
    },
    occupancy,
  ).map((conflict) => ({ ...conflict, date: dateKey(slot.date) }));

  return {
    ok: true,
    checked: { extraRoomIds: [...slot.extraRoomIds], conflicts, policy, holiday: holiday > 0 },
  };
}

function isValidSlotTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function isP2002(error: unknown): boolean {
  return error instanceof Object && "code" in error && (error as { code?: string }).code === "P2002";
}

/** Thrown inside the write transaction so any refusal writes nothing. */
class ManualSessionRefusal extends Error {
  readonly result: Exclude<CreateManualSessionResult, { ok: true }>;
  constructor(result: Exclude<CreateManualSessionResult, { ok: true }>) {
    super("Manual session refused.");
    this.result = result;
  }
}

/**
 * The one writer both modes share: check the slot, decide conflicts under
 * R3's contract, create the session and its extra rooms, audit the
 * confirmation (if any) and the create — all in one transaction.
 */
async function writeManualSession(
  db: PrismaClient,
  centerId: string,
  slot: ManualSessionSlot,
  classGroupId: string | null,
  data: (tx: Tx) => Promise<
    | { ok: true; fields: Prisma.SessionUncheckedCreateInput; mode: "extra" | "oneOff"; audit: Prisma.InputJsonObject }
    | { ok: false; error: ManualSessionError }
  >,
  options: ManualSessionOptions,
): Promise<CreateManualSessionResult> {
  try {
    return await db.$transaction(async (tx): Promise<CreateManualSessionResult> => {
      const resolved = await data(tx);
      if (!resolved.ok) throw new ManualSessionRefusal(resolved);
      const shapeError = oneOffSessionShapeError({
        classGroupId: resolved.fields.classGroupId ?? null,
        title: resolved.fields.title ?? null,
        teacherId: resolved.fields.teacherId ?? null,
        priceSnapshot: resolved.fields.priceSnapshot ?? null,
        centerShareType: resolved.fields.centerShareType ?? null,
        centerShareValue: resolved.fields.centerShareValue ?? null,
      });
      if (shapeError) throw new ManualSessionRefusal({ ok: false, error: shapeError });

      const check = await checkManualSlot(tx, centerId, slot, classGroupId, options);
      if (!check.ok) throw new ManualSessionRefusal(check);
      const { conflicts, policy, holiday, extraRoomIds } = check.checked;
      const decision = decideConflicts(conflicts.length, policy, options.confirmConflicts);
      if (decision === "denied") throw new ManualSessionRefusal({ ok: false, error: "conflict", conflicts });
      if (decision === "needsConfirmation") {
        throw new ManualSessionRefusal({ ok: false, error: "conflictsNeedConfirmation", conflicts });
      }

      const session = await tx.session.create({ data: { ...resolved.fields, centerId, isManual: true } });
      await writeSessionExtraRooms(tx, centerId, session.id, extraRoomIds);
      if (options.confirmConflicts && conflicts.length > 0) {
        await writeConfirmedConflictAudit(tx, {
          centerId,
          actorUserId: options.actorUserId ?? null,
          entityType: "Session",
          entityId: session.id,
          context: "session.create",
          conflicts,
        });
      }
      await audit(tx, {
        centerId,
        actorUserId: options.actorUserId,
        action: "session.create",
        entityType: "Session",
        entityId: session.id,
        after: {
          mode: resolved.mode,
          ...resolved.audit,
          teacherId: slot.teacherId,
          roomId: slot.roomId,
          extraRoomIds,
          date: dateKey(slot.date),
          startTime: slot.startTime,
          endTime: slot.endTime,
          priceSnapshot: resolved.fields.priceSnapshot ?? 0,
          holiday,
        },
      });
      return { ok: true, sessionId: session.id, conflicts: options.confirmConflicts ? conflicts : [], holiday };
    }, WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ManualSessionRefusal) return error.result;
    // The partial (classGroupId, date, startTime) unique index — U2: every
    // session there but one rescheduled away — backstops a concurrent create.
    if (isP2002(error)) return { ok: false, error: "duplicateSlot" };
    throw error;
  }
}

/**
 * **For a class** — an extra session on an existing, active class of this
 * centre. Price frozen from the class now (`priceSnapshot`), cut inherited
 * from the class at payment time (no per-session cut is set). `teacherId`
 * is the class's teacher or a substitute — either way an active teacher here.
 */
export async function createManualSession(
  db: PrismaClient,
  centerId: string,
  input: ManualSessionInput,
  options: ManualSessionOptions,
): Promise<CreateManualSessionResult> {
  return writeManualSession(
    db,
    centerId,
    input,
    input.classGroupId,
    async (tx) => {
      const classGroup = await tx.classGroup.findFirst({
        where: scopedWhere(centerId, { id: input.classGroupId, active: true }),
        select: { id: true, price: true, teacherId: true },
      });
      if (!classGroup) return { ok: false, error: "classNotFound" };
      return {
        ok: true,
        mode: "extra",
        audit: { classGroupId: classGroup.id, substitute: input.teacherId !== classGroup.teacherId },
        fields: {
          centerId,
          classGroupId: classGroup.id,
          teacherId: input.teacherId,
          roomId: input.roomId,
          date: input.date,
          startTime: input.startTime,
          endTime: input.endTime,
          priceSnapshot: classGroup.price,
        },
      };
    },
    options,
  );
}

/**
 * **One-time** — a session that belongs to no class. Its title, price and
 * centre cut are its own (the invariant in lib/db/sessions.ts), its optional
 * subject and grade must be catalog entries THIS centre has selected and
 * keeps active, and its cut follows the class form's bounds (a whole percent
 * 0–100, or FIXED piastres). The split itself stays lib/money.ts's.
 */
export async function createOneOffSession(
  db: PrismaClient,
  centerId: string,
  input: OneOffSessionInput,
  options: ManualSessionOptions,
): Promise<CreateManualSessionResult> {
  return writeManualSession(
    db,
    centerId,
    input,
    null,
    async (tx) => {
      const title = input.title.trim();
      if (title.length === 0 || title.length > MAX_TITLE_LENGTH) return { ok: false, error: "invalidTitle" };
      // D-17: a price within the per-price cap; D-26: 0 is allowed (the form
      // warns and the receipt flags it). D-15: a FIXED cut above the price is
      // refused.
      if (!Number.isInteger(input.price) || input.price < 0 || input.price > MAX_PRICE_PIASTRES) {
        return { ok: false, error: "invalidPrice" };
      }
      const value = input.centerShareValue;
      const cutError = centerCutError(input.price, input.centerShareType, value);
      if (cutError === "fixedAbovePrice") return { ok: false, error: "fixedAbovePrice" };
      if (cutError) return { ok: false, error: "invalidCut" };
      if (input.subjectId) {
        const subject = await centerSubjectById(tx, centerId, input.subjectId);
        if (!subject || !subject.active || !subject.catalogActive) return { ok: false, error: "subjectNotFound" };
      }
      if (input.gradeId) {
        const grade = await centerGradeById(tx, centerId, input.gradeId);
        if (!grade || !grade.active || !grade.catalogActive) return { ok: false, error: "gradeNotFound" };
      }
      // U3: both picked and active (above) and linked in the catalog.
      if (input.subjectId && input.gradeId && !(await isPairLinked(tx, input.gradeId, input.subjectId))) {
        return { ok: false, error: "subjectNotInGrade" };
      }
      return {
        ok: true,
        mode: "oneOff",
        audit: {
          zeroPrice: input.price === 0,
          subjectId: input.subjectId,
          gradeId: input.gradeId,
          centerShareType: input.centerShareType,
          centerShareValue: value,
        },
        fields: {
          centerId,
          classGroupId: null,
          title,
          subjectId: input.subjectId,
          gradeId: input.gradeId,
          teacherId: input.teacherId,
          roomId: input.roomId,
          date: input.date,
          startTime: input.startTime,
          endTime: input.endTime,
          priceSnapshot: input.price,
          centerShareType: input.centerShareType,
          centerShareValue: value,
        },
      };
    },
    options,
  );
}

/**
 * The live, read-only preview of a manual session (`checkSlotConflictsAction`
 * in its "session" mode): the conflict list and holiday flag the create
 * would decide on — the same `checkManualSlot` — so the list a person
 * confirms is the list the save checks. Anything not yet valid previews as
 * nothing; the save reports the actual error.
 */
export async function previewManualSession(
  db: Db,
  centerId: string,
  slot: ManualSessionSlot & { classGroupId: string | null },
  options: { now?: Date; locale?: string } = {},
): Promise<{ conflicts: DatedConflict[]; holiday: boolean }> {
  const check = await checkManualSlot(db, centerId, slot, slot.classGroupId, options);
  if (!check.ok) return { conflicts: [], holiday: false };
  return { conflicts: check.checked.conflicts, holiday: check.checked.holiday };
}

// ── Deleting a manual session (R5) ─────────────────────────────────────────

/** Why a manual session may not be deleted — empty = it may be. */
export type ManualSessionDeleteBlocker =
  | "notManual"
  | "started"
  | "notScheduled"
  | "closed"
  | "attendees"
  | "payments"
  | "settlement"
  | "ratings"
  | "shareOverride"
  | "rescheduled";

/**
 * The delete rule for a manual or one-time session: it must be manual (an
 * engine-made class session is the engine's to remove), not yet started in
 * the centre's timezone, and untouched — SCHEDULED, not closed, no
 * attendee, payment, settlement or rating, no reschedule link, and no
 * per-session cut override (on a class session; a one-time session's cut is
 * its own, not an override). Anything else can only be cancelled.
 */
export function manualSessionDeleteBlockers(
  session: {
    classGroupId: string | null;
    isManual: boolean;
    date: Date;
    startTime: string;
    status: SessionStatus;
    closedAt: Date | null;
    centerShareType: ShareType | null;
    centerShareValue: number | null;
    rescheduledToId: string | null;
    rescheduledFrom: { id: string } | null;
    timezone?: string | null;
    _count: { attendees: number; payments: number; settlements: number; ratings: number };
  },
  now: Date,
  timeZone: string,
): ManualSessionDeleteBlocker[] {
  const blockers: ManualSessionDeleteBlocker[] = [];
  if (session.classGroupId !== null && !session.isManual) blockers.push("notManual");
  if (hasStarted(session, centreClock(now, sessionTimeZone(session, timeZone)))) blockers.push("started");
  if (session.status !== SCHEDULED) blockers.push("notScheduled");
  if (session.closedAt) blockers.push("closed");
  if (session._count.attendees > 0) blockers.push("attendees");
  if (session._count.payments > 0) blockers.push("payments");
  if (session._count.settlements > 0) blockers.push("settlement");
  if (session._count.ratings > 0) blockers.push("ratings");
  if (session.classGroupId !== null && (session.centerShareType !== null || session.centerShareValue !== null)) {
    blockers.push("shareOverride");
  }
  if (session.rescheduledToId || session.rescheduledFrom) blockers.push("rescheduled");
  return blockers;
}

const DELETE_STATE_SELECT = {
  ...SESSION_STATE_SELECT,
  classGroupId: true,
  title: true,
} satisfies Prisma.SessionSelect;

/** A session's delete blockers as the detail page shows them (no write). */
export async function manualSessionDeleteState(
  db: Db,
  centerId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<ManualSessionDeleteBlocker[] | null> {
  const row = await db.session.findFirst({ where: scopedWhere(centerId, { id: sessionId }), select: DELETE_STATE_SELECT });
  if (!row) return null;
  const { timeZone } = await centreScheduling(db, centerId);
  return manualSessionDeleteBlockers(row, now, timeZone);
}

export type DeleteManualSessionResult =
  | { ok: true }
  | { ok: false; error: "notFound" }
  | { ok: false; error: "sessionInUse"; blockers: ManualSessionDeleteBlocker[] };

/**
 * Hard-deletes a manual or one-time session that passes
 * `manualSessionDeleteBlockers` — refused by direct call otherwise (staff
 * cancel it instead). The row is locked first, and the delete re-asserts
 * "untouched" in its own `WHERE` (`UNTOUCHED`, which pins `closedAt: null`),
 * so a check-in or payment landing mid-delete keeps the session, and a
 * closed session can never be deleted. Audited (`session.delete`).
 */
export async function deleteManualSession(
  db: PrismaClient,
  centerId: string,
  sessionId: string,
  options: { actorUserId?: string | null; now?: Date } = {},
): Promise<DeleteManualSessionResult> {
  return db.$transaction(async (tx): Promise<DeleteManualSessionResult> => {
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${sessionId} AND "centerId" = ${centerId} FOR UPDATE`;
    const row = await tx.session.findFirst({ where: scopedWhere(centerId, { id: sessionId }), select: DELETE_STATE_SELECT });
    if (!row) return { ok: false, error: "notFound" };
    const { timeZone } = await centreScheduling(tx, centerId);
    const blockers = manualSessionDeleteBlockers(row, options.now ?? new Date(), timeZone);
    if (blockers.length > 0) return { ok: false, error: "sessionInUse", blockers };

    const pristineWhere: Prisma.SessionWhereInput =
      row.classGroupId === null
        ? { ...UNTOUCHED, classGroupId: null }
        : { ...NO_OVERRIDE, isManual: true };
    const deleted = await tx.session.deleteMany({ where: scopedWhere(centerId, { id: sessionId, ...pristineWhere }) });
    if (deleted.count === 0) return { ok: false, error: "sessionInUse", blockers: ["attendees"] };
    await audit(tx, {
      centerId,
      actorUserId: options.actorUserId,
      action: "session.delete",
      entityType: "Session",
      entityId: sessionId,
      before: {
        mode: row.classGroupId === null ? "oneOff" : "extra",
        classGroupId: row.classGroupId,
        teacherId: row.teacherId,
        roomId: row.roomId,
        date: dateKey(row.date),
        startTime: row.startTime,
        endTime: row.endTime,
      },
    });
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}
