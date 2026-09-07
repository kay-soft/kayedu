/**
 * Global academic catalog check — the M13 acceptance gate:
 * "a centre can pick, rename-for-itself and price a catalog entry without
 *  touching the canonical row; a suggestion round-trips through the admin
 *  queue; every catalog entry renders correctly in both locales; a class set
 *  to FIXED inherits its system's default and can override it per class and
 *  per session; and snapshot-at-payment-time is provably unchanged."
 *
 * Run with:  npm run check:catalog
 *
 * Exercises the real `lib/db/catalog.ts` functions (the same ones the
 * settings/admin Server Actions call) against two throwaway centres sharing
 * one canonical catalog, plus `lib/db/payments.ts`'s real `recordPayment` to
 * prove the session-level centre-cut override is honoured and that
 * `CatalogEducationSystem.defaultFixedCenterShare` is never re-read once a
 * class/session already carries its own value.
 *
 * `CatalogEducationSystem`/`CatalogGrade`/`CatalogSubject` are global (no
 * centerId) — they don't cascade away with the throwaway centres, so this
 * script cleans up its own catalog fixtures by name prefix, the same way
 * `classes-check.ts` does.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import { catalogLabel, catalogLabelWithSelection } from "../lib/catalog.ts";
import {
  approveCatalogSuggestion,
  centerEducationSystemById,
  centerGradeById,
  createCatalogSuggestion,
  findSelectionById,
  listPendingCatalogSuggestions,
  rejectCatalogSuggestion,
  removeCatalogSelection,
  selectCatalogEntry,
  updateCatalogSelection,
} from "../lib/db/catalog.ts";
import { classListSelect } from "../lib/db/classes.ts";
import { sessionListSelect } from "../lib/db/sessions.ts";
import { discoverClassesForCenter } from "../lib/db/discover.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { splitShare } from "../lib/money.ts";

const prisma = new PrismaClient();
const TEACHER_ROLE: Role = "TEACHER";

const SLUG_A = "catalog-check-a";
const SLUG_B = "catalog-check-b";
const CATALOG_PREFIX = "Catalog-Check";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "catalog-check-" } } });
  // Global rows — cleaned up explicitly, same reasoning as classes-check.ts.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
  await prisma.catalogEducationSystem.deleteMany({
    where: { nameEn: { startsWith: CATALOG_PREFIX } },
  });
}

async function main() {
  await cleanup();
  console.log("Global academic catalog check");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Catalog A", organization: { create: { name: "Catalog A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Catalog B", organization: { create: { name: "Catalog B" } } },
  });
  const admin = await prisma.user.create({
    data: {
      firstName: "Admin",
      lastName: "Check",
      email: "catalog-check-admin@kayedu.test",
      locale: "en",
      isPlatformAdmin: true,
    },
  });

  // ── 1. One canonical catalog, two independent centre picks ───────────────
  const system = await prisma.catalogEducationSystem.create({
    data: {
      nameAr: `${CATALOG_PREFIX} نظام`,
      nameEn: `${CATALOG_PREFIX} System`,
      defaultFixedCenterShare: 4_000, // 40 EGP
    },
  });
  const grade = await prisma.catalogGrade.create({
    data: {
      nameAr: `${CATALOG_PREFIX} صف`,
      nameEn: `${CATALOG_PREFIX} Grade`,
      educationSystemId: system.id,
    },
  });
  const subject = await prisma.catalogSubject.create({
    data: { nameAr: `${CATALOG_PREFIX} مادة`, nameEn: `${CATALOG_PREFIX} Subject`, gradeId: grade.id },
  });

  const selectA = await selectCatalogEntry(prisma, centerA.id, "EDUCATION_SYSTEM", system.id, null, 12_000);
  check("Centre A selects the global education system", selectA.ok, JSON.stringify(selectA));

  const selectAAgain = await selectCatalogEntry(
    prisma,
    centerA.id,
    "EDUCATION_SYSTEM",
    system.id,
    null,
    12_000,
  );
  check(
    "Selecting the same entry twice is refused as alreadySelected",
    !selectAAgain.ok && selectAAgain.error === "alreadySelected",
    JSON.stringify(selectAAgain),
  );

  const selectB = await selectCatalogEntry(prisma, centerB.id, "EDUCATION_SYSTEM", system.id, null, 9_000);
  check(
    "Centre B independently selects the same canonical entry",
    selectB.ok && selectA.ok && selectB.selectionId !== selectA.selectionId,
    JSON.stringify(selectB),
  );

  // ── 2. Rename-for-itself + price, without touching the canonical row ─────
  if (selectA.ok) {
    await updateCatalogSelection(prisma, selectA.selectionId, {
      displayName: "Centre A's Own Name",
      basePrice: 15_000,
    });
  }
  const viewA = await centerEducationSystemById(prisma, centerA.id, system.id);
  check(
    "Centre A's own view reflects its rename + price",
    viewA?.displayName === "Centre A's Own Name" && viewA?.basePrice === 15_000,
    JSON.stringify(viewA),
  );

  const viewB = await centerEducationSystemById(prisma, centerB.id, system.id);
  check(
    "Centre B's own selection is untouched by Centre A's rename",
    viewB?.displayName === null && viewB?.basePrice === 9_000,
    JSON.stringify(viewB),
  );

  const canonicalAfterRename = await prisma.catalogEducationSystem.findUnique({
    where: { id: system.id },
  });
  check(
    "The canonical CatalogEducationSystem row itself is never written by a centre's rename",
    canonicalAfterRename?.nameAr === system.nameAr &&
      canonicalAfterRename?.nameEn === system.nameEn &&
      canonicalAfterRename?.defaultFixedCenterShare === 4_000,
    JSON.stringify(canonicalAfterRename),
  );

  // ── 3. Bilingual rendering ─────────────────────────────────────────────
  check(
    "catalogLabel renders the Arabic name in ar with no override",
    catalogLabel("ar", { nameAr: system.nameAr, nameEn: system.nameEn }) === system.nameAr,
  );
  check(
    "catalogLabel renders the English name in en with no override",
    catalogLabel("en", { nameAr: system.nameAr, nameEn: system.nameEn }) === system.nameEn,
  );
  check(
    "catalogLabel prefers a centre's display-name override in either locale",
    catalogLabel("ar", { nameAr: system.nameAr, nameEn: system.nameEn }, "Centre A's Own Name") ===
      "Centre A's Own Name" &&
      catalogLabel("en", { nameAr: system.nameAr, nameEn: system.nameEn }, "Centre A's Own Name") ===
        "Centre A's Own Name",
  );

  // ── 4. Tenant boundary: a centre only resolves what it selected ─────────
  const gradeViewA = await centerGradeById(prisma, centerA.id, grade.id);
  check(
    "Centre A has not selected the grade — it resolves to nothing",
    gradeViewA === null,
  );
  const selectGradeA = await selectCatalogEntry(prisma, centerA.id, "GRADE", grade.id, null, null);
  check("Centre A can then select the grade", selectGradeA.ok, JSON.stringify(selectGradeA));
  const gradeViewAAfter = await centerGradeById(prisma, centerA.id, grade.id);
  check(
    "Once selected, Centre A resolves the grade by its catalog id",
    gradeViewAAfter?.id === grade.id,
  );

  // ── 5. Suggestions: submit → approve creates the canonical row ──────────
  const suggestion = await createCatalogSuggestion(prisma, centerA.id, admin.id, {
    kind: "SUBJECT",
    targetId: null,
    parentId: grade.id,
    proposedNameAr: `${CATALOG_PREFIX} مادة مقترحة`,
    proposedNameEn: `${CATALOG_PREFIX} Suggested Subject`,
    note: null,
  });
  const pending = await listPendingCatalogSuggestions(prisma);
  check(
    "A submitted suggestion appears in the platform-admin review queue",
    pending.some((row) => row.id === suggestion.id),
  );

  const approved = await approveCatalogSuggestion(prisma, suggestion.id, admin.id);
  check("Approving a new-entry suggestion succeeds", approved.ok, JSON.stringify(approved));
  if (approved.ok && approved.catalogId) {
    const createdSubject = await prisma.catalogSubject.findUnique({
      where: { id: approved.catalogId },
    });
    check(
      "Approval creates a real CatalogSubject with the proposed names, under the proposed parent",
      createdSubject?.nameAr === suggestion.proposedNameAr &&
        createdSubject?.nameEn === suggestion.proposedNameEn &&
        createdSubject?.gradeId === grade.id,
      JSON.stringify(createdSubject),
    );
  }
  const resolvedSuggestion = await prisma.catalogSuggestion.findUnique({
    where: { id: suggestion.id },
  });
  check(
    "The suggestion is marked ACCEPTED with a resolver and timestamp",
    resolvedSuggestion?.status === "ACCEPTED" &&
      resolvedSuggestion?.resolvedBy === admin.id &&
      resolvedSuggestion?.resolvedAt !== null,
  );

  const reapprove = await approveCatalogSuggestion(prisma, suggestion.id, admin.id);
  check(
    "Approving an already-resolved suggestion is refused",
    !reapprove.ok && reapprove.error === "alreadyResolved",
    JSON.stringify(reapprove),
  );

  // ── 6. Suggestions: submit → reject creates nothing ─────────────────────
  const rejectedSuggestion = await createCatalogSuggestion(prisma, centerB.id, admin.id, {
    kind: "SUBJECT",
    targetId: null,
    parentId: grade.id,
    proposedNameAr: `${CATALOG_PREFIX} مادة مرفوضة`,
    proposedNameEn: `${CATALOG_PREFIX} Rejected Subject`,
    note: null,
  });
  const rejected = await rejectCatalogSuggestion(prisma, rejectedSuggestion.id, admin.id);
  check("Rejecting a suggestion succeeds", rejected.ok && rejected.catalogId === null);
  const noCanonicalRow = await prisma.catalogSubject.findFirst({
    where: { nameEn: `${CATALOG_PREFIX} Rejected Subject` },
  });
  check(
    "A rejected suggestion never creates a canonical catalog row",
    noCanonicalRow === null,
  );

  // ── 7. Deselecting cleans up a centre's own selection only ──────────────
  const gradeSelectionA = await findSelectionById(prisma, centerA.id, selectGradeA.ok ? selectGradeA.selectionId : "");
  check("Centre A's grade selection is scoped to Centre A", Boolean(gradeSelectionA));
  if (gradeSelectionA) await removeCatalogSelection(prisma, gradeSelectionA.id);
  check(
    "After deselecting, Centre A no longer resolves the grade",
    (await centerGradeById(prisma, centerA.id, grade.id)) === null,
  );
  check(
    "The canonical CatalogGrade row survives a centre deselecting it",
    (await prisma.catalogGrade.findUnique({ where: { id: grade.id } })) !== null,
  );

  // ── 8. FIXED centre-cut: per-education-system default, config-time only ─
  const teacherUser = await prisma.user.create({
    data: { firstName: "T", lastName: "Catalog", email: "catalog-check-teacher@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerA.id, {
      userId: teacherUser.id,
      role: TEACHER_ROLE,
      firstName: "T",
      lastName: "Catalog",
      joinedAt: new Date(),
    }),
  });
  const room = await prisma.room.create({ data: scopedData(centerA.id, { name: "Room 1" }) });

  // A class configured FIXED, inheriting the system's default at the moment
  // it was created (the UI's prefill — this row is what "inherited" means in
  // the database: the class's own centerShareValue equals the default at
  // configuration time, and nothing keeps them linked afterwards).
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      teacherId: teacherUser.id,
      subjectId: subject.id,
      gradeId: grade.id,
      educationSystemId: system.id,
      roomId: room.id,
      price: 10_000,
      centerShareType: "FIXED",
      centerShareValue: system.defaultFixedCenterShare, // 4,000 — inherited
      capacity: 0,
    }),
  });

  // Changing the system's default afterwards must move zero existing classes.
  await prisma.catalogEducationSystem.update({
    where: { id: system.id },
    data: { defaultFixedCenterShare: 9_999 },
  });
  const classAfterDefaultChange = await prisma.classGroup.findUnique({ where: { id: classGroup.id } });
  check(
    "Changing a system's defaultFixedCenterShare moves zero existing classes",
    classAfterDefaultChange?.centerShareValue === 4_000,
    `got ${classAfterDefaultChange?.centerShareValue}`,
  );

  // ── 9. Per-session override — recordPayment prefers it over the class ───
  const studentUser = await prisma.user.create({
    data: { firstName: "S", lastName: "Catalog", locale: "en" },
  });
  const studentProfile = await prisma.studentProfile.create({
    data: scopedData(centerA.id, {
      userId: studentUser.id,
      studentCode: "9101",
      firstName: "S",
      lastName: "Catalog",
    }),
  });

  const sessionInheriting = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: classGroup.id,
      teacherId: teacherUser.id,
      roomId: room.id,
      date: new Date("2026-01-05T00:00:00.000Z"),
      startTime: "16:00",
      endTime: "17:00",
      priceSnapshot: 10_000,
      // centerShareType/centerShareValue left null — inherits the class.
    }),
  });
  const sessionOverridden = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: classGroup.id,
      teacherId: teacherUser.id,
      roomId: room.id,
      date: new Date("2026-01-06T00:00:00.000Z"),
      startTime: "16:00",
      endTime: "17:00",
      priceSnapshot: 10_000,
      centerShareType: "PERCENTAGE",
      centerShareValue: 50, // overrides the class's FIXED 4,000
    }),
  });

  const attendeeInheriting = await prisma.sessionAttendee.create({
    data: scopedData(centerA.id, {
      sessionId: sessionInheriting.id,
      studentProfileId: studentProfile.id,
      attendanceStatus: "PRESENT",
      recordedBy: teacherUser.id,
    }),
  });
  const attendeeOverridden = await prisma.sessionAttendee.create({
    data: scopedData(centerA.id, {
      sessionId: sessionOverridden.id,
      studentProfileId: studentProfile.id,
      attendanceStatus: "PRESENT",
      recordedBy: teacherUser.id,
    }),
  });

  const paymentInheriting = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeInheriting.id, "CASH", teacherUser.id),
  );
  const expectedInheriting = splitShare(10_000, "FIXED", 4_000);
  check(
    "A session with no override freezes the class's own FIXED cut",
    paymentInheriting.ok &&
      paymentInheriting.payment.centerShareSnapshot === expectedInheriting.centerShare,
    JSON.stringify(paymentInheriting),
  );

  const paymentOverridden = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeOverridden.id, "CASH", teacherUser.id),
  );
  const expectedOverridden = splitShare(10_000, "PERCENTAGE", 50);
  check(
    "A session's own override wins over the class's cut when recording a payment",
    paymentOverridden.ok &&
      paymentOverridden.payment.centerShareSnapshot === expectedOverridden.centerShare &&
      expectedOverridden.centerShare !== expectedInheriting.centerShare,
    JSON.stringify(paymentOverridden),
  );

  // ── 10. A rename propagates to every live read, not just the settings
  // screen — class lists, session lists and Discover all resolve this
  // centre's own `CenterCatalogSelection.displayName`. Nothing in this
  // schema freezes a catalog entry's name (unlike `priceSnapshot` for
  // money), so every one of these is a live join and must reflect a rename
  // immediately.
  const selectSubjectA = await selectCatalogEntry(
    prisma,
    centerA.id,
    "SUBJECT",
    subject.id,
    "Centre A's Physics",
    null,
  );
  check("Centre A selects and renames the subject", selectSubjectA.ok, JSON.stringify(selectSubjectA));

  // Centre B gets its own class referencing the *same* global subject,
  // never selected (let alone renamed) at Centre B.
  const teacherB = await prisma.user.create({
    data: { firstName: "T", lastName: "CatalogB", email: "catalog-check-teacher-b@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerB.id, {
      userId: teacherB.id,
      role: TEACHER_ROLE,
      firstName: "T",
      lastName: "CatalogB",
      joinedAt: new Date(),
    }),
  });
  const roomB = await prisma.room.create({ data: scopedData(centerB.id, { name: "Room 1" }) });
  const classGroupB = await prisma.classGroup.create({
    data: scopedData(centerB.id, {
      teacherId: teacherB.id,
      subjectId: subject.id,
      roomId: roomB.id,
      price: 10_000,
    }),
  });

  const classListRowA = await prisma.classGroup.findFirst({
    where: { id: classGroup.id },
    select: classListSelect(centerA.id),
  });
  check(
    "Centre A's own class-list read resolves its own subject rename",
    catalogLabelWithSelection("en", classListRowA?.subject ?? null) === "Centre A's Physics",
    catalogLabelWithSelection("en", classListRowA?.subject ?? null) ?? "null",
  );

  const classListRowB = await prisma.classGroup.findFirst({
    where: { id: classGroupB.id },
    select: classListSelect(centerB.id),
  });
  check(
    "Centre B's own class-list read for the same global subject shows the canonical name, unaffected by Centre A's rename",
    catalogLabelWithSelection("en", classListRowB?.subject ?? null) === subject.nameEn,
    catalogLabelWithSelection("en", classListRowB?.subject ?? null) ?? "null",
  );

  const sessionListRowsA = await prisma.session.findMany({
    where: { id: sessionInheriting.id },
    select: sessionListSelect(centerA.id),
  });
  check(
    "Centre A's own session-list read resolves the same subject rename through the class",
    catalogLabelWithSelection("en", sessionListRowsA[0]?.classGroup.subject ?? null) === "Centre A's Physics",
  );

  const discoverRowsA = await discoverClassesForCenter(prisma, centerA.id);
  const discoverRowA = discoverRowsA.find((row) => row.id === classGroup.id);
  check(
    "Discover resolves Centre A's own subject rename for Centre A's class",
    Boolean(discoverRowA) &&
      catalogLabelWithSelection("en", discoverRowA?.subject ?? null) === "Centre A's Physics",
  );

  // ── 11. Cross-centre isolation on the money-adjacent rows above ─────────
  check(
    "Centre B cannot read Centre A's ClassGroup by id",
    (await scopedFindById(prisma.classGroup, centerB.id, classGroup.id)) === null,
  );
  check(
    "Centre B cannot read Centre A's Session by id",
    (await scopedFindById(prisma.session, centerB.id, sessionOverridden.id)) === null,
  );
  const suggestionsInB = await prisma.catalogSuggestion.findMany({ where: scopedWhere(centerB.id) });
  check(
    "Centre B's suggestion queue holds only its own rows",
    suggestionsInB.every((row) => row.centerId === centerB.id) &&
      suggestionsInB.some((row) => row.id === rejectedSuggestion.id),
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
      console.error(`\n${failures} catalog check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll catalog checks passed.");
  });
