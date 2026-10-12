/**
 * Rooms check — the R3 acceptance gate (docs/03-build-order.md "R3" "Done
 * when"): joinable rooms, multi-room classes/sessions, capacity from rooms,
 * and the explicit double-booking confirmation.
 *
 * Run with:  npm run check:rooms
 *
 * Exercises the real production modules — `lib/rooms.ts` (the pure room-set
 * rules), `lib/capacity.ts`, `lib/db/room-sets.ts` (links, room sets, usage),
 * `lib/db/slot-conflicts.ts` (occupancy), `lib/db/sessions.ts`
 * (`generateSessions`/`rescheduleSession`/`updateSessionRooms`),
 * `lib/db/approvals.ts` (`resolveSessionRequest`), `lib/db/reservations.ts`
 * (`reserveOrEnroll`) and `lib/db/attendance.ts` (`createAttendance`) —
 * against two throwaway centres, by direct call (a Server Action needs a
 * request context this script does not have; every slot-writing action
 * passes its `confirmConflicts` straight to these functions, which the
 * static section asserts). Needs a reachable database; cleans up after
 * itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { scopedData, scopedFindById } from "../lib/db/tenant-scope.ts";
import {
  combinationError,
  effectiveCapacity,
  effectiveRoomIds,
  isValidCombination,
  normalizeRoomPair,
} from "../lib/rooms.ts";
import { enrollmentCap, isAtCapacity } from "../lib/capacity.ts";
import {
  combinationUsage,
  linkRooms,
  loadClassRoomSet,
  loadRoomLinks,
  resolveRoomSet,
  roomCombinationUsage,
  setRoomLinks,
  unlinkRooms,
  writeClassExtraRooms,
  writeSessionExtraRooms,
} from "../lib/db/room-sets.ts";
import { loadSessionOccupancy } from "../lib/db/slot-conflicts.ts";
import {
  cancelSession,
  generateSessions,
  rescheduleSession,
  updateSessionRooms,
} from "../lib/db/sessions.ts";
import { resolveSessionRequest } from "../lib/db/approvals.ts";
import { reserveOrEnroll } from "../lib/db/reservations.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { closeSession } from "../lib/db/session-lifecycle.ts";
import {
  decideConflicts,
  findSessionConflicts,
  type SessionCandidate,
} from "../lib/scheduling.ts";

const prisma = new PrismaClient();

const SLUG_A = "rooms-check-a";
const SLUG_B = "rooms-check-b";
const EMAIL_PREFIX = "rooms-check-";
const TZ = "Africa/Cairo";

// Fixed future dates (Cairo winter, UTC+2) — the sessions below are
// "upcoming" whatever day the gate runs before 2027-03.
const D1 = new Date("2027-03-01T00:00:00.000Z");
const D2 = new Date("2027-03-02T00:00:00.000Z");
const D3 = new Date("2027-03-03T00:00:00.000Z");
const D4 = new Date("2027-03-04T00:00:00.000Z");
const D5 = new Date("2027-03-05T00:00:00.000Z");
const D6 = new Date("2027-03-06T00:00:00.000Z");
/** A wall-clock instant in Cairo on 2027-03-dd, as UTC. */
function cairo(day: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(2027, 2, day, hh - 2, mm));
}

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
  const centers = await prisma.center.findMany({
    where: { slug: { in: [SLUG_A, SLUG_B] } },
    select: { id: true, organizationId: true },
  });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    // AuditLog.centerId has no cascade.
    await prisma.auditLog.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({
      where: { id: { in: centers.map((c) => c.organizationId) } },
    });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

// ── Static assertions (no database) ─────────────────────────────────────────

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** The argument text of every `name(` call in `source`, parens balanced. */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b${name}\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    // Skip the declaration itself.
    const before = source.slice(Math.max(0, match.index - 16), match.index);
    if (/function\s+$/.test(before)) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
    }
    calls.push(source.slice(match.index + match[0].length, i - 1));
  }
  return calls;
}

