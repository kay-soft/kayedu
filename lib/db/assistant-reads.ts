import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assistants` reads these
// directly, outside the Next.js runtime, and asserts on the data they return.
import { classLabelSelect } from "./assessments.ts";
import { NOT_MOVED_SESSION } from "./slot-conflicts.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The assistant's Classes pages (W7b, D-W37 item 4), read-only: the teacher's
 * own classes at one branch, each class's sessions taught by the teacher on or
 * after the assistant's floor (D-W19), and its roster — **names only**. Every
 * select is explicit: no phone, no email, no code, no money. `students.phones`
 * reveals nothing in W7b because the teacher's own portal shows no student
 * phone (D-W37); the gate asserts no phone key in any of these rows.
 *
 * One branch per call (`centerId` from the teacher's own branch, never a
 * posted one) — the pages union them in memory (U7, rule 1).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const SCHEDULE_SELECT = { id: true, dayOfWeek: true, startTime: true, endTime: true } as const;

/** The teacher's classes at this branch, active first. */
export async function assistantClassList(db: Db, input: { centerId: string; teacherUserId: string }) {
  return db.classGroup.findMany({
    where: scopedWhere(input.centerId, { teacherId: input.teacherUserId }),
    select: {
      ...classLabelSelect(input.centerId),
      startDate: true,
      endDate: true,
      schedules: { select: SCHEDULE_SELECT, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
      _count: { select: { enrollments: { where: { status: "ACTIVE" as const } } } },
    },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }, { id: "asc" }],
  });
}

export type AssistantClassListRow = Awaited<ReturnType<typeof assistantClassList>>[number];

/** The roster: ACTIVE enrolments of active profiles, branch-local names only (rule 4). */
const ROSTER_SELECT = {
  id: true,
  studentProfile: {
    select: { id: true, firstName: true, lastName: true, user: { select: { firstName: true, lastName: true } } },
  },
} as const;

/**
 * One of the teacher's classes at this branch, or null (another teacher's, or
 * not at this branch): its schedule and period, the teacher's own sessions of
 * it from `floor` on (a moved original left out), and the roster's names.
 */
export async function assistantClassDetail(
  db: Db,
  input: { centerId: string; teacherUserId: string; classGroupId: string; floor: Date },
) {
  const classGroup = await db.classGroup.findFirst({
    where: scopedWhere(input.centerId, { id: input.classGroupId, teacherId: input.teacherUserId }),
    select: {
      ...classLabelSelect(input.centerId),
      startDate: true,
      endDate: true,
      schedules: { select: SCHEDULE_SELECT, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
    },
  });
  if (!classGroup) return null;
  const [sessions, roster] = await Promise.all([
    db.session.findMany({
      where: scopedWhere(input.centerId, {
        classGroupId: classGroup.id,
        teacherId: input.teacherUserId,
        date: { gte: input.floor },
        ...NOT_MOVED_SESSION,
      }),
      select: {
        id: true,
        date: true,
        startTime: true,
        endTime: true,
        status: true,
        timezone: true,
        closedAt: true,
        rescheduledToId: true,
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }, { id: "asc" }],
      take: 200,
    }),
    db.enrollment.findMany({
      where: scopedWhere(input.centerId, { classGroupId: classGroup.id, status: "ACTIVE" as const, studentProfile: { active: true } }),
      select: ROSTER_SELECT,
      take: 500,
    }),
  ]);
  return {
    classGroup,
    sessions,
    roster: roster.map((row) => ({
      id: row.studentProfile.id,
      firstName: row.studentProfile.firstName ?? row.studentProfile.user.firstName,
      lastName: row.studentProfile.lastName ?? row.studentProfile.user.lastName,
    })),
  };
}

export type AssistantClassDetail = NonNullable<Awaited<ReturnType<typeof assistantClassDetail>>>;
