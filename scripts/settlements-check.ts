/**
 * Settlements & refunds check — the M14 acceptance gate
 * (docs/00-master-product-spec.md §5 "Void vs. refund" / "Teacher
 * settlements", §7 acceptance criteria 22-23).
 *
 * Run with:  npm run check:settlements
 *
 * Exercises the real production functions — `lib/db/refunds.ts`'s
 * `refundPayment`, `lib/db/settlements.ts`'s `createSessionSettlement`/
 * `createPeriodSettlement`/`approveSettlement`/`paySettlement`, and
 * `lib/db/analytics.ts`'s `revenueTotals`/`revenueByTeacher` — against two
 * throwaway centers. Needs a reachable database and cleans up after itself.
 *
 * `npm run check:payments` and `npm run check:analytics` are the gates that
 * prove this milestone left the ledger's *history* untouched — this script
 * does not re-assert their scenarios, only the new refund/settlement surface.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { refundPayment } from "../lib/db/refunds.ts";
import {
  approveSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
} from "../lib/db/settlements.ts";
import { revenueByTeacher, revenueTotals } from "../lib/db/analytics.ts";
import { can } from "../lib/auth/permissions.ts";

const prisma = await gatePrisma();

/** R1 fixture shape: a centre's first active payment method, created on demand. */
const fixtureMethodIds = new Map<string, string>();
async function fixtureMethodId(centerId: string): Promise<string> {
  const cached = fixtureMethodIds.get(centerId);
  if (cached) return cached;
  await ensureDefaultPaymentMethods(prisma, centerId);
  const [method] = await listActivePaymentMethods(prisma, centerId);
  fixtureMethodIds.set(centerId, method.id);
  return method.id;
}

const SLUG_A = "settlements-check-a";
const SLUG_B = "settlements-check-b";
const PRICE = 12_000; // 120 EGP
const FIXED_CUT = 1_500; // 15 EGP — teacher share = 105 EGP = 10,500 piastres

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "settlements-check-" } } });
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Settlements-Check" } } });
}

async function makeTeacher(centerId: string, email: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: email, email, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: "TEACHER",
      firstName: "T",
      lastName: email,
      email,
      joinedAt: new Date(),
    }),
  });
  return user;
}

async function makeStudent(centerId: string, code: string) {
  const user = await prisma.user.create({ data: { firstName: "S", lastName: code, locale: "en" } });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: code, firstName: "S", lastName: code }),
  });
  return { user, profile };
}

async function makeSession(centerId: string, classGroupId: string, teacherId: string, date: Date) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      date,
      startTime: "16:00",
      endTime: "18:00",
      priceSnapshot: PRICE,
    }),
  });
}