function staticChecks() {
  console.log("Static assertions");

  // ClassGroup.capacity is gone — from the schema, the generated client and
  // every reader (R3 reverses M15's min(class, room)).
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const classGroupModel = schema.slice(
    schema.indexOf("model ClassGroup {"),
    schema.indexOf("}", schema.indexOf("model ClassGroup {")),
  );
  check(
    "The ClassGroup model declares no capacity column",
    !/^\s*capacity\s/m.test(classGroupModel),
  );
  check(
    "The generated client has no ClassGroup.capacity field",
    !Object.keys(Prisma.ClassGroupScalarFieldEnum).includes("capacity"),
  );

  const sources = ["app", "lib", "components"].flatMap((dir) => listFiles(dir));
  sources.push("prisma/seed.ts");
  const classCapacityReaders = sources.filter((file) => {
    const text = readFileSync(file, "utf8");
    return /\bclass(?:Group|A|Row|Instant)?\??\.capacity\b/.test(text);
  });
  check(
    "No source file reads a class's .capacity",
    classCapacityReaders.length === 0,
    classCapacityReaders.join(", "),
  );
  const twoArgCaps = sources.filter((file) =>
    callArguments(readFileSync(file, "utf8"), "enrollmentCap").some((args) =>
      /,/.test(args.replace(/\([^()]*\)/g, "")),
    ),
  );
  check(
    "enrollmentCap is only ever called with the room set's capacity (one argument)",
    twoArgCaps.length === 0,
    twoArgCaps.join(", "),
  );
  for (const locale of ["en", "ar"]) {
    const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
    check(
      `messages/${locale}.json has no class/request capacity field`,
      messages.Classes.fields.capacity === undefined &&
        messages.TeacherClasses.request.capacity === undefined &&
        messages.TeacherCenters.request.capacity === undefined &&
        messages.Approvals.changeRequests.fields.capacity === undefined,
    );
  }

  // Every slot-writing call from the app passes `confirmConflicts`
  // explicitly — omitting it is the pre-R3 script-only path.
  const appFiles = listFiles("app");
  const writers = ["rescheduleSession", "updateSessionRooms", "generateSessions", "resolveSessionRequest"];
  const missing: string[] = [];
  let calls = 0;
  for (const file of appFiles) {
    const text = readFileSync(file, "utf8");
    for (const writer of writers) {
      for (const args of callArguments(text, writer)) {
        // Declining a session request writes no slot at all.
        if (writer === "resolveSessionRequest" && args.includes('"DECLINED"')) continue;
        calls += 1;
        if (!args.includes("confirmConflicts")) missing.push(`${file} → ${writer}`);
      }
    }
  }
  check(
    `Every app call to a slot writer passes confirmConflicts (${calls} calls)`,
    calls >= 5 && missing.length === 0,
    missing.join("; "),
  );
  const classActions = readFileSync("app/[locale]/(center)/classes/actions.ts", "utf8");
  check(
    "Class schedule/class-edit actions decide conflicts with the confirmation flag",
    callArguments(classActions, "decideConflicts").filter((args) => /confirmConflicts\s*$/.test(args.trim()))
      .length >= 3,
  );
}

// ── Pure rules (lib/rooms.ts, lib/capacity.ts, lib/scheduling.ts) ──────────

