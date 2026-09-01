import type { ConflictPolicy, PrismaClient, SessionStatus } from "@prisma/client";

// Relative imports on purpose: `npm run check:classes` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/students.ts
// and lib/db/tenant-scope.ts). The Prisma client is *injected* rather than
// imported from lib/db/client.ts for the same reason — the gate script
// constructs its own `PrismaClient()`, the app passes the shared singleton.
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import {
  GENERATION_WINDOW_DAYS,
  addDays,
  findSessionConflicts,
  generateOccurrenceDates,
  startOfUtcDay,
  type ExistingSession,
  type ScheduleConflict,
} from "../scheduling.ts";

/**
 * The session generator (docs/02-architecture.md §11, spec §5 "Scheduling"):
 * materializes `Session` rows from `ClassSchedule` on a rolling window,
 * snapshotting the class price, skipping the holiday calendar, and detecting
 * teacher/room conflicts against every other class in the center.
 *
 * Regeneration is idempotent: `Session` is unique on
 * `(classGroupId, date, startTime)`, so a `createMany({ skipDuplicates: true })`
 * against that key never duplicates a session a previous run already created —
 * running this twice in a row creates zero new rows the second time.
 */

export type GenerationConflict = ScheduleConflict & { date: string };

export type GenerateSessionsResult = {
  created: number;
  conflicts: GenerationConflict[];
};

type ClassForGeneration = {
  id: string;
  teacherId: string;
  roomId: string | null;
  branchId: string | null;
  price: number;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  className: string;
};

/** The class fields the generator needs, loaded once per run. */
async function loadClassesForGeneration(
  db: PrismaClient,
  centerId: string,
  classGroupId?: string,
): Promise<ClassForGeneration[]> {
  const rows = await db.classGroup.findMany({
    where: scopedWhere(centerId, {
      active: true,
      ...(classGroupId ? { id: classGroupId } : {}),
    }),
    select: {
      id: true,
      teacherId: true,
      roomId: true,
      room: { select: { branchId: true } },
      price: true,
      schedules: {
        select: { dayOfWeek: true, startTime: true, endTime: true },
      },
      subject: { select: { name: true } },
      grade: { select: { name: true } },
    },
  });

  return rows
    .filter((row) => row.schedules.length > 0)
    .map((row) => ({
      id: row.id,
      teacherId: row.teacherId,
      roomId: row.roomId,
      branchId: row.room?.branchId ?? null,
      price: row.price,
      schedules: row.schedules,
      className: [row.subject?.name, row.grade?.name].filter(Boolean).join(" · ") || "—",
    }));
}

/** Every existing, non-cancelled session in the window — the conflict universe. */
const CANCELLED: SessionStatus = "CANCELLED";

async function loadExistingSessions(
  db: PrismaClient,
  centerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ExistingSession[]> {
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, {
      date: { gte: windowStart, lte: windowEnd },
      status: { not: CANCELLED },
    }),
    select: {
      classGroupId: true,
      teacherId: true,
      roomId: true,
      date: true,
      startTime: true,
      endTime: true,
      classGroup: {
        select: {
          subject: { select: { name: true } },
          grade: { select: { name: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    classGroupId: row.classGroupId,
    teacherId: row.teacherId,
    roomId: row.roomId,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    className:
      [row.classGroup.subject?.name, row.classGroup.grade?.name]
        .filter(Boolean)
        .join(" · ") || "—",
  }));
}

async function loadHolidayKeys(
  db: PrismaClient,
  centerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Set<string>> {
  const rows = await db.holiday.findMany({
    where: scopedWhere(centerId, { date: { gte: windowStart, lte: windowEnd } }),
    select: { date: true },
  });
  return new Set(rows.map((row) => row.date.toISOString().slice(0, 10)));
}

/**
 * Generates sessions for one class (or, when `classGroupId` is omitted, every
 * active class in the center) across the rolling window starting today.
 * Conflicting occurrences are skipped under `DENY` and created-but-flagged
 * under `WARN` — either way, the caller gets back what happened so the UI can
 * show it.
 */
export async function generateSessions(
  db: PrismaClient,
  centerId: string,
  conflictPolicy: ConflictPolicy,
  classGroupId?: string,
): Promise<GenerateSessionsResult> {
  const windowStart = startOfUtcDay(new Date());
  const windowEnd = addDays(windowStart, GENERATION_WINDOW_DAYS);

  const [classes, holidayKeys, existing] = await Promise.all([
    loadClassesForGeneration(db, centerId, classGroupId),
    loadHolidayKeys(db, centerId, windowStart, windowEnd),
    loadExistingSessions(db, centerId, windowStart, windowEnd),
  ]);

  // Accumulates as we go, so two classes generated in the same run still see
  // each other's freshly-created occurrences when checking for conflicts.
  const known = [...existing];
  const conflicts: GenerationConflict[] = [];
  const toInsert: {
    classGroupId: string;
    teacherId: string;
    roomId: string | null;
    branchId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    priceSnapshot: number;
  }[] = [];

  for (const classGroup of classes) {
    for (const schedule of classGroup.schedules) {
      const dates = generateOccurrenceDates(
        schedule,
        windowStart,
        windowEnd,
        holidayKeys,
      );

      for (const date of dates) {
        const candidate = {
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        };

        const found = findSessionConflicts(candidate, known);
        if (found.length > 0) {
          for (const conflict of found) {
            conflicts.push({ ...conflict, date: date.toISOString().slice(0, 10) });
          }
          if (conflictPolicy === "DENY") continue;
        }

        toInsert.push({
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          branchId: classGroup.branchId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          priceSnapshot: classGroup.price,
        });
        known.push({
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          className: classGroup.className,
        });
      }
    }
  }

  if (toInsert.length === 0) return { created: 0, conflicts };

  const result = await db.session.createMany({
    data: toInsert.map((row) => scopedData(centerId, row)),
    skipDuplicates: true,
  });

  return { created: result.count, conflicts };
}
