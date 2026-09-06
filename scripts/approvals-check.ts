/**
 * Approvals check — the acceptance gate for the Approvals screen
 * (docs/00-master-product-spec.md §4.1 item 9), which closes the reviewer-UI
 * gap flagged at M6, M7 and M8: `ChangeRequest` and `Reservation` rows sat
 * PENDING forever with no way to accept/decline them.
 *
 * Run with:  npm run check:approvals
 *
 * Exercises the real production functions — `lib/db/approvals.ts`'s
 * `resolveChangeRequest` (the NEW_CLASS status flip), `resolveSessionRequest`
 * (M10, the NEW_SESSION status flip that also creates the `Session` —
 * approve/decline, duplicate-slot, WARN/DENY conflict handling and
 * cross-center isolation) and `lib/db/reservations.ts`'s
 * `confirmReservation`/`rejectReservation` (M8, reused as-is) — against two
 * throwaway centers, plus a direct assertion against
 * `lib/auth/permissions.ts` that RECEPTIONIST cannot reach `approvals.manage`.
 * Needs a reachable database and cleans up after itself.
 */
import { PrismaClient, type ChangeRequestStatus, type ReservationStatus } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import { resolveChangeRequest, resolveSessionRequest } from "../lib/db/approvals.ts";
import { confirmReservation, rejectReservation, reserveOrEnroll } from "../lib/db/reservations.ts";
import { can } from "../lib/auth/permissions.ts";

const prisma = new PrismaClient();

const SLUG_A = "approvals-check-a";
const SLUG_B = "approvals-check-b";
/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const PENDING_CHANGE_REQUEST: ChangeRequestStatus = "PENDING";
const PENDING_RESERVATION: ReservationStatus = "PENDING";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "approvals-check-" } } });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email: `approvals-check-${tag}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

async function makeStudentUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `approvals-check-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeChangeRequest(centerId: string, teacherId: string) {
  return prisma.changeRequest.create({
    data: scopedData(centerId, {
      type: "NEW_CLASS",
      requestedBy: teacherId,
      payload: { dayOfWeek: 1, startTime: "16:00", endTime: "18:00", capacity: 10, attendanceRequired: true, lateThresholdMinutes: 10 },
      status: "PENDING",
    }),
  });
}