function pureChecks() {
  console.log("\nPure room-set rules");
  const links = [
    { roomAId: "a", roomBId: "b" },
    { roomAId: "b", roomBId: "c" },
  ];
  check("normalizeRoomPair orders a pair (b,a) → (a,b)", JSON.stringify(normalizeRoomPair("b", "a")) === JSON.stringify({ roomAId: "a", roomBId: "b" }));
  check("normalizeRoomPair refuses a self-pair", normalizeRoomPair("a", "a") === null);
  check("A + B is valid (linked)", isValidCombination("a", ["b"], links));
  check("Star, not transitive: A-B and B-C linked does NOT allow A + C", !isValidCombination("a", ["c"], links));
  check("…nor A + B + C with A primary", combinationError("a", ["b", "c"], links) === "notLinked");
  check("B + A + C is valid with B primary (both linked to B)", isValidCombination("b", ["a", "c"], links));
  check("An extra equal to the primary is refused", combinationError("a", ["a"], links) === "extraIsPrimary");
  check("A duplicated extra is refused", combinationError("b", ["a", "a"], links) === "duplicateExtra");
  check("Extras with no primary are refused", combinationError(null, ["a"], links) === "noPrimary");
  check("effectiveRoomIds: primary first, extras once", JSON.stringify(effectiveRoomIds("a", ["b", "b"])) === JSON.stringify(["a", "b"]));
  check("effectiveRoomIds: no primary → no rooms", effectiveRoomIds(null, ["b"]).length === 0);
  check("effectiveCapacity sums the rooms (30 + 20 = 50)", effectiveCapacity([{ capacity: 30 }, { capacity: 20 }]) === 50);
  check("effectiveCapacity: a room with capacity 0 (not configured) leaves the set uncapped", effectiveCapacity([{ capacity: 30 }, { capacity: 0 }]) === 0);
  check("effectiveCapacity: no rooms → uncapped", effectiveCapacity([]) === 0);
  check("enrollmentCap takes the room set's capacity only", enrollmentCap(50) === 50 && enrollmentCap(0) === 0);
  check("isAtCapacity(50, 50) — the sum is the cap", isAtCapacity(50, 50) && !isAtCapacity(49, 50));

  // Overlap boundary and busy-ness through extras, both directions.
  const base: SessionCandidate = {
    classGroupId: "y",
    teacherId: "t2",
    roomId: "r2",
    roomIds: ["r2"],
    date: D1,
    startTime: "17:00",
    endTime: "19:00",
  };
  const combined = {
    sessionId: "s1",
    classGroupId: "x",
    className: "X",
    teacherId: "t1",
    roomId: "r1",
    roomIds: ["r1", "r2"],
    date: D1,
    startTime: "16:00",
    endTime: "18:00",
  };
  const hit = findSessionConflicts(base, [combined]);
  check(
    "Room 2 alone vs a session on Room 1 + Room 2 → room conflict on Room 2",
    hit.length === 1 && hit[0].type === "room" && hit[0].roomId === "r2",
    JSON.stringify(hit),
  );
  const reverse = findSessionConflicts(
    { ...base, roomId: "r1", roomIds: ["r1", "r2"] },
    [{ ...combined, roomId: "r2", roomIds: ["r2"] }],
  );
  check(
    "…and vice versa: Room 1 + Room 2 vs a session in Room 2 alone",
    reverse.length === 1 && reverse[0].roomId === "r2",
    JSON.stringify(reverse),
  );
  check(
    "Overlap boundary: one ending exactly when the other starts is free",
    findSessionConflicts({ ...base, startTime: "18:00", endTime: "19:00" }, [combined]).length === 0,
  );
  const both = findSessionConflicts({ ...base, teacherId: "t1" }, [combined]);
  check(
    "Same teacher and a shared room → both a teacher and a room conflict",
    both.some((c) => c.type === "teacher") && both.some((c) => c.type === "room"),
    JSON.stringify(both),
  );
  check(
    "decideConflicts: WARN without the flag needs confirmation; with it proceeds; DENY refuses regardless",
    decideConflicts(1, "WARN", false) === "needsConfirmation" &&
      decideConflicts(1, "WARN", true) === "proceed" &&
      decideConflicts(1, "DENY", true) === "denied" &&
      decideConflicts(0, "DENY", false) === "proceed",
  );
}

// ── Database-backed checks ──────────────────────────────────────────────────

