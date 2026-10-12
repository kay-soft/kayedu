import type { Prisma, PrismaClient, Role, SessionStatus } from "@prisma/client";

// Relative imports on purpose — `npm run check:rooms` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/sessions.ts).
import { catalogLabel } from "../catalog.ts";
import { fullName, localName } from "../identity.ts";
import { effectiveRoomIds } from "../rooms.ts";
import {
  findScheduleConflicts,
  type ExistingScheduleSlot,
  type ExistingSession,
  type ScheduleConflict,
  type SlotConflictInfo,
} from "../scheduling.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The conflict universe and its presentation (R3, docs/02 §11). Every
 * slot-writing path — the generator, reschedule, a session's own room
 * change, NEW_SESSION approval, class schedule slots, a class's room/teacher
 * change — and the read-only live preview (`checkSlotConflictsAction`) load
 * occupancy through here, so "which bookings occupy which rooms" has one
 * answer:
 *
 * - a booking occupies its **whole room set** — primary room plus every
 *   extra (`SessionRoom` / `ClassGroupRoom`);
 * - a CANCELLED session, and the original slot of a RESCHEDULED one
 *   (`rescheduledToId` set), occupy nothing;
 * - a closed session still occupies its slot (it happened).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const CANCELLED: SessionStatus = "CANCELLED";
const TEACHER: Role = "TEACHER";

type CatalogName = { nameAr: string; nameEn: string } | null;

function classLabel(locale: string, subject: CatalogName, grade: CatalogName): string {
  return (
    [subject ? catalogLabel(locale, subject) : null, grade ? catalogLabel(locale, grade) : null]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}

/**
 * Every session in `[from, to]` (UTC-midnight day markers, inclusive) that
 * occupies anything, with its full room set.
 */
export async function loadSessionOccupancy(
  db: Db,
  centerId: string,
  locale: string,
  from: Date,
  to: Date,
): Promise<ExistingSession[]> {
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, {
      date: { gte: from, lte: to },
      status: { not: CANCELLED },
      rescheduledToId: null,
    }),
    select: {
      id: true,
      classGroupId: true,
      teacherId: true,
      roomId: true,
      date: true,
      startTime: true,
      endTime: true,
      extraRooms: { select: { roomId: true } },
      classGroup: {
        select: {
          subject: { select: { nameAr: true, nameEn: true } },
          grade: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    sessionId: row.id,
    classGroupId: row.classGroupId,
    teacherId: row.teacherId,
    roomId: row.roomId,
    roomIds: effectiveRoomIds(row.roomId, row.extraRooms.map((extra) => extra.roomId)),
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    className: classLabel(locale, row.classGroup.subject, row.classGroup.grade),
  }));
}

/**
 * Every *other* class's weekly slots, each carrying its class's teacher and
 * full room set — the candidate universe for a schedule-slot save.
 */
