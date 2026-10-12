/**
 * Payment-methods check — the R1 gate (docs/03-build-order.md "R1"):
 * attendance has exactly three statuses, and payment methods are per-centre
 * rows whose label is frozen onto every payment.
 *
 * Run with:  npm run check:payment-methods
 *
 * Exercises the real production code — `lib/db/payment-methods.ts` (every
 * rule the `/settings/payment-methods` actions call into) and
 * `lib/db/payments.ts`'s `recordPayment` (the same function
 * `recordPaymentAction` and `checkInAction` call, inside the same kind of
 * transaction) — against throwaway centres. `centerId` reaches `recordPayment`
 * only from the resolved tenant context, never the client, so calling it
 * directly with a forged method id is exactly the "direct action call" case.
 * Needs a reachable database and cleans up after itself.
 */
import { AttendanceStatus, PrismaClient } from "@prisma/client";
import { scopedData, scopedFindById } from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  DEFAULT_PAYMENT_METHOD_NAMES,
  createPaymentMethod,
  deletePaymentMethod,
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
  renamePaymentMethod,
  setPaymentMethodActive,
} from "../lib/db/payment-methods.ts";
import { createCenterWithSettings } from "../lib/db/platform.ts";
import {
  attendanceStatus,
  receptionCheckInSchema,
  setAttendanceSchema,
} from "../lib/validation/sessions.ts";

const prisma = new PrismaClient();

const SLUG_A = "payment-methods-check-a";
const SLUG_B = "payment-methods-check-b";
const SLUG_NEW = "payment-methods-check-new";
const PRICE = 10_000; // 100 EGP

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
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_NEW] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "payment-methods-check-" } } });
  await prisma.user.deleteMany({ where: { lastName: { startsWith: "PMC-" } } });
}

async function makeCenter(slug: string, name: string) {
  return prisma.center.create({
    data: { slug, name, organization: { create: { name } } },
  });
}

/** A PRESENT drop-in on a fresh session — payable, nothing recorded yet. */
async function makePayableAttendee(centerId: string, teacherId: string, code: string) {
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerId, {
      teacherId,
      price: PRICE,
      centerShareType: "PERCENTAGE",
      centerShareValue: 15,
    }),
  });
  const session = await prisma.session.create({
    data: scopedData(centerId, {
      classGroupId: classGroup.id,
      teacherId,
      date: new Date(),
      startTime: "16:00",
      endTime: "18:00",
      priceSnapshot: PRICE,
    }),
  });
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: `PMC-${code}`, locale: "en" },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode: code,
      firstName: "S",
      lastName: code,
    }),
  });
  return createAttendance(prisma, {
    centerId,
    sessionId: session.id,
    studentProfileId: profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: teacherId,
  }, { historicalBackfill: true, status: "PRESENT" });
}

function checkStatusesWithoutDatabase() {
  console.log("Attendance statuses (no database needed)");

  check(
    "The Prisma AttendanceStatus enum is exactly PRESENT / LATE / ABSENT",
    JSON.stringify(Object.values(AttendanceStatus)) === JSON.stringify(["PRESENT", "LATE", "ABSENT"]),
    JSON.stringify(Object.values(AttendanceStatus)),
  );
  check(
    "The shared zod status schema refuses EXCUSED",
    !attendanceStatus.safeParse("EXCUSED").success,
  );
  check(
    "The roster's set-attendance schema refuses EXCUSED",
    !setAttendanceSchema.safeParse({
      locale: "en",
      sessionId: "s",
      studentProfileId: "p",
      status: "EXCUSED",
    }).success,
  );
  check(
    "The Reception check-in schema refuses EXCUSED",
    !receptionCheckInSchema.safeParse({
      locale: "en",
      sessionId: "s",
      studentProfileId: "p",
      status: "EXCUSED",
    }).success,
  );
  check(
    "The three real statuses all still parse",
    ["PRESENT", "LATE", "ABSENT"].every((status) => attendanceStatus.safeParse(status).success),
  );
}