async function main() {
  await cleanup();

  console.log("Permission map (no database needed)");
  check(
    "RECEPTIONIST cannot reach approvals.manage — same denial shape as analytics.center.view/expense.manage (M6)",
    !can("RECEPTIONIST", "approvals.manage"),
  );
  check("MANAGER can reach approvals.manage", can("MANAGER", "approvals.manage"));
  check("OWNER can reach approvals.manage", can("OWNER", "approvals.manage"));

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Approvals Check A", organization: { create: { name: "Approvals Check A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Approvals Check B", organization: { create: { name: "Approvals Check B" } } },
  });
  const managerA = await prisma.user.create({
    data: { firstName: "M", lastName: "A", email: "approvals-check-managerA@kayedu.test", locale: "en" },
  });

  const teacherA = await makeTeacher(centerA.id, "teacherA");
  const teacherB = await makeTeacher(centerB.id, "teacherB");

  // ── 1. ChangeRequest accept/decline ───────────────────────────────────────
  const requestToApprove = await makeChangeRequest(centerA.id, teacherA.id);
  const approved = await resolveChangeRequest(prisma, centerA.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "resolveChangeRequest(APPROVED) flips a PENDING request to APPROVED and stamps resolvedBy/resolvedAt",
    approved.ok &&
      approved.changeRequest.status === "APPROVED" &&
      approved.changeRequest.resolvedBy === managerA.id &&
      approved.changeRequest.resolvedAt !== null,
    JSON.stringify(approved),
  );
  check(
    "Approving a ChangeRequest does not create a ClassGroup (status flip only, docs/00 §4.1 item 9)",
    (await prisma.classGroup.count({ where: { centerId: centerA.id } })) === 0,
  );

  const alreadyResolved = await resolveChangeRequest(prisma, centerA.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "Re-resolving an already-resolved ChangeRequest is refused as notPending",
    !alreadyResolved.ok && alreadyResolved.error === "notPending",
    JSON.stringify(alreadyResolved),
  );

  const requestToDecline = await makeChangeRequest(centerA.id, teacherA.id);
  const declined = await resolveChangeRequest(prisma, centerA.id, requestToDecline.id, "DECLINED", managerA.id);
  check(
    "resolveChangeRequest(DECLINED) flips a PENDING request to DECLINED",
    declined.ok && declined.changeRequest.status === "DECLINED",
    JSON.stringify(declined),
  );

  // ── 2. ChangeRequest type NEW_SESSION (M10): accepting creates a Session ──
  const subjectS = await prisma.subject.create({ data: scopedData(centerA.id, { name: "Physics" }) });
  const classForSession = await prisma.classGroup.create({
    data: scopedData(centerA.id, { teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  const sessionRequestDate = "2026-11-16"; // a Monday, arbitrary and far enough out not to collide

  async function makeSessionRequest(classGroupId: string, startTime = "09:00", endTime = "10:00") {
    return prisma.changeRequest.create({
      data: scopedData(centerA.id, {
        type: "NEW_SESSION",
        requestedBy: teacherA.id,
        payload: { classGroupId, date: sessionRequestDate, startTime, endTime, note: null },
        status: "PENDING",
      }),
    });
  }

  const sessionRequestToApprove = await makeSessionRequest(classForSession.id);
  const sessionApproved = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToApprove.id,
    "APPROVED",
    managerA.id,
    "WARN",
  );
  check(
    "resolveSessionRequest(APPROVED) creates a Session and flips the request to APPROVED",
    sessionApproved.ok &&
      sessionApproved.changeRequest.status === "APPROVED" &&
      sessionApproved.session !== null &&
      sessionApproved.session.classGroupId === classForSession.id &&
      sessionApproved.session.priceSnapshot === 5_000,
    JSON.stringify(sessionApproved),
  );

  const sessionAlreadyResolved = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToApprove.id,
    "APPROVED",
    managerA.id,
    "WARN",
  );
  check(
    "Re-resolving an already-resolved NEW_SESSION request is refused as notPending",
    !sessionAlreadyResolved.ok && sessionAlreadyResolved.error === "notPending",
    JSON.stringify(sessionAlreadyResolved),
  );

  const sessionRequestToDecline = await makeSessionRequest(classForSession.id, "11:00", "12:00");
  const sessionDeclined = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToDecline.id,
    "DECLINED",
    managerA.id,
    "WARN",
  );
  check(
    "resolveSessionRequest(DECLINED) flips the request to DECLINED and creates no Session",
    sessionDeclined.ok && sessionDeclined.changeRequest.status === "DECLINED" && sessionDeclined.session === null,
    JSON.stringify(sessionDeclined),
  );

  const sessionRequestDuplicateSlot = await makeSessionRequest(classForSession.id);
  const sessionDuplicate = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestDuplicateSlot.id,
    "APPROVED",
    managerA.id,
    "WARN",
  );
  check(
    "Approving a second request for the exact same class/date/time is refused as duplicateSlot",
    !sessionDuplicate.ok && sessionDuplicate.error === "duplicateSlot",
    JSON.stringify(sessionDuplicate),
  );

  // A second class, sharing teacherA and overlapping the already-approved slot.
  const classConflicting = await prisma.classGroup.create({
    data: scopedData(centerA.id, { teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  const sessionRequestConflictWarn = await makeSessionRequest(classConflicting.id, "09:30", "10:30");
  const sessionConflictWarn = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestConflictWarn.id,
    "APPROVED",
    managerA.id,
    "WARN",
  );
  check(
    "Under WARN, a teacher-conflicting session request is still approved, flagged with the conflict",
    sessionConflictWarn.ok && sessionConflictWarn.session !== null && sessionConflictWarn.conflicts.length > 0,
    JSON.stringify(sessionConflictWarn),
  );

  const classConflictingDeny = await prisma.classGroup.create({
    data: scopedData(centerA.id, { teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  const sessionRequestConflictDeny = await makeSessionRequest(classConflictingDeny.id, "09:15", "09:45");
  const sessionConflictDeny = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestConflictDeny.id,
    "APPROVED",
    managerA.id,
    "DENY",
  );
  check(
    "Under DENY, a teacher-conflicting session request is refused as conflict, no Session created",
    !sessionConflictDeny.ok && sessionConflictDeny.error === "conflict",
    JSON.stringify(sessionConflictDeny),
  );

  const crossCenterSessionApprove = await resolveSessionRequest(
    prisma,
    centerB.id,
    sessionRequestConflictDeny.id, // still PENDING at Center A — the DENY refusal above left it untouched
    "APPROVED",
    managerA.id,
    "WARN",
  );
  check(
    "Center B cannot approve Center A's NEW_SESSION request by id — resolves to notFound",
    !crossCenterSessionApprove.ok && crossCenterSessionApprove.error === "notFound",
    JSON.stringify(crossCenterSessionApprove),
  );

  // ── 3. Reservation accept/decline (reusing M8's confirm/reject) ─────────
  const subjectA = await prisma.subject.create({ data: scopedData(centerA.id, { name: "Math" }) });
  const classConfirm = await prisma.classGroup.create({
    data: scopedData(centerA.id, { teacherId: teacherA.id, subjectId: subjectA.id, price: 10_000, requiresConfirmation: true }),
  });
  const studentToApprove = await makeStudentUser("studentApprove");
  const studentToDecline = await makeStudentUser("studentDecline");

  const pendingToApprove = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentToApprove.id }),
  );
  const pendingToDecline = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentToDecline.id }),
  );
  const reservationIdToApprove = pendingToApprove.ok && pendingToApprove.kind === "pending" ? pendingToApprove.reservationId : "";
  const reservationIdToDecline = pendingToDecline.ok && pendingToDecline.kind === "pending" ? pendingToDecline.reservationId : "";

  const confirmed = await prisma.$transaction((tx) =>
    confirmReservation(tx, centerA.id, reservationIdToApprove, managerA.id),
  );
  check(
    "The Approvals accept action's confirmReservation call creates an ACTIVE Enrollment and marks CONFIRMED",
    confirmed.ok && confirmed.reservation.status === "CONFIRMED" && confirmed.enrollment?.status === "ACTIVE",
    JSON.stringify(confirmed),
  );

  const rejected = await rejectReservation(prisma, centerA.id, reservationIdToDecline, managerA.id);
  check(
    "The Approvals decline action's rejectReservation call marks REJECTED",
    rejected.ok && rejected.reservation.status === "REJECTED",
    JSON.stringify(rejected),
  );

  // ── 4. Audited: the exact write the Server Action performs lands correctly ─
  const auditRow = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: managerA.id,
      action: "reservation.confirm",
      entityType: "Reservation",
      entityId: reservationIdToApprove,
      before: { status: "PENDING" },
      after: { status: "CONFIRMED" },
    },
  });
  check(
    "An AuditLog row for the reservation.confirm decision is scoped to the acting center",
    auditRow.centerId === centerA.id && auditRow.action === "reservation.confirm" && auditRow.entityId === reservationIdToApprove,
  );
  const auditInCenterB = await prisma.auditLog.findMany({ where: { centerId: centerB.id, entityId: reservationIdToApprove } });
  check("Center B's audit log never sees Center A's approval decisions", auditInCenterB.length === 0);

  // ── 5. Cross-center isolation on the Approvals queue itself ─────────────
  const requestB = await makeChangeRequest(centerB.id, teacherB.id);
  const pendingListA = await prisma.changeRequest.findMany({ where: scopedWhere(centerA.id, { status: PENDING_CHANGE_REQUEST }) });
  const pendingListB = await prisma.changeRequest.findMany({ where: scopedWhere(centerB.id, { status: PENDING_CHANGE_REQUEST }) });
  check(
    "Center A's pending-ChangeRequest queue contains none of Center B's rows",
    pendingListA.every((row) => row.centerId === centerA.id) && !pendingListA.some((row) => row.id === requestB.id),
  );
  check(
    "Center B's pending-ChangeRequest queue contains exactly its own request",
    pendingListB.length === 1 && pendingListB[0].id === requestB.id,
  );

  check(
    "Center B cannot resolve Center A's ChangeRequest by id",
    (await scopedFindById(prisma.changeRequest, centerB.id, requestToApprove.id)) === null,
  );
  const crossCenterApprove = await resolveChangeRequest(prisma, centerB.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "Center B staff cannot act on Center A's ChangeRequest by id — resolves to notFound",
    !crossCenterApprove.ok && crossCenterApprove.error === "notFound",
    JSON.stringify(crossCenterApprove),
  );

  check(
    "Center B cannot resolve Center A's Reservation by id",
    (await scopedFindById(prisma.reservation, centerB.id, reservationIdToDecline)) === null,
  );
  const crossCenterReject = await rejectReservation(prisma, centerB.id, reservationIdToDecline, managerA.id);
  check(
    "Center B staff cannot act on Center A's Reservation by id — resolves to notFound",
    !crossCenterReject.ok && crossCenterReject.error === "notFound",
    JSON.stringify(crossCenterReject),
  );

  const pendingReservationsA = await prisma.reservation.findMany({ where: scopedWhere(centerA.id, { status: PENDING_RESERVATION }) });
  check(
    "Center A's pending-Reservation queue no longer includes the two already resolved above",
    pendingReservationsA.length === 0,
    JSON.stringify(pendingReservationsA.map((r) => r.id)),
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
      console.error(`\n${failures} approvals check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll approvals checks passed.");
  });
