/**
 * Teacher ratings check — the M17 acceptance gate (docs/03-build-order.md M17
 * "Gates"): "average-only aggregate, no rater identity and no count on any
 * read path, the 7-day window, cross-centre continuity."
 *
 * Run with:  npm run check:ratings
 *
 * Exercises `lib/db/ratings.ts` directly (no `@/` imports — same reasoning
 * as `lib/db/parents.ts`/`lib/db/student-portal.ts`: this runs outside the
 * Next.js runtime), plus a static sweep of that module's own exports —
 * because "the teacher can never reach rater identity through any path" is
 * partly a code-shape guarantee, not just a runtime one: no function in this
 * module may ever list raw `SessionRating` rows by `teacherId`, since that
 * row carries `studentUserId`. A future PR quietly adding one is exactly
 * what the sweep below is for.
 *
 * Six parts:
 *  1. Average-only shape — `teacherRatingAverage`/`teacherRatingAverages`
 *     return (or map to) an object/number with no `count` field anywhere,
 *     for a teacher with more than one rating (so "no count" isn't a
 *     coincidence of a small sample).
 *  2. The 7-day window — a session attended 10 days ago never appears in
 *     the pop-up's candidate list; one attended 2 days ago does.
 *  3. Attended, not just enrolled — a session the student is only enrolled
 *     in (no `SessionAttendee` row) never appears, even when recent.
 *  4. Skippability — an explicit skip removes a session from the candidate
 *     list and it never resurfaces on a later call (simulating "next
 *     login"); an already-rated session is excluded the same way.
 *  5. Rating writes — `notAttended`/`alreadyRated` refusals, and a
 *     successful rating actually lands with the session's `teacherId`
 *     denormalized onto it.
 *  6. Cross-centre continuity — the same teacher's aggregate sums ratings
 *     earned at two different centres into one number, because the
 *     function takes only a global `teacherId` and no `centerId` exists
 *     anywhere in this module to vary in the first place.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  attendedSessionsToRate,
  skipSessionRating,
  submitSessionRating,
  teacherRatingAverage,
  teacherRatingAverages,
} from "../lib/db/ratings.ts";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SLUG_A = "ratings-check-a";
const SLUG_B = "ratings-check-b";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "ratings-check-" } } });
}

async function makeCenter(slug: string, name: string) {
  return prisma.center.create({ data: { slug, name, organization: { create: { name } } } });
}

async function makeUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "U", lastName: tag, email: `ratings-check-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeStudentProfile(centerId: string, userId: string, tag: string) {
  return prisma.studentProfile.create({
    data: { centerId, userId, studentCode: `RC-${tag}`, firstName: "S", lastName: tag },
  });
}

async function makeClassGroup(centerId: string, teacherId: string) {
  return prisma.classGroup.create({
    data: { centerId, teacherId, price: 10_000, capacity: 0 },
  });
}

async function makeSession(centerId: string, classGroupId: string, teacherId: string, date: Date) {
  return prisma.session.create({
    data: {
      centerId,
      classGroupId,
      teacherId,
      date,
      startTime: "10:00",
      endTime: "11:00",
      status: "COMPLETED",
      priceSnapshot: 10_000,
    },
  });
}

async function attend(centerId: string, sessionId: string, studentProfileId: string, recordedBy: string) {
  return prisma.sessionAttendee.create({
    data: { centerId, sessionId, studentProfileId, attendanceStatus: "PRESENT", recordedBy },
  });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// ── Static sweep: the module's exported surface never grows a "list rows by
// teacherId" function ─────────────────────────────────────────────────────

function checkExportedSurface() {
  console.log("Static sweep: lib/db/ratings.ts exports");
  const source = readFileSync(`${ROOT}/lib/db/ratings.ts`, "utf8");
  const exported = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  const expected = [
    "attendedSessionsToRate",
    "submitSessionRating",
    "skipSessionRating",
    "teacherRatingAverage",
    "teacherRatingAverages",
  ];
  check(
    "lib/db/ratings.ts exports exactly the expected functions — no raw list-by-teacherId read has been added",
    exported.length === expected.length && expected.every((name) => exported.includes(name)),
    JSON.stringify(exported),
  );
}

async function main() {
  await cleanup();
  checkExportedSurface();

  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A, "Ratings Check A");
  const centerB = await makeCenter(SLUG_B, "Ratings Check B");

  const teacher = await makeUser("teacher");
  const studentA = await makeUser("studentA");
  const studentB = await makeUser("studentB");

  const profileA = await makeStudentProfile(centerA.id, studentA.id, "a");
  const profileB = await makeStudentProfile(centerB.id, studentB.id, "b");

  const classA = await makeClassGroup(centerA.id, teacher.id);
  const classB = await makeClassGroup(centerB.id, teacher.id);

  // ── 1 & 3. The 7-day window, and attended-not-just-enrolled ──────────────
  const recentSession = await makeSession(centerA.id, classA.id, teacher.id, daysAgo(2));
  const oldSession = await makeSession(centerA.id, classA.id, teacher.id, daysAgo(10));
  const enrolledOnlySession = await makeSession(centerA.id, classA.id, teacher.id, daysAgo(1));

  await attend(centerA.id, recentSession.id, profileA.id, teacher.id);
  await attend(centerA.id, oldSession.id, profileA.id, teacher.id);
  // enrolledOnlySession deliberately gets an Enrollment but no SessionAttendee.
  await prisma.enrollment.create({
    data: { centerId: centerA.id, studentProfileId: profileA.id, classGroupId: classA.id },
  });

  const now = new Date();
  const pendingBeforeRating = await attendedSessionsToRate(prisma, studentA.id, now);
  const pendingIds = pendingBeforeRating.map((row) => row.sessionId);

  check(
    "A session attended 2 days ago appears in the pending-to-rate list",
    pendingIds.includes(recentSession.id),
    JSON.stringify(pendingIds),
  );
  check(
    "A session attended 10 days ago is excluded by the 7-day window",
    !pendingIds.includes(oldSession.id),
    JSON.stringify(pendingIds),
  );
  check(
    "A session with only an Enrollment (no SessionAttendee row) never appears, even though it's recent",
    !pendingIds.includes(enrolledOnlySession.id),
    JSON.stringify(pendingIds),
  );

  // ── 5. Rating writes: refusals and success ────────────────────────────────
  const notAttended = await submitSessionRating(prisma, {
    studentUserId: studentA.id,
    sessionId: enrolledOnlySession.id,
    score: 5,
  });
  check(
    "Rating a session with no attendance is refused as notAttended",
    !notAttended.ok && notAttended.error === "notAttended",
    JSON.stringify(notAttended),
  );

  const rated = await submitSessionRating(prisma, {
    studentUserId: studentA.id,
    sessionId: recentSession.id,
    score: 5,
  });
  check("Rating an attended, unrated session succeeds", rated.ok, JSON.stringify(rated));

  const storedRating = await prisma.sessionRating.findUnique({
    where: { studentUserId_sessionId: { studentUserId: studentA.id, sessionId: recentSession.id } },
  });
  check(
    "The stored rating denormalizes the session's teacherId, same pattern as Payment.teacherId",
    storedRating?.teacherId === teacher.id,
    JSON.stringify(storedRating),
  );

  const duplicateRating = await submitSessionRating(prisma, {
    studentUserId: studentA.id,
    sessionId: recentSession.id,
    score: 3,
  });
  check(
    "Re-rating the same session is refused as alreadyRated",
    !duplicateRating.ok && duplicateRating.error === "alreadyRated",
    JSON.stringify(duplicateRating),
  );

  const pendingAfterRating = await attendedSessionsToRate(prisma, studentA.id, now);
  check(
    "An already-rated session no longer appears in the pending list",
    !pendingAfterRating.map((row) => row.sessionId).includes(recentSession.id),
    JSON.stringify(pendingAfterRating.map((row) => row.sessionId)),
  );

  // ── 4. Skippability ────────────────────────────────────────────────────────
  const skippableSession = await makeSession(centerA.id, classA.id, teacher.id, daysAgo(3));
  await attend(centerA.id, skippableSession.id, profileA.id, teacher.id);

  const pendingWithSkippable = await attendedSessionsToRate(prisma, studentA.id, now);
  check(
    "The skippable session appears in the pending list before being skipped",
    pendingWithSkippable.map((row) => row.sessionId).includes(skippableSession.id),
  );

  await skipSessionRating(prisma, { studentUserId: studentA.id, sessionId: skippableSession.id });
  const pendingAfterSkip = await attendedSessionsToRate(prisma, studentA.id, now);
  check(
    "A skipped session is excluded immediately",
    !pendingAfterSkip.map((row) => row.sessionId).includes(skippableSession.id),
    JSON.stringify(pendingAfterSkip.map((row) => row.sessionId)),
  );

  // Simulate "never re-prompt at next login": calling the same read again,
  // fresh, later, still excludes it — no re-prompt window, no expiry.
  const pendingMuchLater = await attendedSessionsToRate(prisma, studentA.id, new Date(now.getTime() + 60_000));
  check(
    "The same skip still holds on a later, independent call — skipping costs nothing, permanently, for that session",
    !pendingMuchLater.map((row) => row.sessionId).includes(skippableSession.id),
  );

  const skipAgain = await skipSessionRating(prisma, {
    studentUserId: studentA.id,
    sessionId: skippableSession.id,
  });
  check("Skipping an already-skipped session is a harmless no-op", skipAgain === undefined);

  // ── 6. Cross-centre continuity + average-only aggregate ───────────────────
  const sessionB = await makeSession(centerB.id, classB.id, teacher.id, daysAgo(1));
  await attend(centerB.id, sessionB.id, profileB.id, teacher.id);
  const ratedB = await submitSessionRating(prisma, {
    studentUserId: studentB.id,
    sessionId: sessionB.id,
    score: 3,
  });
  check("Rating at a second, unrelated centre succeeds", ratedB.ok, JSON.stringify(ratedB));

  // Two ratings for the same global teacherId, earned at two different
  // centres: 5 (centre A) and 3 (centre B) → average 4. There is no
  // centerId parameter on teacherRatingAverage at all, so "queried from
  // Centre A's context" and "queried from Centre B's context" are, by
  // construction, the exact same call with the exact same result.
  const aggregate = await teacherRatingAverage(prisma, teacher.id);
  check(
    "The cross-centre average is the correct combined figure (5 and 3 → 4)",
    aggregate.average === 4,
    JSON.stringify(aggregate),
  );
  check(
    "teacherRatingAverage's return shape carries only 'average' — no count field, even with two ratings on record",
    Object.keys(aggregate).length === 1 && Object.keys(aggregate)[0] === "average",
    JSON.stringify(Object.keys(aggregate)),
  );

  const batched = await teacherRatingAverages(prisma, [teacher.id]);
  check(
    "teacherRatingAverages (the batched Discover/list read) agrees with the single-teacher read",
    batched.get(teacher.id) === 4,
    JSON.stringify([...batched.entries()]),
  );
  check(
    "The batched map's values are plain numbers, not objects — structurally incapable of carrying a count alongside the average",
    typeof batched.get(teacher.id) === "number",
  );

  const untouchedTeacher = await makeUser("untouched");
  const zeroRatings = await teacherRatingAverage(prisma, untouchedTeacher.id);
  check(
    "A teacher with zero ratings gets { average: null }, not zero and not an omitted key",
    zeroRatings.average === null && Object.keys(zeroRatings).length === 1,
    JSON.stringify(zeroRatings),
  );
  const zeroBatched = await teacherRatingAverages(prisma, [untouchedTeacher.id]);
  check(
    "A zero-rating teacher is simply absent from the batched map (never a 0 or a count)",
    !zeroBatched.has(untouchedTeacher.id),
    JSON.stringify([...zeroBatched.entries()]),
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} rating check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll rating checks passed.");
  });
