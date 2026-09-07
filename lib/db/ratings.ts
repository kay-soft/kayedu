import type { Prisma, PrismaClient } from "@prisma/client";
// Relative imports on purpose — `npm run check:ratings` exercises this module
// directly, outside the Next.js runtime (same reasoning as
// lib/db/student-portal.ts and lib/db/parents.ts).

/**
 * Teacher ratings (M17, docs/00-master-product-spec.md §5 "Teacher ratings").
 * Every read/write here is identity-scoped by `studentUserId` or by the
 * teacher's global `teacherId` — never by `centerId` — because the whole
 * point is a rating that follows the teacher across every centre they work
 * at (see the doc comment on `SessionRating` in prisma/schema.prisma). This
 * module has no entry in `lib/db/scoped.ts` for the same reason.
 *
 * The teacher-facing half of this file is deliberately narrow: the only
 * exported reads are `teacherRatingAverage`/`teacherRatingAverages`, both
 * `{ average }`-only. There is no function here — and must never be one —
 * that lists raw `SessionRating` rows by `teacherId`, because that row
 * carries `studentUserId`, the exact identity the teacher must never be able
 * to reach.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Rounded to one decimal — "however's sensible" per the M17 brief. */
function roundRating(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Write path: student rates or skips a session they attended ─────────────

export type PendingRatingSession = {
  sessionId: string;
  centerId: string;
  teacherId: string;
  date: Date;
  subjectId: string | null;
  gradeId: string | null;
};

/**
 * Sessions this student **attended** (has a `SessionAttendee` row — not
 * merely enrolled) in the last 7 days, that they have neither rated nor
 * explicitly skipped yet. This is the entire query behind the login pop-up.
 * Identity-scoped across every centre the student has ever attended a
 * session at, the same cross-centre shape `lib/db/student-portal.ts` already
 * uses for a student's own reservations/enrollments.
 */
export async function attendedSessionsToRate(
  db: Db,
  studentUserId: string,
  now: Date,
): Promise<PendingRatingSession[]> {
  const from = new Date(now.getTime() - SEVEN_DAYS_MS);

  const attendeeRows = await db.sessionAttendee.findMany({
    where: {
      studentProfile: { userId: studentUserId },
      session: { date: { gte: from, lte: now } },
    },
    distinct: ["sessionId"],
    select: {
      sessionId: true,
      session: {
        select: {
          id: true,
          centerId: true,
          teacherId: true,
          date: true,
          classGroup: { select: { subjectId: true, gradeId: true } },
        },
      },
    },
  });
  if (attendeeRows.length === 0) return [];

  const sessionIds = attendeeRows.map((row) => row.sessionId);
  const [rated, skipped] = await Promise.all([
    db.sessionRating.findMany({
      where: { studentUserId, sessionId: { in: sessionIds } },
      select: { sessionId: true },
    }),
    db.sessionRatingSkip.findMany({
      where: { studentUserId, sessionId: { in: sessionIds } },
      select: { sessionId: true },
    }),
  ]);
  const excluded = new Set([
    ...rated.map((row) => row.sessionId),
    ...skipped.map((row) => row.sessionId),
  ]);

  return attendeeRows
    .filter((row) => !excluded.has(row.sessionId))
    .map((row) => ({
      sessionId: row.session.id,
      centerId: row.session.centerId,
      teacherId: row.session.teacherId,
      date: row.session.date,
      subjectId: row.session.classGroup.subjectId,
      gradeId: row.session.classGroup.gradeId,
    }));
}

export type SubmitSessionRatingResult =
  | { ok: true }
  | { ok: false; error: "notAttended" | "alreadyRated" };

/**
 * Records one rating. Re-checks attendance itself rather than trusting the
 * pop-up's own list — the same "never trust the client, re-derive from the
 * database" discipline every other student-facing write in this app follows
 * (`lib/db/reservations.ts`'s `reserveOrEnroll`).
 */
export async function submitSessionRating(
  db: Db,
  params: { studentUserId: string; sessionId: string; score: number },
): Promise<SubmitSessionRatingResult> {
  const attendee = await db.sessionAttendee.findFirst({
    where: {
      sessionId: params.sessionId,
      studentProfile: { userId: params.studentUserId },
    },
    select: { session: { select: { teacherId: true } } },
  });
  if (!attendee) return { ok: false, error: "notAttended" };

  const existing = await db.sessionRating.findUnique({
    where: {
      studentUserId_sessionId: {
        studentUserId: params.studentUserId,
        sessionId: params.sessionId,
      },
    },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "alreadyRated" };

  await db.sessionRating.create({
    data: {
      studentUserId: params.studentUserId,
      sessionId: params.sessionId,
      teacherId: attendee.session.teacherId,
      score: params.score,
    },
  });
  return { ok: true };
}

/**
 * Records a skip. Idempotent (`skipDuplicates`) and always succeeds — a skip
 * is not an assertion about anything, just "don't ask again for this one."
 */
export async function skipSessionRating(
  db: Db,
  params: { studentUserId: string; sessionId: string },
): Promise<void> {
  await db.sessionRatingSkip.createMany({
    data: [{ studentUserId: params.studentUserId, sessionId: params.sessionId }],
    skipDuplicates: true,
  });
}

// ── Read path: the published, average-only aggregate ───────────────────────

/**
 * One teacher's platform-wide average — `{ average }` and **nothing else**,
 * not just in the UI but in the shape of the object itself, so a teacher with
 * one rating and a teacher with a hundred are indistinguishable by any caller
 * of this function (spec §5 "Teacher ratings"). `null` means zero ratings.
 */
export async function teacherRatingAverage(
  db: Db,
  teacherId: string,
): Promise<{ average: number | null }> {
  const result = await db.sessionRating.aggregate({
    where: { teacherId },
    _avg: { score: true },
  });
  const avg = result._avg.score;
  return { average: avg === null ? null : roundRating(avg) };
}

/**
 * The same average, batched for many teachers at once (a Discover page's
 * class cards, a centre's teacher list) — one `groupBy` instead of one query
 * per teacher (docs/02-architecture.md §14). A teacher absent from the
 * result (zero ratings) is the caller's job to default to `null`, exactly
 * like `teacherRatingAverage` returns for that same case.
 */
export async function teacherRatingAverages(
  db: Db,
  teacherIds: string[],
): Promise<Map<string, number>> {
  if (teacherIds.length === 0) return new Map();

  const rows = await db.sessionRating.groupBy({
    by: ["teacherId"],
    where: { teacherId: { in: teacherIds } },
    _avg: { score: true },
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    if (row._avg.score !== null) map.set(row.teacherId, roundRating(row._avg.score));
  }
  return map;
}