async function makeCenter(slug: string) {
  return prisma.center.create({
    data: {
      slug,
      name: slug,
      organization: { create: { name: slug } },
      settings: { create: { timezone: TZ } },
    },
  });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email: `${EMAIL_PREFIX}${tag}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

async function makeRoom(centerId: string, name: string, capacity: number) {
  return prisma.room.create({ data: scopedData(centerId, { name, capacity }) });
}

async function makeClass(centerId: string, teacherId: string, roomId: string | null, extraRoomIds: string[] = []) {
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerId, { teacherId, roomId, price: 10_000 }),
  });
  await writeClassExtraRooms(prisma, centerId, classGroup.id, extraRoomIds);
  return classGroup;
}

async function makeSession(
  centerId: string,
  classGroup: { id: string; teacherId: string },
  roomId: string | null,
  extraRoomIds: string[],
  date: Date,
  startTime: string,
  endTime: string,
) {
  const session = await prisma.session.create({
    data: scopedData(centerId, {
      classGroupId: classGroup.id,
      teacherId: classGroup.teacherId,
      roomId,
      date,
      startTime,
      endTime,
      priceSnapshot: 10_000,
    }),
  });
  await writeSessionExtraRooms(prisma, centerId, session.id, extraRoomIds);
  return session;
}

async function occupancyConflicts(centerId: string, candidate: SessionCandidate) {
  const existing = await loadSessionOccupancy(prisma, centerId, "en", candidate.date, candidate.date);
  return findSessionConflicts(candidate, existing);
}

async function main() {
  staticChecks();
  pureChecks();

  await cleanup();
  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const A = centerA.id;
  const clock = { now: new Date(), timeZone: TZ };

  const r1 = await makeRoom(A, "Room 1", 30);
  const r2 = await makeRoom(A, "Room 2", 20);
  const r3 = await makeRoom(A, "Room 3", 10);
  const r4 = await makeRoom(A, "Room 4", 10);
  const rb = await makeRoom(centerB.id, "Room B", 15);

  // ── 1. Links: symmetric, unique, same-centre, never self ─────────────────
  const first = await linkRooms(prisma, A, r1.id, r2.id);
  const again = await linkRooms(prisma, A, r2.id, r1.id);
  const pairRows = await prisma.roomLink.findMany({ where: { centerId: A } });
  check("Linking Room 1 + Room 2 succeeds", first.ok && first.created);
  check("Linking the same pair the other way round is a no-op (symmetric)", again.ok && !again.created);
  check(
    "Exactly one row stores the pair, normalized roomAId < roomBId",
    pairRows.length === 1 && pairRows[0].roomAId < pairRows[0].roomBId,
    JSON.stringify(pairRows),
  );
  const self = await linkRooms(prisma, A, r1.id, r1.id);
  check("A self-link is refused", !self.ok && self.error === "selfLink");
  const crossFromA = await linkRooms(prisma, A, r1.id, rb.id);
  const crossFromB = await linkRooms(prisma, centerB.id, rb.id, r1.id);
  check(
    "A cross-centre link is refused from either side (the other room is not found)",
    !crossFromA.ok && crossFromA.error === "roomNotFound" && !crossFromB.ok && crossFromB.error === "roomNotFound",
  );
  let backstop = false;
  try {
    const [hi, lo] = r1.id > r3.id ? [r1.id, r3.id] : [r3.id, r1.id];
    await prisma.roomLink.create({ data: scopedData(A, { roomAId: hi, roomBId: lo }) });
  } catch {
    backstop = true;
  }
  check("The database refuses an un-normalized pair (CHECK roomAId < roomBId)", backstop);
  let dupBackstop = false;
  try {
    await prisma.roomLink.create({ data: scopedData(A, normalizeRoomPair(r1.id, r2.id)!) });
  } catch {
    dupBackstop = true;
  }
  check("The database refuses a second row for the same pair (unique)", dupBackstop);

  await linkRooms(prisma, A, r2.id, r3.id);
  const links = await loadRoomLinks(prisma, A);
  check("Star rule on stored links: Room 1 + Room 3 is not allowed (not linked)", !isValidCombination(r1.id, [r3.id], links));

  // ── 2. A non-linked room cannot be added to a class or a session ─────────
  const notLinked = await resolveRoomSet(prisma, A, r1.id, [r3.id]);
  check("resolveRoomSet refuses a non-linked extra", !notLinked.ok && notLinked.error === "notLinked");
  const foreign = await resolveRoomSet(prisma, A, r1.id, [rb.id]);
  check("resolveRoomSet refuses another centre's room", !foreign.ok && foreign.error === "roomNotFound");
  const valid = await resolveRoomSet(prisma, A, r2.id, [r1.id, r3.id]);
  check("resolveRoomSet accepts Room 2 + Room 1 + Room 3 (both linked to Room 2)", valid.ok && valid.set.roomIds.length === 3);

  const teacher1 = await makeTeacher(A, "t1");
  const teacher2 = await makeTeacher(A, "t2");
  const teacher3 = await makeTeacher(A, "t3");
  const teacher4 = await makeTeacher(A, "t4");
  const classX = await makeClass(A, teacher1.id, r1.id, [r2.id]);
  const set = await loadClassRoomSet(prisma, A, classX.id);
  check("A class on Room 1 + Room 2 seats the sum (30 + 20 = 50)", set?.capacity === 50, JSON.stringify(set));

  const sessionForRooms = await makeSession(A, classX, r1.id, [], D6, "09:00", "10:00");
  const sessionNotLinked = await updateSessionRooms(
    prisma,
    A,
    sessionForRooms.id,
    { roomId: r1.id, extraRoomIds: [r3.id] },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  check(
    "updateSessionRooms refuses a non-linked extra by direct call",
    !sessionNotLinked.ok && sessionNotLinked.error === "notLinked",
    JSON.stringify(sessionNotLinked),
  );
  const sessionLinked = await updateSessionRooms(
    prisma,
    A,
    sessionForRooms.id,
    { roomId: r1.id, extraRoomIds: [r2.id] },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  check(
    "updateSessionRooms accepts a linked extra for that session only — the class is untouched",
    sessionLinked.ok &&
      (await prisma.sessionRoom.count({ where: { sessionId: sessionForRooms.id } })) === 1 &&
      (await loadClassRoomSet(prisma, A, classX.id))?.capacity === 50,
    JSON.stringify(sessionLinked),
  );

  // ── 3. Enrolment capped by the SUM; a cut never removes; attendance free ──
  const small1 = await makeRoom(A, "Small 1", 2);
  const small2 = await makeRoom(A, "Small 2", 1);
  await linkRooms(prisma, A, small1.id, small2.id);
  const classSmall = await makeClass(A, teacher2.id, small1.id, [small2.id]);
  const studentUsers = await Promise.all(
    ["s1", "s2", "s3", "s4", "s5"].map((tag) =>
      prisma.user.create({
        data: { firstName: "S", lastName: tag, email: `${EMAIL_PREFIX}${tag}@kayedu.test`, locale: "en" },
      }),
    ),
  );
  const enrolResults = [];
  for (const user of studentUsers.slice(0, 4)) {
    enrolResults.push(
      await prisma.$transaction((tx) =>
        reserveOrEnroll(tx, { centerId: A, classGroupId: classSmall.id, studentUserId: user.id }),
      ),
    );
  }
  check(
    "A class on Small 1 (2) + Small 2 (1) enrols 3 — past a single room's capacity",
    enrolResults.slice(0, 3).every((r) => r.ok && r.kind === "enrolled"),
    JSON.stringify(enrolResults),
  );
  check(
    "…and refuses the 4th as classFull (the sum is the cap)",
    !enrolResults[3].ok && enrolResults[3].error === "classFull",
    JSON.stringify(enrolResults[3]),
  );
  await prisma.room.update({ where: { id: small1.id }, data: { capacity: 1 } });
  const afterCut = await prisma.enrollment.count({
    where: { centerId: A, classGroupId: classSmall.id, status: "ACTIVE" },
  });
  const enrolAfterCut = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: A, classGroupId: classSmall.id, studentUserId: studentUsers[4].id }),
  );
  check(
    "Cutting a room's capacity below the roster removes nobody — 3 stay ACTIVE",
    afterCut === 3,
    `active=${afterCut}`,
  );
  check(
    "…but a new enrolment is refused (classFull)",
    !enrolAfterCut.ok && enrolAfterCut.error === "classFull",
    JSON.stringify(enrolAfterCut),
  );
  const smallSession = await makeSession(A, classSmall, small1.id, [small2.id], D5, "08:00", "09:00");
  // Walk-ins each need their own User (one StudentProfile per user per centre).
  const walkInProfiles = [];
  for (const tag of ["w1", "w2", "w3", "w4", "w5"]) {
    const user = await prisma.user.create({
      data: { firstName: "W", lastName: tag, email: `${EMAIL_PREFIX}${tag}@kayedu.test`, locale: "en" },
    });
    walkInProfiles.push(
      await prisma.studentProfile.create({
        data: scopedData(A, { userId: user.id, studentCode: `RC-${tag}`, firstName: "W", lastName: tag }),
      }),
    );
  }
  const attendance = await Promise.all(
    walkInProfiles.map((profile) =>
      createAttendance(
        prisma,
        {
          centerId: A,
          sessionId: smallSession.id,
          studentProfileId: profile.id,
          enrollmentId: null,
          isDropIn: true,
          recordedBy: teacher2.id,
        },
        { historicalBackfill: true, status: "PRESENT" },
      ),
    ),
  );
  check(
    "5 walk-ins mark PRESENT on a 2-seat combined session — attendance is never capped",
    attendance.every((row) => row.attendanceStatus === "PRESENT"),
  );

  // ── 4. Busy-ness through extras, on real occupancy ───────────────────────
  const classY = await makeClass(A, teacher2.id, r2.id);
  const s1 = await makeSession(A, classX, r1.id, [r2.id], D1, "16:00", "18:00");
  const candidateR2: SessionCandidate = {
    classGroupId: classY.id,
    teacherId: teacher2.id,
    roomId: r2.id,
    roomIds: [r2.id],
    date: D1,
    startTime: "17:00",
    endTime: "19:00",
  };
  const busy = await occupancyConflicts(A, candidateR2);
  check(
    "While a session uses Room 1 + Room 2, Room 2 alone at an overlapping time is a room conflict",
    busy.some((c) => c.type === "room" && c.roomId === r2.id && c.sessionId === s1.id),
    JSON.stringify(busy),
  );
  await makeSession(A, classY, r2.id, [], D2, "16:00", "18:00");
  const reverse = await occupancyConflicts(A, {
    classGroupId: classX.id,
    teacherId: teacher1.id,
    roomId: r1.id,
    roomIds: [r1.id, r2.id],
    date: D2,
    startTime: "17:00",
    endTime: "18:00",
  });
  check(
    "…and vice versa: Room 1 + Room 2 against a session in Room 2 alone",
    reverse.some((c) => c.type === "room" && c.roomId === r2.id),
    JSON.stringify(reverse),
  );
  check(
    "Overlap boundary on real occupancy: starting exactly when it ends is free",
    (await occupancyConflicts(A, { ...candidateR2, startTime: "18:00", endTime: "19:00" })).length === 0,
  );

  // Cancelled and rescheduled-original occupy nothing; closed occupies.
  const classZ = await makeClass(A, teacher3.id, r3.id);
  const cancelled = await makeSession(A, classZ, r3.id, [], D3, "10:00", "12:00");
  await cancelSession(prisma, A, cancelled.id);
  const moved = await makeSession(A, classZ, r3.id, [], D3, "13:00", "15:00");
  const movedResult = await rescheduleSession(
    prisma,
    A,
    moved.id,
    { date: D4, startTime: "13:00", endTime: "15:00" },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  const closedSession = await makeSession(A, classZ, r3.id, [], D3, "16:00", "17:00");
  const closed = await closeSession(prisma, A, closedSession.id, { closedBy: teacher3.id, now: cairo(3, 16, 30) });
  const probe = (startTime: string, endTime: string, date = D3): SessionCandidate => ({
    classGroupId: classY.id,
    teacherId: teacher4.id,
    roomId: r3.id,
    roomIds: [r3.id],
    date,
    startTime,
    endTime,
  });
  check("A CANCELLED session occupies nothing", (await occupancyConflicts(A, probe("10:30", "11:30"))).length === 0);
  check(
    "The original slot of a RESCHEDULED session occupies nothing…",
    movedResult.ok && (await occupancyConflicts(A, probe("13:30", "14:30"))).length === 0,
    JSON.stringify(movedResult),
  );
  check(
    "…while its replacement does",
    (await occupancyConflicts(A, probe("13:30", "14:30", D4))).some((c) => c.type === "room"),
  );
  check(
    "A CLOSED session still occupies its room (it happened)",
    closed.ok && (await occupancyConflicts(A, probe("16:15", "16:45"))).some((c) => c.type === "room"),
    JSON.stringify(closed),
  );

  // ── 5. The confirmConflicts contract, by direct call ─────────────────────
  // A NEW_SESSION approval for classY in Room 2 at 17:00 on D1 clashes with
  // s1's extra room.
  const requestFor = async () =>
    prisma.changeRequest.create({
      data: scopedData(A, {
        type: "NEW_SESSION",
        requestedBy: teacher2.id,
        payload: { classGroupId: classY.id, date: "2027-03-01", startTime: "17:00", endTime: "19:00", note: null },
        status: "PENDING",
      }),
    });
  const request = await requestFor();
  const unconfirmed = await resolveSessionRequest(prisma, A, request.id, "APPROVED", teacher1.id, "WARN", "en", {
    confirmConflicts: false,
    actorUserId: teacher1.id,
  });
  const stillPending = await prisma.changeRequest.findUnique({ where: { id: request.id } });
  check(
    "WARN without confirmConflicts: refused WITH the conflict list, nothing created",
    !unconfirmed.ok &&
      unconfirmed.error === "conflictsNeedConfirmation" &&
      "conflicts" in unconfirmed &&
      unconfirmed.conflicts.some((c) => c.roomId === r2.id) &&
      stillPending?.status === "PENDING" &&
      (await prisma.session.count({ where: { centerId: A, classGroupId: classY.id, date: D1 } })) === 0,
    JSON.stringify(unconfirmed),
  );
  const denied = await resolveSessionRequest(prisma, A, request.id, "APPROVED", teacher1.id, "DENY", "en", {
    confirmConflicts: true,
    actorUserId: teacher1.id,
  });
  check(
    "DENY with confirmConflicts: still refused, with the list",
    !denied.ok && denied.error === "conflict" && "conflicts" in denied && denied.conflicts.length > 0,
    JSON.stringify(denied),
  );
  const confirmed = await resolveSessionRequest(prisma, A, request.id, "APPROVED", teacher1.id, "WARN", "en", {
    confirmConflicts: true,
    actorUserId: teacher1.id,
  });
  const confirmAudit = confirmed.ok && confirmed.session
    ? await prisma.auditLog.findFirst({
        where: { centerId: A, action: "schedule.conflict.confirm", entityId: confirmed.session.id },
      })
    : null;
  check(
    "WARN with confirmConflicts: the session is created",
    confirmed.ok && confirmed.session !== null,
    JSON.stringify(confirmed),
  );
  check(
    "…and an AuditLog row lists the confirmed conflicts, attributed to the actor",
    confirmAudit !== null &&
      confirmAudit.actorUserId === teacher1.id &&
      JSON.stringify(confirmAudit.after).includes(r2.id),
    JSON.stringify(confirmAudit),
  );

  const rescheduleTarget = await makeSession(A, classY, r2.id, [], D5, "16:00", "17:00");
  const reschedNoFlag = await rescheduleSession(
    prisma,
    A,
    rescheduleTarget.id,
    { date: D1, startTime: "16:30", endTime: "17:30" },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  check(
    "rescheduleSession into Room 1 + Room 2's slot without the flag: refused with the list",
    !reschedNoFlag.ok && reschedNoFlag.error === "conflictsNeedConfirmation" && "conflicts" in reschedNoFlag && reschedNoFlag.conflicts.length > 0,
    JSON.stringify(reschedNoFlag),
  );
  const roomsNoFlag = await updateSessionRooms(
    prisma,
    A,
    sessionForRooms.id,
    { roomId: r2.id, extraRoomIds: [] },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  check("A non-conflicting room change needs no confirmation", roomsNoFlag.ok, JSON.stringify(roomsNoFlag));

  // The generator: conflicting occurrences are held back until confirmed.
  const genRoom = await makeRoom(A, "Gen", 10);
  const genExtra = await makeRoom(A, "Gen extra", 10);
  await linkRooms(prisma, A, genRoom.id, genExtra.id);
  const genFirst = await makeClass(A, teacher3.id, genExtra.id);
  await prisma.classSchedule.create({
    data: scopedData(A, { classGroupId: genFirst.id, dayOfWeek: 1, startTime: "07:00", endTime: "08:00" }),
  });
  await generateSessions(prisma, A, "WARN", genFirst.id, "en", { confirmConflicts: false });
  const genSecond = await makeClass(A, teacher4.id, genRoom.id, [genExtra.id]);
  await prisma.classSchedule.create({
    data: scopedData(A, { classGroupId: genSecond.id, dayOfWeek: 1, startTime: "07:30", endTime: "08:30" }),
  });
  const genDenied = await generateSessions(prisma, A, "DENY", genSecond.id, "en", { confirmConflicts: true });
  check(
    "Generator under DENY: the class's extra room clashes, nothing created even with the flag",
    genDenied.created === 0 && genDenied.conflicts.length > 0 && !genDenied.needsConfirmation,
    JSON.stringify({ ...genDenied, conflicts: genDenied.conflicts.length }),
  );
  const genHeld = await generateSessions(prisma, A, "WARN", genSecond.id, "en", { confirmConflicts: false });
  check(
    "Generator under WARN without the flag: held back, needsConfirmation, conflicts listed",
    genHeld.created === 0 && genHeld.needsConfirmation && genHeld.conflicts.length > 0,
    JSON.stringify({ ...genHeld, conflicts: genHeld.conflicts.length }),
  );
  const genConfirmed = await generateSessions(prisma, A, "WARN", genSecond.id, "en", {
    confirmConflicts: true,
    actorUserId: teacher4.id,
  });
  const genSessions = await prisma.session.findMany({
    where: { centerId: A, classGroupId: genSecond.id },
    select: { id: true, extraRooms: { select: { roomId: true } } },
  });
  check(
    "Generator under WARN with the flag: created, each session inheriting the class's extra room",
    genConfirmed.created > 0 &&
      genSessions.length === genConfirmed.created &&
      genSessions.every((s) => s.extraRooms.length === 1 && s.extraRooms[0].roomId === genExtra.id),
    JSON.stringify({ created: genConfirmed.created, sessions: genSessions.length }),
  );
  check(
    "…and the confirmed double-bookings are audited",
    (await prisma.auditLog.count({
      where: { centerId: A, action: "schedule.conflict.confirm", entityId: genSecond.id },
    })) === 1,
  );

  // ── 6. Unlink / deactivate refusal while a combination is in use ─────────
  const unlinkInUse = await unlinkRooms(prisma, A, r1.id, r2.id, clock);
  check(
    "Unlinking Room 1 + Room 2 is refused while an active class and future sessions use it (counts given)",
    !unlinkInUse.ok && unlinkInUse.classes >= 1 && unlinkInUse.sessions >= 1,
    JSON.stringify(unlinkInUse),
  );
  const setInUse = await setRoomLinks(prisma, A, r1.id, [], clock);
  check(
    "Saving Room 1's links without Room 2 is refused the same way, nothing half-applied",
    !setInUse.ok && setInUse.error === "combinationInUse" &&
      (await prisma.roomLink.count({ where: { centerId: A } })) === (await loadRoomLinks(prisma, A)).length &&
      isValidCombination(r1.id, [r2.id], await loadRoomLinks(prisma, A)),
    JSON.stringify(setInUse),
  );
  const r2Usage = await roomCombinationUsage(prisma, A, r2.id, clock);
  check(
    "Room 2 (an extra in use) reports its combination usage — what refuses deactivate/delete",
    r2Usage.classes >= 1 && r2Usage.sessions >= 1,
    JSON.stringify(r2Usage),
  );
  check(
    "Room 4, never combined, reports no combination usage",
    (await roomCombinationUsage(prisma, A, r4.id, clock)).classes === 0,
  );
  await linkRooms(prisma, A, r3.id, r4.id);
  const unlinkFree = await unlinkRooms(prisma, A, r3.id, r4.id, clock);
  check("An unused pair unlinks", unlinkFree.ok && unlinkFree.removed);
  const pastOnly = await combinationUsage(prisma, A, [normalizeRoomPair(small1.id, small2.id)!], {
    now: new Date("2027-04-01T12:00:00.000Z"),
    timeZone: TZ,
  });
  check(
    "Only FUTURE sessions block: seen from after them, the small rooms' sessions no longer count",
    pastOnly.sessions === 0 && pastOnly.classes === 1,
    JSON.stringify(pastOnly),
  );

  // ── 7. Cross-centre isolation on the three new models ────────────────────
  const linkRow = await prisma.roomLink.findFirstOrThrow({ where: { centerId: A } });
  const classRoomRow = await prisma.classGroupRoom.findFirstOrThrow({ where: { centerId: A } });
  const sessionRoomRow = await prisma.sessionRoom.findFirstOrThrow({ where: { centerId: A } });
  check("Centre B cannot read Centre A's RoomLink by id", (await scopedFindById(prisma.roomLink, centerB.id, linkRow.id)) === null);
  check("Centre B cannot read Centre A's ClassGroupRoom by id", (await scopedFindById(prisma.classGroupRoom, centerB.id, classRoomRow.id)) === null);
  check("Centre B cannot read Centre A's SessionRoom by id", (await scopedFindById(prisma.sessionRoom, centerB.id, sessionRoomRow.id)) === null);
  check("Centre B's link list is its own (empty)", (await loadRoomLinks(prisma, centerB.id)).length === 0);
  check(
    "Centre B's occupancy never includes Centre A's sessions",
    (await loadSessionOccupancy(prisma, centerB.id, "en", D1, D6)).length === 0,
  );
  const crossUnlink = await unlinkRooms(prisma, centerB.id, r1.id, r2.id, clock);
  check(
    "Centre B cannot unlink Centre A's pair",
    crossUnlink.ok && !crossUnlink.removed && (await prisma.roomLink.count({ where: { id: linkRow.id } })) === 1,
  );
}

main()
  .catch((error) => {
    failures += 1;
    console.error(error);
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("cleanup failed:", error));
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} rooms check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll rooms checks passed.");
  });
