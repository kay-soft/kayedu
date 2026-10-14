/**
 * A10-4 — enrolment capacity (the room-set hard cap, docs/00 §5.1 "Capacity")
 * is a count-then-insert with no lock, so concurrent instant-enrols overbook.
 *
 * IMPORTED, not replicated: `reserveOrEnroll` from lib/db/reservations.ts,
 * wrapped as app/[locale]/(student)/student/discover/actions.ts:40-42 wraps it
 * (`prisma.$transaction(tx => reserveOrEnroll(...))`, READ COMMITTED). The cap
 * check is reservations.ts:183-189 (`enrollment.count` then `isAtCapacity`)
 * followed by `enrollment.create` — nothing locks the ClassGroup row and no
 * DB constraint bounds ACTIVE enrolments. confirmReservation
 * (reservations.ts:263-267) and the staff enrollStudentAction
 * (app/[locale]/(center)/classes/actions.ts:727-747, not even in a
 * transaction) have the same shape.
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-13.ts
 * Fixtures: centre `secrepro-a10-4`, users `secrepro-a10-4-*@kayedu.test`.
 */
import { PrismaClient } from "@prisma/client";
import { reserveOrEnroll } from "../../lib/db/reservations.ts";
import { cleanupA10, makeCenter } from "./_fixtures.ts";

const prisma = new PrismaClient();
const CAP = 2;
const STUDENTS = 6;

async function main() {
  await cleanupA10(prisma);
  const { center, teacher } = await makeCenter(prisma, "4");
  const room = await prisma.room.create({ data: { centerId: center.id, name: "A10 room", capacity: CAP } });
  const cls = await prisma.classGroup.create({
    data: {
      centerId: center.id, teacherId: teacher.id, roomId: room.id, price: 10_000,
      requiresConfirmation: false, acceptsNewStudents: true,
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"),
    },
  });
  const users = [];
  for (let i = 0; i < STUDENTS; i++) {
    users.push(await prisma.user.create({ data: { firstName: "S", lastName: `4-${i}`, email: `secrepro-a10-4-s${i}@kayedu.test`, locale: "en" } }));
  }
  const clients = users.map(() => new PrismaClient());
  try {
    const results = await Promise.all(users.map((u, i) =>
      clients[i].$transaction((tx) => reserveOrEnroll(tx, { centerId: center.id, classGroupId: cls.id, studentUserId: u.id }))
        .then((r) => (r.ok ? r.kind : r.error), (e: Error) => `threw:${e.message.slice(0, 60)}`)));
    const active = await prisma.enrollment.count({ where: { centerId: center.id, classGroupId: cls.id, status: "ACTIVE" } });
    console.log(`results: ${results.join(", ")}`);
    console.log(`room-set cap=${CAP} ACTIVE enrolments=${active}`);
    console.log(active > CAP ? "REPRODUCED" : "NOT REPRODUCED");
  } finally {
    await Promise.all(clients.map((c) => c.$disconnect()));
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanupA10(prisma); } finally { await prisma.$disconnect(); } });