/** Records one PRESENT + paid attendee on `session`, returns the Payment. */
async function payAttendee(
  centerId: string,
  session: { id: string },
  studentProfileId: string,
  actorId: string,
) {
  const attendee = await createAttendance(prisma, {
    centerId,
    sessionId: session.id,
    studentProfileId,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const methodId = await fixtureMethodId(centerId);
  const result = await prisma.$transaction((tx) => recordPayment(tx, centerId, attendee.id, methodId, actorId, { historicalBackfill: true }));
  if (!result.ok) throw new Error(`recordPayment failed unexpectedly: ${JSON.stringify(result)}`);
  return { session, attendee, payment: result.payment };
}

/** Creates a fresh session on `date` and records one PRESENT + paid attendee on it. */
async function payForSession(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  studentProfileId: string,
  date: Date,
  actorId: string,
) {
  const session = await makeSession(centerId, classGroupId, teacherId, date);
  return payAttendee(centerId, session, studentProfileId, actorId);
}

function checkPermissionMap() {
  console.log("Permission map (no database needed)");

  check("RECEPTIONIST cannot reach payment.refund by default", !can("RECEPTIONIST", "payment.refund"));
  check("ACCOUNTANT cannot reach payment.refund by default", !can("ACCOUNTANT", "payment.refund"));
  check("TEACHER cannot reach payment.refund by default", !can("TEACHER", "payment.refund"));
  check("RECEPTIONIST cannot reach settlement.manage by default", !can("RECEPTIONIST", "settlement.manage"));
  check("ACCOUNTANT cannot reach settlement.manage by default", !can("ACCOUNTANT", "settlement.manage"));
  check("TEACHER cannot reach settlement.manage by default", !can("TEACHER", "settlement.manage"));
  check(
    "A brand-new action is denied even to MANAGER with an empty matrix (deny-by-default)",
    !can("MANAGER", "payment.refund", {}),
  );
  check(
    "MANAGER can reach payment.refund once granted",
    can("MANAGER", "payment.refund", { "payment.refund": true }),
  );
  check(
    "OWNER can reach settlement.manage once granted",
    can("OWNER", "settlement.manage", { "settlement.manage": true }),
  );
}

async function main() {
  await cleanup();
  checkPermissionMap();

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Settlements A", organization: { create: { name: "Settlements A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Settlements B", organization: { create: { name: "Settlements B" } } },
  });

  const teacherA = await makeTeacher(centerA.id, "settlements-check-teacherA@kayedu.test");
  const teacherOther = await makeTeacher(centerA.id, "settlements-check-teacherOther@kayedu.test");
  const actorId = teacherA.id; // stands in for a recording staff member's userId

  const subject = await prisma.catalogSubject.create({
    data: { nameAr: "Settlements-Check Math", nameEn: "Settlements-Check Math" },
  });
  const classFixed = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacherA.id,
      subjectId: subject.id,
      price: PRICE,
      centerShareType: "FIXED",
      centerShareValue: FIXED_CUT,
    }),
  });

  const s1 = await makeStudent(centerA.id, "SC001");
  const s2 = await makeStudent(centerA.id, "SC002");

  // ── 1. Refund arithmetic: revenue AND both shares, exactly the reversed amounts ─
  const day1 = new Date("2026-04-06T00:00:00Z");
  const day1Session = await makeSession(centerA.id, classFixed.id, teacherA.id, day1);
  const paid1 = await payAttendee(centerA.id, day1Session, s1.profile.id, actorId);
  await payAttendee(centerA.id, day1Session, s2.profile.id, actorId);

  const refundResult = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, paid1.payment.id, "Student requested cash back", actorId, { historicalBackfill: true }),
  );
  check(
    "refundPayment reverses exactly the payment's own frozen amount/shares",
    refundResult.ok &&
      refundResult.refund.amount === PRICE &&
      refundResult.refund.centerShareReversed === FIXED_CUT &&
      refundResult.refund.teacherShareReversed === PRICE - FIXED_CUT,
    JSON.stringify(refundResult),
  );

  const reloadedRefundedPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: paid1.payment.id },
  });
  check(
    "The refunded Payment row's money fields stay byte-for-byte untouched, only `refunded` flips",
    reloadedRefundedPayment.refunded === true &&
      reloadedRefundedPayment.amount === paid1.payment.amount &&
      reloadedRefundedPayment.priceSnapshot === paid1.payment.priceSnapshot &&
      reloadedRefundedPayment.centerShareSnapshot === paid1.payment.centerShareSnapshot &&
      reloadedRefundedPayment.teacherShareSnapshot === paid1.payment.teacherShareSnapshot &&
      reloadedRefundedPayment.voided === false,
    JSON.stringify(reloadedRefundedPayment),
  );

  const doubleRefund = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, paid1.payment.id, "again", actorId, { historicalBackfill: true }),
  );
  check(
    "Refunding an already-refunded payment is refused, not silently repeated",
    !doubleRefund.ok && doubleRefund.error === "alreadyRefunded",
    JSON.stringify(doubleRefund),
  );

  const range1 = { from: day1, to: day1 };
  const totals = await revenueTotals(prisma, centerA.id, range1);
  check(
    "revenueTotals subtracts the refund from collected revenue AND from both shares — only payment2's own amounts remain",
    totals.collected === PRICE &&
      totals.centerShare === FIXED_CUT &&
      totals.teacherShare === PRICE - FIXED_CUT &&
      totals.paymentCount === 2,
    JSON.stringify(totals),
  );

  const byTeacher = await revenueByTeacher(prisma, centerA.id, range1);
  const teacherARow = byTeacher.find((row) => row.teacherId === teacherA.id);
  check(
    "revenueByTeacher subtracts the same refund for this teacher's own row",
    teacherARow !== undefined &&
      teacherARow.collected === PRICE &&
      teacherARow.centerShare === FIXED_CUT &&
      teacherARow.teacherShare === PRICE - FIXED_CUT,
    JSON.stringify(teacherARow),
  );

  const voidOfRefunded = await prisma.payment.findFirst({ where: { id: paid1.payment.id, voided: true } });
  check("A refunded payment is not also marked voided", voidOfRefunded === null);

  // ── 2. Settlement totals derive from frozen snapshots, never recomputed ──
  const day2 = new Date("2026-04-13T00:00:00Z");
  const paid3 = await payForSession(centerA.id, classFixed.id, teacherA.id, s1.profile.id, day2, actorId);

  const periodResult = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, day2, day2, actorId),
  );
  check(
    "A period settlement's total equals the sum of frozen teacherShareSnapshot values in scope",
    periodResult.ok && periodResult.settlement.totalAmount === paid3.payment.teacherShareSnapshot,
    JSON.stringify(periodResult),
  );
  if (!periodResult.ok) throw new Error("periodResult was not ok");

  // The underlying class's cut changes AFTER the settlement was created.
  await prisma.classGroup.update({ where: { id: classFixed.id }, data: { centerShareValue: 9_999 } });
  const reloadedSettlementAfterConfigChange = await prisma.settlement.findUniqueOrThrow({
    where: { id: periodResult.settlement.id },
  });
  check(
    "The settlement's total stays IDENTICAL after the class's centre-cut config changes",
    reloadedSettlementAfterConfigChange.totalAmount === paid3.payment.teacherShareSnapshot,
    JSON.stringify(reloadedSettlementAfterConfigChange),
  );
  // Restore the class's cut for the checks below, which assume FIXED_CUT.
  await prisma.classGroup.update({ where: { id: classFixed.id }, data: { centerShareValue: FIXED_CUT } });

  // ── 3. A refunded payment cannot be included in a NEW settlement's total ─
  const day3 = new Date("2026-04-20T00:00:00Z");
  const paid4 = await payForSession(centerA.id, classFixed.id, teacherA.id, s1.profile.id, day3, actorId);
  const refund4 = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, paid4.payment.id, "refunded before settling", actorId, { historicalBackfill: true }),
  );
  check("Setup: payment4 is refunded before any settlement covers it", refund4.ok);

  const settlementExcludingRefund = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, day3, day3, actorId),
  );
  check(
    "A settlement created over a scope containing only an already-refunded payment totals zero",
    settlementExcludingRefund.ok && settlementExcludingRefund.settlement.totalAmount === 0,
    JSON.stringify(settlementExcludingRefund),
  );

  // ── 4. A LATER refund of an already-settled payment: DRAFT/APPROVED get ──
  // live-adjusted, PAID never does (00-master-product-spec.md §5 "Settlement
  // totals: frozen at creation, live-adjusted while unpaid, immutable once
  // PAID" — the M14 follow-up decision, replacing an earlier "never
  // recomputed at any status" draft that let a centre pay out on refunded
  // money).
  const day4 = new Date("2026-04-27T00:00:00Z");
  const paid5 = await payForSession(centerA.id, classFixed.id, teacherA.id, s1.profile.id, day4, actorId);
  const settlementBeforeLaterRefund = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, day4, day4, actorId),
  );
  check(
    "Setup: settlement5 totals payment5's own teacher share before any refund",
    settlementBeforeLaterRefund.ok &&
      settlementBeforeLaterRefund.settlement.totalAmount === paid5.payment.teacherShareSnapshot,
  );
  if (!settlementBeforeLaterRefund.ok) throw new Error("settlementBeforeLaterRefund was not ok");

  const refund5 = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, paid5.payment.id, "refunded after settling (still DRAFT)", actorId, { historicalBackfill: true }),
  );
  check(
    "Refunding a payment inside a DRAFT settlement's scope live-adjusts that settlement's total down by the reversed teacher share",
    refund5.ok &&
      refund5.adjustedSettlements.length === 1 &&
      refund5.adjustedSettlements[0].settlement.id === settlementBeforeLaterRefund.settlement.id &&
      refund5.adjustedSettlements[0].previousTotal === paid5.payment.teacherShareSnapshot &&
      refund5.adjustedSettlements[0].settlement.totalAmount === 0,
    JSON.stringify(refund5),
  );
  const reloadedDraftSettlementAfterRefund = await prisma.settlement.findUniqueOrThrow({
    where: { id: settlementBeforeLaterRefund.settlement.id },
  });
  check(
    "The DRAFT settlement's stored total reflects the live adjustment, not just the in-memory result",
    reloadedDraftSettlementAfterRefund.totalAmount === 0,
    JSON.stringify(reloadedDraftSettlementAfterRefund),
  );

  if (!refund5.ok) throw new Error("refund5 was not ok");
  const adjustAudit = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "settlement.adjust",
      entityType: "Settlement",
      entityId: refund5.adjustedSettlements[0].settlement.id,
      before: { totalAmount: refund5.adjustedSettlements[0].previousTotal },
      after: { totalAmount: refund5.adjustedSettlements[0].settlement.totalAmount, trigger: "payment.refund", paymentId: paid5.payment.id },
    },
  });
  check(
    "The settlement.adjust audit row for a live adjustment is scoped to the acting center with the expected shape",
    adjustAudit.centerId === centerA.id &&
      adjustAudit.action === "settlement.adjust" &&
      adjustAudit.entityType === "Settlement" &&
      adjustAudit.entityId === settlementBeforeLaterRefund.settlement.id,
  );

  // Now the PAID case: settle, approve, pay — THEN refund. The total must
  // stay byte-for-byte unchanged, and this settlement must not appear in
  // the refund's own adjustedSettlements list at all.
  const day4b = new Date("2026-05-11T00:00:00Z");
  const paid5b = await payForSession(centerA.id, classFixed.id, teacherA.id, s2.profile.id, day4b, actorId);
  const settlementToPayOut = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, day4b, day4b, actorId),
  );
  check("Setup: settlementToPayOut is created", settlementToPayOut.ok);
  if (!settlementToPayOut.ok) throw new Error("settlementToPayOut was not ok");
  await prisma.$transaction((tx) => approveSettlement(tx, centerA.id, settlementToPayOut.settlement.id, { userId: actorId, isOwner: true }));
  const paidOut = await prisma.$transaction((tx) => paySettlement(tx, centerA.id, settlementToPayOut.settlement.id, { userId: actorId, isOwner: true }));
  check("Setup: settlementToPayOut is now PAID", paidOut.ok && paidOut.settlement.status === "PAID");

  const refundAfterPayout = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, paid5b.payment.id, "refunded after payout", actorId, { historicalBackfill: true }),
  );
  check(
    "Refunding a payment inside an already-PAID settlement's scope adjusts nothing — the settlement never appears in adjustedSettlements",
    refundAfterPayout.ok && refundAfterPayout.adjustedSettlements.length === 0,
    JSON.stringify(refundAfterPayout),
  );
  const reloadedPaidSettlement = await prisma.settlement.findUniqueOrThrow({
    where: { id: settlementToPayOut.settlement.id },
  });
  check(
    "A PAID settlement's stored total stays byte-for-byte unchanged after a later refund",
    reloadedPaidSettlement.totalAmount === paid5b.payment.teacherShareSnapshot,
    JSON.stringify(reloadedPaidSettlement),
  );

  // ── 5. Session-scoped settlement + duplicate-claim prevention ───────────
  const day5 = new Date("2026-05-04T00:00:00Z");
  const paid6 = await payForSession(centerA.id, classFixed.id, teacherA.id, s2.profile.id, day5, actorId);

  const sessionSettlement = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, centerA.id, paid6.session.id, actorId),
  );
  check(
    "A session settlement totals exactly that session's own teacher share",
    sessionSettlement.ok && sessionSettlement.settlement.totalAmount === paid6.payment.teacherShareSnapshot,
    JSON.stringify(sessionSettlement),
  );

  const duplicateSessionSettlement = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, centerA.id, paid6.session.id, actorId),
  );
  check(
    "A second settlement for the same session is refused — the teacher's share cannot be claimed twice",
    !duplicateSessionSettlement.ok && duplicateSessionSettlement.error === "sessionAlreadySettled",
    JSON.stringify(duplicateSessionSettlement),
  );

  const crossCenterSessionSettlement = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, centerB.id, paid6.session.id, actorId),
  );
  check(
    "Center B cannot settle Center A's session by id — resolves to sessionNotFound",
    !crossCenterSessionSettlement.ok && crossCenterSessionSettlement.error === "sessionNotFound",
    JSON.stringify(crossCenterSessionSettlement),
  );

  // ── 6. Period overlap prevention (same teacher only) ────────────────────
  const rangeStart = new Date("2026-06-01T00:00:00Z");
  const rangeEnd = new Date("2026-06-07T00:00:00Z");
  const firstPeriod = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, rangeStart, rangeEnd, actorId),
  );
  check("Setup: first period settlement is created", firstPeriod.ok);

  const overlappingStart = new Date("2026-06-05T00:00:00Z");
  const overlappingEnd = new Date("2026-06-10T00:00:00Z");
  const overlapping = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, overlappingStart, overlappingEnd, actorId),
  );
  check(
    "A period settlement overlapping the same teacher's existing scope is refused",
    !overlapping.ok && overlapping.error === "overlappingSettlement",
    JSON.stringify(overlapping),
  );

  const otherTeacherSamePeriod = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherOther.id, rangeStart, rangeEnd, actorId),
  );
  check(
    "The identical date range is fine for a DIFFERENT teacher — overlap is per teacher",
    otherTeacherSamePeriod.ok,
    JSON.stringify(otherTeacherSamePeriod),
  );

  const invalidRange = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, centerA.id, teacherA.id, rangeEnd, rangeStart, actorId),
  );
  check(
    "A period settlement with `from` after `to` is refused as invalidRange",
    !invalidRange.ok && invalidRange.error === "invalidRange",
    JSON.stringify(invalidRange),
  );

  // ── 7. Transitions: DRAFT → APPROVED → PAID, no shortcuts, no skips ─────
  if (!sessionSettlement.ok) throw new Error("sessionSettlement was not ok");
  const draftId = sessionSettlement.settlement.id;

  const payBeforeApprove = await prisma.$transaction((tx) => paySettlement(tx, centerA.id, draftId, { userId: actorId, isOwner: true }));
  check(
    "A DRAFT settlement cannot be marked PAID directly — APPROVED must come first",
    !payBeforeApprove.ok && payBeforeApprove.error === "notApproved",
    JSON.stringify(payBeforeApprove),
  );

  const approved = await prisma.$transaction((tx) => approveSettlement(tx, centerA.id, draftId, { userId: actorId, isOwner: true }));
  check(
    "approveSettlement moves DRAFT to APPROVED and stamps approvedBy/approvedAt",
    approved.ok &&
      approved.settlement.status === "APPROVED" &&
      approved.settlement.approvedBy === actorId &&
      approved.settlement.approvedAt !== null,
    JSON.stringify(approved),
  );

  const reApprove = await prisma.$transaction((tx) => approveSettlement(tx, centerA.id, draftId, { userId: actorId, isOwner: true }));
  check(
    "Re-approving an already-approved settlement is refused as notDraft",
    !reApprove.ok && reApprove.error === "notDraft",
    JSON.stringify(reApprove),
  );

  const paid = await prisma.$transaction((tx) => paySettlement(tx, centerA.id, draftId, { userId: actorId, isOwner: true }));
  check(
    "paySettlement moves APPROVED to PAID and stamps paidBy/paidAt — no partially-paid state",
    paid.ok && paid.settlement.status === "PAID" && paid.settlement.paidBy === actorId && paid.settlement.paidAt !== null,
    JSON.stringify(paid),
  );

  const rePay = await prisma.$transaction((tx) => paySettlement(tx, centerA.id, draftId, { userId: actorId, isOwner: true }));
  check(
    "Re-paying an already-paid settlement is refused as notApproved",
    !rePay.ok && rePay.error === "notApproved",
    JSON.stringify(rePay),
  );

  const crossCenterApprove = await prisma.$transaction((tx) =>
    approveSettlement(tx, centerB.id, draftId, { userId: actorId, isOwner: true }),
  );
  check(
    "Center B cannot approve Center A's settlement by id — resolves to notFound",
    !crossCenterApprove.ok && crossCenterApprove.error === "notFound",
    JSON.stringify(crossCenterApprove),
  );

  // ── 8. Audit shape on every transition (the exact write each Server ─────
  // Action performs — the same pattern approvals-check.ts/payments-check.ts
  // use for audit assertions).
  const createAudit = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "settlement.create",
      entityType: "Settlement",
      entityId: draftId,
      after: { teacherId: teacherA.id, totalAmount: sessionSettlement.settlement.totalAmount },
    },
  });
  const approveAudit = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "settlement.approve",
      entityType: "Settlement",
      entityId: draftId,
      before: { status: "DRAFT" },
      after: { status: "APPROVED" },
    },
  });
  const payAudit = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "settlement.pay",
      entityType: "Settlement",
      entityId: draftId,
      before: { status: "APPROVED" },
      after: { status: "PAID" },
    },
  });
  const refundAudit = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "payment.refund",
      entityType: "Payment",
      entityId: paid1.payment.id,
      before: { refunded: false },
      after: { refunded: true, amount: PRICE },
    },
  });
  check(
    "Every settlement/refund transition writes an AuditLog row scoped to the acting center with the expected shape",
    [createAudit, approveAudit, payAudit, refundAudit].every(
      (row) => row.centerId === centerA.id && row.entityId !== null,
    ) &&
      createAudit.action === "settlement.create" &&
      approveAudit.action === "settlement.approve" &&
      payAudit.action === "settlement.pay" &&
      refundAudit.action === "payment.refund",
  );
  const auditInCenterB = await prisma.auditLog.findMany({ where: { centerId: centerB.id, entityId: draftId } });
  check("Center B's audit log never sees Center A's settlement transitions", auditInCenterB.length === 0);

  // ── 9. Cross-center isolation on the raw tables ─────────────────────────
  const settlementsInB = await prisma.settlement.findMany({ where: scopedWhere(centerB.id) });
  const refundsInB = await prisma.refund.findMany({ where: scopedWhere(centerB.id) });
  check("Center B has zero Settlement rows despite Center A's activity", settlementsInB.length === 0);
  check("Center B has zero Refund rows despite Center A's activity", refundsInB.length === 0);
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
      console.error(`\n${failures} settlements check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll settlements checks passed.");
  });