async function main() {
  await cleanup();
  checkStatusesWithoutDatabase();

  console.log("\nDatabase-backed checks");

  const dbEnum = await prisma.$queryRaw<{ value: string }[]>`
    SELECT unnest(enum_range(NULL::"AttendanceStatus"))::text AS value`;
  check(
    "The database AttendanceStatus enum has no EXCUSED value",
    dbEnum.map((row) => row.value).join(",") === "PRESENT,LATE,ABSENT",
    JSON.stringify(dbEnum),
  );

  const centerA = await makeCenter(SLUG_A, "Payment Methods A");
  const centerB = await makeCenter(SLUG_B, "Payment Methods B");
  const teacher = await prisma.user.create({
    data: {
      firstName: "T",
      lastName: "PMC-teacher",
      email: "payment-methods-check-teacher@kayedu.test",
      locale: "en",
    },
  });

  // A centre can't write EXCUSED even past the zod layer.
  const attendeeForStatus = await makePayableAttendee(centerA.id, teacher.id, "PMC-STATUS");
  let excusedWriteRefused = false;
  try {
    await prisma.sessionAttendee.update({
      where: { id: attendeeForStatus.id },
      data: { attendanceStatus: "EXCUSED" as AttendanceStatus },
    });
  } catch {
    excusedWriteRefused = true;
  }
  check("Writing EXCUSED straight to the database is refused", excusedWriteRefused);

  // ── 1. New centres get the R1 defaults ──────────────────────────────────
  const created = await createCenterWithSettings(prisma, {
    name: "Payment Methods New",
    slug: SLUG_NEW,
    themeColor: "#2563EB",
    invite: {
      email: "payment-methods-check-owner@kayedu.test",
      token: `payment-methods-check-${Math.random().toString(36).slice(2)}`,
      invitedBy: teacher.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const newCenterMethods = created.ok
    ? await listActivePaymentMethods(prisma, created.center.id)
    : [];
  check(
    "createCenterWithSettings gives a new centre Cash / InstaPay / Vodafone Cash, in that order, all active",
    JSON.stringify(newCenterMethods.map((method) => method.name)) ===
      JSON.stringify(["Cash", "InstaPay", "Vodafone Cash"]),
    JSON.stringify(newCenterMethods.map((method) => method.name)),
  );

  await ensureDefaultPaymentMethods(prisma, centerA.id);
  await ensureDefaultPaymentMethods(prisma, centerA.id); // idempotent
  const methodsA = await listActivePaymentMethods(prisma, centerA.id);
  check(
    "ensureDefaultPaymentMethods seeds the defaults once and is idempotent",
    methodsA.length === DEFAULT_PAYMENT_METHOD_NAMES.length,
    `${methodsA.length} methods`,
  );
  const [cashA, instapayA, vodafoneA] = methodsA;

  const createdB = await createPaymentMethod(prisma, centerB.id, "Cash");
  if (!createdB.ok) throw new Error("could not create centre B's method");
  const cashB = createdB.method;

  const duplicate = await createPaymentMethod(prisma, centerA.id, "cash");
  check(
    "A centre cannot add a second method with the same name (case-insensitive)",
    !duplicate.ok && duplicate.error === "duplicateName",
  );

  // ── 2. The label snapshot survives a rename ─────────────────────────────
  const attendee1 = await makePayableAttendee(centerA.id, teacher.id, "PMC-001");
  const paid1 = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendee1.id, cashA.id, teacher.id, { historicalBackfill: true }),
  );
  check(
    "recordPayment freezes the method's current name onto methodLabelSnapshot",
    paid1.ok && paid1.payment.paymentMethodId === cashA.id && paid1.payment.methodLabelSnapshot === "Cash",
    JSON.stringify(paid1),
  );

  const renamed = await renamePaymentMethod(prisma, centerA.id, cashA.id, "Cash (front desk)");
  check("A method can be renamed", renamed.ok);

  const reread1 = paid1.ok
    ? await prisma.payment.findUnique({ where: { id: paid1.payment.id } })
    : null;
  check(
    "After the rename, the recorded payment still reads its original label",
    reread1?.methodLabelSnapshot === "Cash" && reread1.paymentMethodId === cashA.id,
    JSON.stringify(reread1?.methodLabelSnapshot),
  );

  const attendee2 = await makePayableAttendee(centerA.id, teacher.id, "PMC-002");
  const paid2 = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendee2.id, cashA.id, teacher.id, { historicalBackfill: true }),
  );
  check(
    "A payment recorded after the rename carries the new label",
    paid2.ok && paid2.payment.methodLabelSnapshot === "Cash (front desk)",
    JSON.stringify(paid2.ok ? paid2.payment.methodLabelSnapshot : paid2),
  );

  // ── 3. A cross-centre method id is refused ──────────────────────────────
  const attendee3 = await makePayableAttendee(centerA.id, teacher.id, "PMC-003");
  const crossCentre = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendee3.id, cashB.id, teacher.id, { historicalBackfill: true }),
  );
  check(
    "recordPayment refuses another centre's method id (invalidMethod)",
    !crossCentre.ok && crossCentre.error === "invalidMethod",
    JSON.stringify(crossCentre),
  );
  const forged = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendee3.id, "not-a-real-method-id", teacher.id, { historicalBackfill: true }),
  );
  check(
    "recordPayment refuses a made-up method id (invalidMethod)",
    !forged.ok && forged.error === "invalidMethod",
    JSON.stringify(forged),
  );
  check(
    "Neither refused attempt wrote a Payment row",
    (await prisma.payment.count({ where: { sessionAttendeeId: attendee3.id } })) === 0,
  );
  check(
    "Centre B cannot resolve centre A's method by id",
    (await scopedFindById(prisma.centerPaymentMethod, centerB.id, cashA.id)) === null,
  );
  const crossRename = await renamePaymentMethod(prisma, centerB.id, cashA.id, "Hijacked");
  const crossToggle = await setPaymentMethodActive(prisma, centerB.id, instapayA.id, false);
  const crossDelete = await deletePaymentMethod(prisma, centerB.id, vodafoneA.id);
  check(
    "Centre B cannot rename, deactivate or delete centre A's methods (notFound)",
    !crossRename.ok && crossRename.error === "notFound" &&
      !crossToggle.ok && crossToggle.error === "notFound" &&
      !crossDelete.ok && crossDelete.error === "notFound",
    JSON.stringify({ crossRename, crossToggle, crossDelete }),
  );

  // ── 4. An inactive method id is refused ─────────────────────────────────
  const deactivated = await setPaymentMethodActive(prisma, centerA.id, instapayA.id, false);
  check("A non-last method can be deactivated", deactivated.ok);
  const inactive = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendee3.id, instapayA.id, teacher.id, { historicalBackfill: true }),
  );
  check(
    "recordPayment refuses an inactive method id (invalidMethod)",
    !inactive.ok && inactive.error === "invalidMethod",
    JSON.stringify(inactive),
  );
  check(
    "An inactive method disappears from the picker list",
    !(await listActivePaymentMethods(prisma, centerA.id)).some((method) => method.id === instapayA.id),
  );

  // ── 5. Delete: hard only when unreferenced, otherwise deactivate ────────
  const deletedUnreferenced = await deletePaymentMethod(prisma, centerA.id, vodafoneA.id);
  check(
    "Deleting a method no payment references hard-deletes it",
    deletedUnreferenced.ok &&
      deletedUnreferenced.outcome === "deleted" &&
      (await prisma.centerPaymentMethod.findUnique({ where: { id: vodafoneA.id } })) === null,
    JSON.stringify(deletedUnreferenced),
  );

  // Give centre A a second active method so "Cash (front desk)" isn't the last one.
  await setPaymentMethodActive(prisma, centerA.id, instapayA.id, true);
  const deletedReferenced = await deletePaymentMethod(prisma, centerA.id, cashA.id);
  const cashAfter = await prisma.centerPaymentMethod.findUnique({ where: { id: cashA.id } });
  check(
    "Deleting a method payments reference deactivates it instead — the row survives",
    deletedReferenced.ok &&
      deletedReferenced.outcome === "deactivated" &&
      cashAfter !== null &&
      cashAfter.active === false,
    JSON.stringify(deletedReferenced),
  );
  const reread2 = paid2.ok
    ? await prisma.payment.findUnique({ where: { id: paid2.payment.id } })
    : null;
  check(
    "History still shows its snapshot label after its method was deactivated",
    reread2?.methodLabelSnapshot === "Cash (front desk)",
  );

  let fkRefused = false;
  try {
    await prisma.centerPaymentMethod.delete({ where: { id: cashA.id } });
  } catch {
    fkRefused = true;
  }
  check(
    "The database itself refuses deleting a method a payment references (FK backstop)",
    fkRefused,
  );

  // ── 6. The last active method can't be removed ──────────────────────────
  // Centre A now has exactly one active method: InstaPay.
  const activeNow = await listActivePaymentMethods(prisma, centerA.id);
  check(
    "Fixture: centre A is down to one active method",
    activeNow.length === 1 && activeNow[0].id === instapayA.id,
    JSON.stringify(activeNow.map((method) => method.name)),
  );
  const lastDeactivate = await setPaymentMethodActive(prisma, centerA.id, instapayA.id, false);
  check(
    "Deactivating the last active method is refused (lastActiveMethod)",
    !lastDeactivate.ok && lastDeactivate.error === "lastActiveMethod",
    JSON.stringify(lastDeactivate),
  );
  const lastDelete = await deletePaymentMethod(prisma, centerA.id, instapayA.id);
  check(
    "Deleting the last active method is refused (lastActiveMethod)",
    !lastDelete.ok && lastDelete.error === "lastActiveMethod",
    JSON.stringify(lastDelete),
  );
  const lastDeleteB = await deletePaymentMethod(prisma, centerB.id, cashB.id);
  check(
    "A centre's only method — unreferenced — still cannot be deleted",
    !lastDeleteB.ok && lastDeleteB.error === "lastActiveMethod",
    JSON.stringify(lastDeleteB),
  );
  check(
    "After both refusals the last method is still there and active",
    (await listActivePaymentMethods(prisma, centerA.id)).length === 1 &&
      (await listActivePaymentMethods(prisma, centerB.id)).length === 1,
  );

  // Concurrent deactivations of the last two active methods: the row lock
  // must let exactly one through.
  await setPaymentMethodActive(prisma, centerA.id, cashA.id, true);
  const race = await Promise.all([
    setPaymentMethodActive(prisma, centerA.id, cashA.id, false),
    setPaymentMethodActive(prisma, centerA.id, instapayA.id, false),
  ]);
  check(
    "Two concurrent deactivations can't together leave a centre with no active method",
    race.filter((result) => result.ok).length === 1 &&
      (await listActivePaymentMethods(prisma, centerA.id)).length === 1,
    JSON.stringify(race.map((result) => (result.ok ? "ok" : result.error))),
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
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll payment-method checks passed.");
  });
