import type { Prisma, PrismaClient, Role, SessionStatus } from "@prisma/client";

// Relative imports on purpose — `npm run check:rooms` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/sessions.ts).
import { catalogLabel } from "../catalog.ts";
import { fullName, localName } from "../identity.ts";
import { effectiveRoomIds } from "../rooms.ts";
import {
  type ExistingSession,
  type ScheduleConflict,
  type SlotConflictInfo,
} from "../scheduling.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The conflict universe and its presentation (R3, docs/02 §11). Every
 * slot-writing path — the class-sessions engine (a class's create, its
 * slots, period, teacher or room set, reactivation — R4), reschedule, a
 * session's own room change, NEW_SESSION approval — and the read-only live
 * preview (`checkSlotConflictsAction`) load occupancy through here, so
 * "which bookings occupy which rooms" has one answer:
 *
 * - a booking occupies its **whole room set** — primary room plus every
 *   extra (`SessionRoom` / `ClassGroupRoom`);
 * - a CANCELLED session, and the original slot of a RESCHEDULED one
 *   (`rescheduledToId` set), occupy nothing;
 * - a closed session still occupies its slot (it happened);
 * - R4: a **deactivated** class's sessions occupy nothing unless they are
 *   closed records — deactivating deletes or cancels its future sessions,
 *   and this keeps a straggler from blocking anyone (`OPEN_CLASS_SESSION`).
 *
 * Since R4 there is no weekly-slot occupancy: every active class's sessions
 * exist for its whole period, so the dated sessions are the whole truth.
 */

/**
 * R4: "this session belongs to a class that is still running, or it is a
 * closed record". The one `where` fragment every forward-looking session
 * reader adds — occupancy here, today's lists, the teacher's and the
 * student's upcoming sessions (docs/00 §5.1 "Deactivate, reactivate,
 * delete") — so a deactivated class disappears from every forward surface
 * while its closed history stays readable everywhere else.
 */
export const OPEN_CLASS_SESSION = {
  OR: [{ classGroup: { active: true } }, { closedAt: { not: null } }],
} satisfies Prisma.SessionWhereInput;

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
      ...OPEN_CLASS_SESSION,
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