export async function loadScheduleOccupancy(
  db: Db,
  centerId: string,
  locale: string,
  excludeClassGroupId: string,
): Promise<ExistingScheduleSlot[]> {
  const rows = await db.classSchedule.findMany({
    where: scopedWhere(centerId, { classGroupId: { not: excludeClassGroupId } }),
    select: {
      classGroupId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      classGroup: {
        select: {
          teacherId: true,
          roomId: true,
          extraRooms: { select: { roomId: true } },
          subject: { select: { nameAr: true, nameEn: true } },
          grade: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    classGroupId: row.classGroupId,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    teacherId: row.classGroup.teacherId,
    roomId: row.classGroup.roomId,
    roomIds: effectiveRoomIds(
      row.classGroup.roomId,
      row.classGroup.extraRooms.map((extra) => extra.roomId),
    ),
    className: classLabel(locale, row.classGroup.subject, row.classGroup.grade),
  }));
}

/**
 * Conflicts → print-ready rows (`SlotConflictInfo`): the room's name, the
 * teacher's **local** name at this centre (CLAUDE.md rule 4 — never the
 * global `User` name when a local one exists), deduplicated. Every lookup is
 * `centerId`-scoped.
 */
export async function describeConflicts(
  db: Db,
  centerId: string,
  conflicts: readonly ScheduleConflict[],
): Promise<SlotConflictInfo[]> {
  if (conflicts.length === 0) return [];

  const roomIds = [...new Set(conflicts.flatMap((c) => (c.roomId ? [c.roomId] : [])))];
  const teacherIds = [...new Set(conflicts.flatMap((c) => (c.teacherId ? [c.teacherId] : [])))];

  const [rooms, memberships] = await Promise.all([
    roomIds.length > 0
      ? db.room.findMany({
          where: scopedWhere(centerId, { id: { in: roomIds } }),
          select: { id: true, name: true },
        })
      : [],
    teacherIds.length > 0
      ? db.membership.findMany({
          where: scopedWhere(centerId, { userId: { in: teacherIds }, role: TEACHER }),
          select: {
            userId: true,
            firstName: true,
            lastName: true,
            user: { select: { firstName: true, lastName: true } },
          },
        })
      : [],
  ]);
  const roomName = new Map(rooms.map((room) => [room.id, room.name]));
  const teacherName = new Map(
    memberships.map((row) => [row.userId, fullName(localName(row, row.user))]),
  );

  const seen = new Set<string>();
  const described: SlotConflictInfo[] = [];
  for (const conflict of conflicts) {
    const key = [
      conflict.type,
      conflict.sessionId ?? conflict.classGroupId,
      conflict.roomId ?? conflict.teacherId ?? "",
      conflict.date ?? conflict.dayOfWeek ?? "",
      conflict.startTime ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    described.push({
      type: conflict.type,
      className: conflict.className,
      roomName: conflict.roomId ? (roomName.get(conflict.roomId) ?? null) : null,
      teacherName: conflict.teacherId ? (teacherName.get(conflict.teacherId) ?? null) : null,
      date: conflict.date ?? null,
      dayOfWeek: conflict.dayOfWeek ?? null,
      startTime: conflict.startTime ?? null,
      endTime: conflict.endTime ?? null,
    });
  }
  return described;
}

/**
 * The audit row a **confirmed** double-booking writes (R3: "flag present +
 * WARN → save, and audit the conflicts that were confirmed"). Written by the
 * same transaction as the slot write wherever there is one, so a confirmed
 * double-booking can never be saved without its record.
 */
export async function writeConfirmedConflictAudit(
  db: Db,
  input: {
    centerId: string;
    actorUserId: string | null;
    entityType: string;
    entityId: string;
    /** What was being written, e.g. "session.reschedule". */
    context: string;
    conflicts: readonly ScheduleConflict[];
  },
): Promise<void> {
  if (input.conflicts.length === 0) return;
  await db.auditLog.create({
    data: {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "schedule.conflict.confirm",
      entityType: input.entityType,
      entityId: input.entityId,
      after: {
        context: input.context,
        conflicts: input.conflicts.map((conflict) => ({
          type: conflict.type,
          classGroupId: conflict.classGroupId,
          className: conflict.className,
          roomId: conflict.roomId ?? null,
          teacherId: conflict.teacherId ?? null,
          sessionId: conflict.sessionId ?? null,
          date: conflict.date ?? null,
          dayOfWeek: conflict.dayOfWeek ?? null,
          startTime: conflict.startTime ?? null,
          endTime: conflict.endTime ?? null,
        })),
      },
    },
  });
}

// ── Weekly slots (class schedules) ─────────────────────────────────────────

export type ClassSlotPlan = {
  teacherId: string;
  roomId: string | null;
  roomIds: string[];
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
};

/** A class's teacher, stored room set and weekly slots — what a check varies. */
export async function loadClassSlotPlan(
  db: Db,
  centerId: string,
  classGroupId: string,
): Promise<ClassSlotPlan | null> {
  const row = await db.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: {
      teacherId: true,
      roomId: true,
      extraRooms: { select: { roomId: true } },
      schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  });
  if (!row) return null;
  return {
    teacherId: row.teacherId,
    roomId: row.roomId,
    roomIds: effectiveRoomIds(row.roomId, row.extraRooms.map((extra) => extra.roomId)),
    slots: row.schedules,
  };
}

/**
 * Every clash `plan`'s weekly slots would have with every *other* class's
 * slots — a new or moved slot (`plan.slots` = that one slot), or a class's
 * new teacher / room set (`plan.slots` = all of its slots).
 */
export async function weeklySlotConflicts(
  db: Db,
  centerId: string,
  locale: string,
  classGroupId: string,
  plan: ClassSlotPlan,
): Promise<ScheduleConflict[]> {
  if (plan.slots.length === 0) return [];
  const existing = await loadScheduleOccupancy(db, centerId, locale, classGroupId);
  return plan.slots.flatMap((slot) =>
    findScheduleConflicts(
      { ...slot, teacherId: plan.teacherId, roomId: plan.roomId, roomIds: plan.roomIds },
      existing,
    ),
  );
}
