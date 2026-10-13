/**
 * Global academic catalog check — the M13 acceptance gate, extended at R8:
 * "a centre can pick, rename-for-itself (in each language) and price a catalog
 *  entry without touching the canonical row; only a platform admin can write a
 *  global row, by direct call, and a referenced entry cannot be hard-deleted;
 *  a deactivated entry leaves every picker but keeps resolving in history;
 *  every catalog entry renders correctly in both locales; the suggestion queue
 *  no longer exists; a class set to FIXED inherits its system's default and can
 *  override it per class and per session; and snapshot-at-payment-time is
 *  provably unchanged."
 *
 * Run with:  npm run check:catalog
 *
 * Exercises the real `lib/db/catalog.ts` (a centre's view) and
 * `lib/db/catalog-admin.ts` (the platform admin's writes) functions — the same
 * ones the settings/admin Server Actions call — against two throwaway centres
 * sharing one canonical catalog, plus `lib/db/payments.ts`'s real
 * `recordPayment` to prove the session-level centre-cut override is honoured
 * and that `CatalogEducationSystem.defaultFixedCenterShare` is never re-read
 * once a class/session already carries its own value.
 *
 * `CatalogEducationSystem`/`CatalogGrade`/`CatalogSubject` are global (no
 * centerId) — they don't cascade away with the throwaway centres, so this
 * script cleans up its own catalog fixtures (and their platform audit rows) by
 * name prefix, the same way `classes-check.ts` does.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PrismaClient, type Role } from "@prisma/client";
import { scopedData, scopedFindById } from "../lib/db/tenant-scope.ts";
import {
  CATALOG_NAME_MAX,
  backfillLegacyName,
  catalogLabel,
  catalogLabelWithSelection,
  catalogNameKey,
  containsArabicScript,
} from "../lib/catalog.ts";
import {
  centerEducationSystemById,
  centerGradeById,
  centerSubjects,
  findSelectionById,
  listCatalogEducationSystems,
  listCatalogGrades,
  listCatalogSubjects,
  removeCatalogSelection,
  selectCatalogEntry,
  updateCatalogSelection,
} from "../lib/db/catalog.ts";
import {
  catalogEntryUsage,
  createCatalogEntry,
  deleteCatalogEntry,
  listCatalogAdminRows,
  setCatalogEntryActive,
  updateCatalogEntry,
} from "../lib/db/catalog-admin.ts";
import { classListSelect } from "../lib/db/classes.ts";
import { sessionListSelect } from "../lib/db/sessions.ts";
import { discoverClassesForCenter } from "../lib/db/discover.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { splitShare } from "../lib/money.ts";

const prisma = new PrismaClient();

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
  // Platform audit rows for the entries this script made (the actor FK is
  // optional, so they would otherwise outlive the throwaway users).
  await prisma.auditLog.deleteMany({
    where: {
      action: { startsWith: "platform.catalog." },
      OR: [
        { after: { path: ["nameEn"], string_starts_with: CATALOG_PREFIX } },
        { before: { path: ["nameEn"], string_starts_with: CATALOG_PREFIX } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: "catalog-check-" } } });
  // Global rows — cleaned up explicitly, same reasoning as classes-check.ts.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
  await prisma.catalogEducationSystem.deleteMany({
    where: { nameEn: { startsWith: CATALOG_PREFIX } },
  });
}

const refused = (result: { ok: boolean; error?: string }, error: string) =>
  !result.ok && result.error === error;

/** Every `.ts`/`.tsx`/`.json`/`.sql` file under `dir`, skipping build output and dependencies. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|json|sql|prisma)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strips line and block comments so a static scan reads code, not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
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

  // ── 2. Rename-for-itself (per language) + price, without touching the
  //       canonical row ─────────────────────────────────────────────────────
  if (selectA.ok) {
    await updateCatalogSelection(prisma, selectA.selectionId, {
      displayNameAr: "اسم المركز أ",
      displayNameEn: "Centre A's Own Name",
      basePrice: 15_000,
    });
  }
  const viewA = await centerEducationSystemById(prisma, centerA.id, system.id);
  check(
    "Centre A's own view reflects its rename (both languages) + price",
    viewA?.displayNameAr === "اسم المركز أ" &&
      viewA?.displayNameEn === "Centre A's Own Name" &&
      viewA?.basePrice === 15_000,
    JSON.stringify(viewA),
  );

  const viewB = await centerEducationSystemById(prisma, centerB.id, system.id);
  check(
    "Centre B's own selection is untouched by Centre A's rename",
    viewB?.displayNameAr === null && viewB?.displayNameEn === null && viewB?.basePrice === 9_000,
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

  // ── 3. Bilingual rendering: the resolver, locale by locale ──────────────
  const entry = { nameAr: system.nameAr, nameEn: system.nameEn };
  check(
    "catalogLabel renders the Arabic name in ar with no override",
    catalogLabel("ar", entry) === system.nameAr,
  );
  check(
    "catalogLabel renders the English name in en with no override",
    catalogLabel("en", entry) === system.nameEn,
  );
  const bothOverrides = { displayNameAr: "اسم المركز أ", displayNameEn: "Centre A's Own Name" };
  check(
    "catalogLabel uses each language's own override in that language",
    catalogLabel("ar", entry, bothOverrides) === "اسم المركز أ" &&
      catalogLabel("en", entry, bothOverrides) === "Centre A's Own Name",
  );
  const arOnly = { displayNameAr: "اسم عربي فقط", displayNameEn: null };
  const enOnly = { displayNameAr: null, displayNameEn: "English only" };
  check(
    "An Arabic-only override shows in the Arabic UI and never in the English UI",
    catalogLabel("ar", entry, arOnly) === "اسم عربي فقط" && catalogLabel("en", entry, arOnly) === system.nameEn,
  );
  check(
    "An English-only override shows in the English UI and never in the Arabic UI",
    catalogLabel("en", entry, enOnly) === "English only" && catalogLabel("ar", entry, enOnly) === system.nameAr,
  );
  check(
    "A blank or whitespace override is no override (falls back to the canonical name)",
    catalogLabel("ar", entry, { displayNameAr: "   ", displayNameEn: "" }) === system.nameAr &&
      catalogLabel("en", entry, { displayNameAr: "", displayNameEn: "  " }) === system.nameEn,
  );
  check(
    "catalogLabelWithSelection reads the override from a nested selections include, null-safe",
    catalogLabelWithSelection("ar", { ...entry, selections: [arOnly] }) === "اسم عربي فقط" &&
      catalogLabelWithSelection("en", { ...entry, selections: [arOnly] }) === system.nameEn &&
      catalogLabelWithSelection("en", { ...entry, selections: [] }) === system.nameEn &&
      catalogLabelWithSelection("en", null) === null,
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

  // ── 5. R8: the suggestion queue is gone ─────────────────────────────────
  // (The M13 round-trip assertions — submit, appears in the queue, approve
  // creates the row, marked ACCEPTED, re-approve refused, reject creates
  // nothing — were removed with the queue; see docs/03-build-order.md R8.)
  check(
    "The generated client has no CatalogSuggestion model at all",
    !("catalogSuggestion" in prisma),
  );
  const tables = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('public."CatalogSuggestion"') IS NOT NULL AS exists`;
  const types = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CatalogSuggestionStatus') AS exists`;
  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'CenterCatalogSelection' AND column_name LIKE 'displayName%'
    ORDER BY column_name`;
  check(
    "The database has no CatalogSuggestion table or CatalogSuggestionStatus enum",
    tables[0].exists === false && types[0].exists === false,
  );
  check(
    "CenterCatalogSelection carries displayNameAr + displayNameEn and no plain displayName column",
    columns.map((row) => row.column_name).join(",") === "displayNameAr,displayNameEn",
    columns.map((row) => row.column_name).join(","),
  );

  // ── 6. R8: global writes are platform-admin only — by direct call ───────
  const spare = await prisma.catalogSubject.create({
    data: { nameAr: "احتياطي", nameEn: `${CATALOG_PREFIX} Spare`, gradeId: grade.id },
  });

  const actors: { label: string; id: string }[] = [];
  for (const role of ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "TEACHER"] as Role[]) {
    const user = await prisma.user.create({
      data: {
        firstName: role,
        lastName: "Check",
        email: `catalog-check-${role.toLowerCase()}@kayedu.test`,
        locale: "en",
      },
    });
    await prisma.membership.create({
      data: scopedData(centerA.id, {
        userId: user.id,
        role,
        firstName: role,
        lastName: "Check",
        joinedAt: new Date(),
      }),
    });
    actors.push({ label: role, id: user.id });
  }
  const studentUser = await prisma.user.create({
    data: { firstName: "Student", lastName: "Check", email: "catalog-check-student@kayedu.test", locale: "en" },
  });
  const studentProfile0 = await prisma.studentProfile.create({
    data: scopedData(centerA.id, {
      userId: studentUser.id,
      studentCode: "9201",
      firstName: "Student",
      lastName: "Check",
    }),
  });
  actors.push({ label: "STUDENT", id: studentUser.id });
  const parentUser = await prisma.user.create({
    data: { firstName: "Parent", lastName: "Check", email: "catalog-check-parent@kayedu.test", locale: "en" },
  });
  await prisma.parentLink.create({
    data: {
      parentUserId: parentUser.id,
      studentProfileId: studentProfile0.id,
      centerId: centerA.id,
      matchedPhone: "+201000000001",
    },
  });
  actors.push({ label: "PARENT", id: parentUser.id });
  const plainUser = await prisma.user.create({
    data: { firstName: "Plain", lastName: "Check", email: "catalog-check-plain@kayedu.test", locale: "en" },
  });
  actors.push({ label: "signed-in user with no centre", id: plainUser.id });
  actors.push({ label: "unknown user id", id: "00000000-0000-0000-0000-000000000000" });
  actors.push({ label: "no user at all", id: "" });

  const globalCountsBefore = await Promise.all([
    prisma.catalogEducationSystem.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
    prisma.catalogGrade.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
    prisma.catalogSubject.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
  ]);

  for (const actor of actors) {
    const results = [
      await createCatalogEntry(prisma, actor.id, "EDUCATION_SYSTEM", {
        nameAr: "ن",
        nameEn: `${CATALOG_PREFIX} Forbidden System`,
        defaultFixedCenterShare: 1_000,
      }),
      await createCatalogEntry(prisma, actor.id, "GRADE", {
        nameAr: "ص",
        nameEn: `${CATALOG_PREFIX} Forbidden Grade`,
        parentId: system.id,
      }),
      await createCatalogEntry(prisma, actor.id, "SUBJECT", {
        nameAr: "م",
        nameEn: `${CATALOG_PREFIX} Forbidden Subject`,
        parentId: grade.id,
      }),
      await updateCatalogEntry(prisma, actor.id, "SUBJECT", subject.id, {
        nameAr: "تغيير",
        nameEn: `${CATALOG_PREFIX} Hijacked`,
        parentId: grade.id,
      }),
      await updateCatalogEntry(prisma, actor.id, "EDUCATION_SYSTEM", system.id, {
        nameAr: system.nameAr,
        nameEn: system.nameEn,
        defaultFixedCenterShare: 1,
      }),
      await setCatalogEntryActive(prisma, actor.id, "SUBJECT", subject.id, false),
      await setCatalogEntryActive(prisma, actor.id, "GRADE", grade.id, false),
      await deleteCatalogEntry(prisma, actor.id, "SUBJECT", spare.id),
    ];
    check(
      `${actor.label} is refused every global write (create ×3, update ×2, deactivate ×2, delete) as forbidden`,
      results.every((result) => refused(result, "forbidden")),
      JSON.stringify(results.map((result) => (result.ok ? "ok" : result.error))),
    );
  }

  const globalCountsAfter = await Promise.all([
    prisma.catalogEducationSystem.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
    prisma.catalogGrade.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
    prisma.catalogSubject.count({ where: { nameEn: { startsWith: CATALOG_PREFIX } } }),
  ]);
  const subjectAfterRefusals = await prisma.catalogSubject.findUnique({ where: { id: subject.id } });
  const systemAfterRefusals = await prisma.catalogEducationSystem.findUnique({ where: { id: system.id } });
  const gradeAfterRefusals = await prisma.catalogGrade.findUnique({ where: { id: grade.id } });
  check(
    "…and no refused write changed anything: no row created, renamed, deactivated or deleted",
    JSON.stringify(globalCountsBefore) === JSON.stringify(globalCountsAfter) &&
      subjectAfterRefusals?.nameEn === subject.nameEn &&
      subjectAfterRefusals.active &&
      gradeAfterRefusals?.active === true &&
      systemAfterRefusals?.defaultFixedCenterShare === 4_000 &&
      (await prisma.catalogSubject.findUnique({ where: { id: spare.id } })) !== null,
  );
  check(
    "…and a refused write leaves no audit row",
    (await prisma.auditLog.count({
      where: {
        action: { startsWith: "platform.catalog." },
        actorUserId: { in: actors.map((actor) => actor.id).filter((id) => id.length > 0) },
      },
    })) === 0,
  );

  // The platform admin, by contrast, can.
  const created = await createCatalogEntry(prisma, admin.id, "SUBJECT", {
    nameAr: "جبر",
    nameEn: `${CATALOG_PREFIX} Algebra`,
    parentId: grade.id,
  });
  check("A platform admin can add a subject under a grade", created.ok, JSON.stringify(created));
  const createdRow = created.ok ? await prisma.catalogSubject.findUnique({ where: { id: created.id } }) : null;
  check(
    "…it is stored with both names under that grade",
    createdRow?.nameAr === "جبر" && createdRow.nameEn === `${CATALOG_PREFIX} Algebra` && createdRow.gradeId === grade.id,
  );
  const createdAudit = created.ok
    ? await prisma.auditLog.findFirst({ where: { action: "platform.catalog.create", entityId: created.id } })
    : null;
  check(
    "…and audited as platform.catalog.create with no before and the new row as after",
    createdAudit?.actorUserId === admin.id &&
      createdAudit.centerId === null &&
      createdAudit.entityType === "CatalogSubject" &&
      createdAudit.before === null &&
      (createdAudit.after as { nameEn?: string } | null)?.nameEn === `${CATALOG_PREFIX} Algebra`,
    JSON.stringify(createdAudit),
  );

  const systemCreated = await createCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", {
    nameAr: "نظام جديد",
    nameEn: `${CATALOG_PREFIX} New System`,
    defaultFixedCenterShare: 5_000,
  });
  const systemCreatedRow = systemCreated.ok
    ? await prisma.catalogEducationSystem.findUnique({ where: { id: systemCreated.id } })
    : null;
  check(
    "A platform admin can add an education system with its default centre cut (piastres)",
    systemCreated.ok && systemCreatedRow?.defaultFixedCenterShare === 5_000,
    JSON.stringify(systemCreated),
  );

  if (created.ok) {
    const edited = await updateCatalogEntry(prisma, admin.id, "SUBJECT", created.id, {
      nameAr: "جبر متقدم",
      nameEn: `${CATALOG_PREFIX} Advanced Algebra`,
      parentId: grade.id,
    });
    const editedAudit = await prisma.auditLog.findFirst({
      where: { action: "platform.catalog.update", entityId: created.id },
    });
    check(
      "A platform admin can edit both names; the audit row carries before and after",
      edited.ok &&
        (editedAudit?.before as { nameEn?: string } | null)?.nameEn === `${CATALOG_PREFIX} Algebra` &&
        (editedAudit?.after as { nameEn?: string } | null)?.nameEn === `${CATALOG_PREFIX} Advanced Algebra`,
      JSON.stringify(editedAudit),
    );
  }
  if (systemCreated.ok) {
    await updateCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", systemCreated.id, {
      nameAr: "نظام جديد",
      nameEn: `${CATALOG_PREFIX} New System`,
      defaultFixedCenterShare: 6_500,
    });
    check(
      "…and an education system's defaultFixedCenterShare",
      (await prisma.catalogEducationSystem.findUnique({ where: { id: systemCreated.id } }))
        ?.defaultFixedCenterShare === 6_500,
    );
    const badShare = await updateCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", systemCreated.id, {
      nameAr: "نظام جديد",
      nameEn: `${CATALOG_PREFIX} New System`,
      defaultFixedCenterShare: -5,
    });
    check("…a negative default share is refused as invalidShare", refused(badShare, "invalidShare"));
  }
  const noSuchParent = await createCatalogEntry(prisma, admin.id, "GRADE", {
    nameAr: "ص",
    nameEn: `${CATALOG_PREFIX} Orphan Grade`,
    parentId: "no-such-system",
  });
  check("A parent that does not exist is refused as parentNotFound", refused(noSuchParent, "parentNotFound"));

  // ── 7. Both names are required (trimmed, 1..80) ─────────────────────────
  const bad = (names: { nameAr: string; nameEn: string }, kind: "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT" = "SUBJECT") =>
    createCatalogEntry(prisma, admin.id, kind, names);
  check("An empty English name is refused (nameEnRequired)", refused(await bad({ nameAr: "س", nameEn: "" }), "nameEnRequired"));
  check("A whitespace-only English name is refused (nameEnRequired)", refused(await bad({ nameAr: "س", nameEn: "   " }), "nameEnRequired"));
  check("An empty Arabic name is refused (nameArRequired)", refused(await bad({ nameAr: "", nameEn: `${CATALOG_PREFIX} NoAr` }), "nameArRequired"));
  check("A whitespace-only Arabic name is refused (nameArRequired)", refused(await bad({ nameAr: "  ", nameEn: `${CATALOG_PREFIX} NoAr` }), "nameArRequired"));
  check(
    "…for an education system and a grade too",
    refused(await bad({ nameAr: "", nameEn: `${CATALOG_PREFIX} X` }, "EDUCATION_SYSTEM"), "nameArRequired") &&
      refused(await bad({ nameAr: "ص", nameEn: " " }, "GRADE"), "nameEnRequired"),
  );
  check(
    `A name over ${CATALOG_NAME_MAX} characters is refused in either language`,
    refused(await bad({ nameAr: "س", nameEn: `${CATALOG_PREFIX} ${"x".repeat(CATALOG_NAME_MAX)}` }), "nameEnTooLong") &&
      refused(await bad({ nameAr: "س".repeat(CATALOG_NAME_MAX + 1), nameEn: `${CATALOG_PREFIX} Long` }), "nameArTooLong"),
  );
  const padded = await bad({
    nameAr: `  ${"س".repeat(CATALOG_NAME_MAX)}  `,
    nameEn: `  ${CATALOG_PREFIX} ${"y".repeat(CATALOG_NAME_MAX - CATALOG_PREFIX.length - 1)}  `,
  });
  check("Surrounding whitespace is trimmed before the length rule (exactly 80 is fine)", padded.ok, JSON.stringify(padded));
  if (padded.ok) {
    check(
      "…and the stored names are the trimmed ones",
      padded.after.nameAr === "س".repeat(CATALOG_NAME_MAX) && !padded.after.nameEn.startsWith(" ") && !padded.after.nameEn.endsWith(" "),
    );
    await deleteCatalogEntry(prisma, admin.id, "SUBJECT", padded.id);
  }

  // ── 8. Duplicates are refused case-insensitively within a parent ────────
  const grade2 = await prisma.catalogGrade.create({
    data: { nameAr: "صف ٢", nameEn: `${CATALOG_PREFIX} Grade Two`, educationSystemId: system.id },
  });
  const dupBase = await createCatalogEntry(prisma, admin.id, "SUBJECT", {
    nameAr: "هندسة",
    nameEn: `${CATALOG_PREFIX} Geometry`,
    parentId: grade.id,
  });
  check("Fixture: a subject to collide with", dupBase.ok, JSON.stringify(dupBase));
  check(
    "The same English name in another case and spacing under the same grade → duplicateNameEn",
    refused(
      await createCatalogEntry(prisma, admin.id, "SUBJECT", {
        nameAr: "اسم مختلف",
        nameEn: `  ${CATALOG_PREFIX.toLowerCase()}   GEOMETRY `,
        parentId: grade.id,
      }),
      "duplicateNameEn",
    ),
  );
  check(
    "The same Arabic name under the same grade (different English) → duplicateNameAr",
    refused(
      await createCatalogEntry(prisma, admin.id, "SUBJECT", {
        nameAr: " هندسة ",
        nameEn: `${CATALOG_PREFIX} Geometry Two`,
        parentId: grade.id,
      }),
      "duplicateNameAr",
    ),
  );
  const sameUnderOtherGrade = await createCatalogEntry(prisma, admin.id, "SUBJECT", {
    nameAr: "هندسة",
    nameEn: `${CATALOG_PREFIX} Geometry`,
    parentId: grade2.id,
  });
  check("The same names under a different grade are allowed (the rule is per parent)", sameUnderOtherGrade.ok, JSON.stringify(sameUnderOtherGrade));
  const parentless = await createCatalogEntry(prisma, admin.id, "SUBJECT", {
    nameAr: "هندسة",
    nameEn: `${CATALOG_PREFIX} Geometry`,
    parentId: null,
  });
  check("…and with no grade at all", parentless.ok, JSON.stringify(parentless));
  check(
    "…but a second parentless subject with those names is refused",
    refused(
      await createCatalogEntry(prisma, admin.id, "SUBJECT", {
        nameAr: "هندسة جديدة",
        nameEn: `${CATALOG_PREFIX} geometry`,
        parentId: null,
      }),
      "duplicateNameEn",
    ),
  );
  if (dupBase.ok) {
    check(
      "Saving an entry with its own unchanged names is not a duplicate of itself",
      (
        await updateCatalogEntry(prisma, admin.id, "SUBJECT", dupBase.id, {
          nameAr: "هندسة",
          nameEn: `${CATALOG_PREFIX} Geometry`,
          parentId: grade.id,
        })
      ).ok,
    );
    check(
      "Renaming an entry to a sibling's name is refused",
      refused(
        await updateCatalogEntry(prisma, admin.id, "SUBJECT", dupBase.id, {
          nameAr: "جبر متقدم",
          nameEn: `${CATALOG_PREFIX} Advanced Algebra`,
          parentId: grade.id,
        }),
        "duplicateNameEn",
      ),
    );
    check(
      "Moving an entry under a parent that already has its name is refused",
      sameUnderOtherGrade.ok &&
        refused(
          await updateCatalogEntry(prisma, admin.id, "SUBJECT", dupBase.id, {
            nameAr: "هندسة",
            nameEn: `${CATALOG_PREFIX} Geometry`,
            parentId: grade2.id,
          }),
          "duplicateNameEn",
        ),
    );
    await setCatalogEntryActive(prisma, admin.id, "SUBJECT", dupBase.id, false);
    check(
      "A deactivated sibling still blocks its name",
      refused(
        await createCatalogEntry(prisma, admin.id, "SUBJECT", {
          nameAr: "هندسة أخرى",
          nameEn: `${CATALOG_PREFIX} GEOMETRY`,
          parentId: grade.id,
        }),
        "duplicateNameEn",
      ),
    );
  }
  check(
    "Education systems are unique among all systems, and grades among a system's grades",
    refused(
      await createCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", {
        nameAr: "اسم آخر",
        nameEn: `${CATALOG_PREFIX} SYSTEM`,
      }),
      "duplicateNameEn",
    ) &&
      refused(
        await createCatalogEntry(prisma, admin.id, "GRADE", {
          nameAr: `${CATALOG_PREFIX} صف`,
          nameEn: `${CATALOG_PREFIX} Another Grade`,
          parentId: system.id,
        }),
        "duplicateNameAr",
      ),
  );
  check(
    "catalogNameKey is the one comparison: case, inner whitespace and edges are ignored",
    catalogNameKey("  Maths   Plus ") === catalogNameKey("maths plus") && catalogNameKey("a") !== catalogNameKey("b"),
  );

  // ── 9. Deleting: blocked while referenced, allowed when free ────────────
  // (one reference kind at a time, so each blocker is shown to count)
  const mkSubject = (tag: string) =>
    createCatalogEntry(prisma, admin.id, "SUBJECT", { nameAr: `مادة ${tag}`, nameEn: `${CATALOG_PREFIX} Del ${tag}`, parentId: null });
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

  // 9a. a centre's selection
  const delSel = await mkSubject("sel");
  if (delSel.ok) {
    const picked = await selectCatalogEntry(prisma, centerB.id, "SUBJECT", delSel.id, null, null);
    const blocked = await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delSel.id);
    check(
      "Delete is blocked while a centre has picked the entry, naming the count (centres: 1)",
      refused(blocked, "inUse") && !blocked.ok && blocked.usage?.centres === 1 && blocked.usage.classes === 0,
      JSON.stringify(blocked),
    );
    check("…and the row survives the refused delete", (await prisma.catalogSubject.findUnique({ where: { id: delSel.id } })) !== null);
    if (picked.ok) await removeCatalogSelection(prisma, picked.selectionId);
    const freed = await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delSel.id);
    check("Once nothing references it, the same delete succeeds", freed.ok, JSON.stringify(freed));
    check("…and the row is gone", (await prisma.catalogSubject.findUnique({ where: { id: delSel.id } })) === null);
    const deleteAudit = await prisma.auditLog.findFirst({
      where: { action: "platform.catalog.delete", entityId: delSel.id },
    });
    check(
      "…audited as platform.catalog.delete with the row as before and no after",
      (deleteAudit?.before as { nameEn?: string } | null)?.nameEn === `${CATALOG_PREFIX} Del sel` && deleteAudit?.after === null,
      JSON.stringify(deleteAudit),
    );
    check(
      "Deleting what no longer exists is notFound",
      refused(await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delSel.id), "notFound"),
    );
  }

  // 9b. a class
  const delClass = await mkSubject("class");
  if (delClass.ok) {
    const classRef = await prisma.classGroup.create({
      data: scopedData(centerB.id, {
        startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
        teacherId: teacherB.id,
        subjectId: delClass.id,
        roomId: roomB.id,
        price: 10_000,
      }),
    });
    const blocked = await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delClass.id);
    check(
      "Delete is blocked while a class uses the entry (classes: 1)",
      refused(blocked, "inUse") && !blocked.ok && blocked.usage?.classes === 1 && blocked.usage.centres === 0,
      JSON.stringify(blocked),
    );
    check(
      "…and the class keeps its subject (no silent SET NULL)",
      (await prisma.classGroup.findUnique({ where: { id: classRef.id } }))?.subjectId === delClass.id,
    );
    await prisma.classGroup.delete({ where: { id: classRef.id } });
    check("…delete succeeds once the class is gone", (await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delClass.id)).ok);
  }

  // 9c. a one-time session
  const delSession = await mkSubject("session");
  if (delSession.ok) {
    const oneOff = await prisma.session.create({
      data: scopedData(centerB.id, {
        classGroupId: null,
        title: "One-off",
        isManual: true,
        subjectId: delSession.id,
        teacherId: teacherB.id,
        roomId: roomB.id,
        date: new Date("2026-02-02T00:00:00.000Z"),
        startTime: "10:00",
        endTime: "11:00",
      }),
    });
    const blocked = await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delSession.id);
    check(
      "Delete is blocked while a one-time session names the entry (sessions: 1)",
      refused(blocked, "inUse") && !blocked.ok && blocked.usage?.sessions === 1,
      JSON.stringify(blocked),
    );
    await prisma.session.delete({ where: { id: oneOff.id } });
    check("…delete succeeds once the session is gone", (await deleteCatalogEntry(prisma, admin.id, "SUBJECT", delSession.id)).ok);
  }

  // 9d. a student profile (grades) and child entries (systems, grades)
  const delGrade = await createCatalogEntry(prisma, admin.id, "GRADE", {
    nameAr: "صف للحذف",
    nameEn: `${CATALOG_PREFIX} Del Grade`,
    parentId: null,
  });
  if (delGrade.ok) {
    const studentUserB = await prisma.user.create({
      data: { firstName: "S", lastName: "CatalogB", email: "catalog-check-student-b@kayedu.test", locale: "en" },
    });
    const profile = await prisma.studentProfile.create({
      data: scopedData(centerB.id, {
        userId: studentUserB.id,
        studentCode: "9202",
        firstName: "S",
        lastName: "CatalogB",
        gradeId: delGrade.id,
      }),
    });
    const child = await createCatalogEntry(prisma, admin.id, "SUBJECT", {
      nameAr: "فرعي",
      nameEn: `${CATALOG_PREFIX} Del Child`,
      parentId: delGrade.id,
    });
    const blocked = await deleteCatalogEntry(prisma, admin.id, "GRADE", delGrade.id);
    check(
      "Delete is blocked while a student has the grade and a subject sits under it (students: 1, children: 1)",
      refused(blocked, "inUse") && !blocked.ok && blocked.usage?.students === 1 && blocked.usage.children === 1,
      JSON.stringify(blocked),
    );
    await prisma.studentProfile.delete({ where: { id: profile.id } });
    check(
      "…still blocked by the child subject alone",
      refused(await deleteCatalogEntry(prisma, admin.id, "GRADE", delGrade.id), "inUse"),
    );
    if (child.ok) await deleteCatalogEntry(prisma, admin.id, "SUBJECT", child.id);
    check("…and deleted once both are gone", (await deleteCatalogEntry(prisma, admin.id, "GRADE", delGrade.id)).ok);
  }
  const usedSystem = await catalogEntryUsage(prisma, "EDUCATION_SYSTEM", system.id);
  check(
    "An education system's usage counts its picks and its grades",
    usedSystem.centres === 2 && usedSystem.children >= 1,
    JSON.stringify(usedSystem),
  );
  check(
    "…so deleting it is refused",
    refused(await deleteCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", system.id), "inUse"),
  );

  // ── 10. Deselecting cleans up a centre's own selection only ─────────────
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

  // ── 11. FIXED centre-cut: per-education-system default, config-time only ─
  const teacherUser = await prisma.user.create({
    data: { firstName: "T", lastName: "Catalog", email: "catalog-check-teacher-a@kayedu.test", locale: "en" },
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
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacherUser.id,
      subjectId: subject.id,
      gradeId: grade.id,
      educationSystemId: system.id,
      roomId: room.id,
      price: 10_000,
      centerShareType: "FIXED",
      centerShareValue: system.defaultFixedCenterShare, // 4,000 — inherited
    }),
  });

  // Changing the system's default afterwards must move zero existing classes.
  // (Through the admin write path, as a platform admin would.)
  await updateCatalogEntry(prisma, admin.id, "EDUCATION_SYSTEM", system.id, {
    nameAr: system.nameAr,
    nameEn: system.nameEn,
    defaultFixedCenterShare: 9_999,
  });
  const classAfterDefaultChange = await prisma.classGroup.findUnique({ where: { id: classGroup.id } });
  check(
    "Changing a system's defaultFixedCenterShare moves zero existing classes",
    classAfterDefaultChange?.centerShareValue === 4_000,
    `got ${classAfterDefaultChange?.centerShareValue}`,
  );

  // ── 12. Per-session override — recordPayment prefers it over the class ──
  const studentUser2 = await prisma.user.create({
    data: { firstName: "S", lastName: "Catalog", locale: "en" },
  });
  const studentProfile = await prisma.studentProfile.create({
    data: scopedData(centerA.id, {
      userId: studentUser2.id,
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

  const methodId = await fixtureMethodId(centerA.id);
  const paymentInheriting = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeInheriting.id, methodId, teacherUser.id, { historicalBackfill: true }),
  );
  const expectedInheriting = splitShare(10_000, "FIXED", 4_000);
  check(
    "A session with no override freezes the class's own FIXED cut",
    paymentInheriting.ok &&
      paymentInheriting.payment.centerShareSnapshot === expectedInheriting.centerShare,
    JSON.stringify(paymentInheriting),
  );

  const methodId2 = await fixtureMethodId(centerA.id);
  const paymentOverridden = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeOverridden.id, methodId2, teacherUser.id, { historicalBackfill: true }),
  );
  const expectedOverridden = splitShare(10_000, "PERCENTAGE", 50);
  check(
    "A session's own override wins over the class's cut when recording a payment",
    paymentOverridden.ok &&
      paymentOverridden.payment.centerShareSnapshot === expectedOverridden.centerShare &&
      expectedOverridden.centerShare !== expectedInheriting.centerShare,
    JSON.stringify(paymentOverridden),
  );

  // ── 13. A rename propagates to every live read, per language ────────────
  // Class lists, session lists and Discover all resolve this centre's own
  // `CenterCatalogSelection` names. Nothing in this schema freezes a catalog
  // entry's name (unlike `priceSnapshot` for money), so every one of these is
  // a live join and must reflect a rename immediately — in the language it
  // was written in, and only that one.
  const selectSubjectA = await selectCatalogEntry(
    prisma,
    centerA.id,
    "SUBJECT",
    subject.id,
    { displayNameEn: "Centre A's Physics" },
    null,
  );
  check("Centre A selects the subject and renames it in English", selectSubjectA.ok, JSON.stringify(selectSubjectA));

  // Centre B gets its own class referencing the *same* global subject,
  // never selected (let alone renamed) at Centre B.
  const classGroupB = await prisma.classGroup.create({
    data: scopedData(centerB.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
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
    "Centre A's own class-list read resolves its English rename in the English UI",
    catalogLabelWithSelection("en", classListRowA?.subject ?? null) === "Centre A's Physics",
    catalogLabelWithSelection("en", classListRowA?.subject ?? null) ?? "null",
  );
  check(
    "…and shows the canonical Arabic name in the Arabic UI (no Arabic override yet)",
    catalogLabelWithSelection("ar", classListRowA?.subject ?? null) === subject.nameAr,
    catalogLabelWithSelection("ar", classListRowA?.subject ?? null) ?? "null",
  );

  if (selectSubjectA.ok) {
    await updateCatalogSelection(prisma, selectSubjectA.selectionId, {
      displayNameAr: "فيزياء المركز أ",
      displayNameEn: "Centre A's Physics",
    });
  }
  const renamedRowA = await prisma.classGroup.findFirst({
    where: { id: classGroup.id },
    select: classListSelect(centerA.id),
  });
  check(
    "Renaming it in Arabic too: the Arabic UI shows the Arabic override, the English UI keeps the English one",
    catalogLabelWithSelection("ar", renamedRowA?.subject ?? null) === "فيزياء المركز أ" &&
      catalogLabelWithSelection("en", renamedRowA?.subject ?? null) === "Centre A's Physics",
  );

  const classListRowB = await prisma.classGroup.findFirst({
    where: { id: classGroupB.id },
    select: classListSelect(centerB.id),
  });
  check(
    "Centre B's read of the same global subject shows the canonical names in both locales — Centre A's renames never leak",
    catalogLabelWithSelection("en", classListRowB?.subject ?? null) === subject.nameEn &&
      catalogLabelWithSelection("ar", classListRowB?.subject ?? null) === subject.nameAr,
  );

  const sessionListRowsA = await prisma.session.findMany({
    where: { id: sessionInheriting.id },
    select: sessionListSelect(centerA.id),
  });
  check(
    "Centre A's own session-list read resolves the same renames through the class, per language",
    catalogLabelWithSelection("en", sessionListRowsA[0]?.classGroup?.subject ?? null) === "Centre A's Physics" &&
      catalogLabelWithSelection("ar", sessionListRowsA[0]?.classGroup?.subject ?? null) === "فيزياء المركز أ",
  );

  const discoverRowsA = await discoverClassesForCenter(prisma, centerA.id);
  const discoverRowA = discoverRowsA.find((row) => row.id === classGroup.id);
  check(
    "Discover resolves Centre A's own renames for Centre A's class, per language",
    Boolean(discoverRowA) &&
      catalogLabelWithSelection("en", discoverRowA?.subject ?? null) === "Centre A's Physics" &&
      catalogLabelWithSelection("ar", discoverRowA?.subject ?? null) === "فيزياء المركز أ",
  );

  if (selectSubjectA.ok) {
    await updateCatalogSelection(prisma, selectSubjectA.selectionId, { displayNameAr: null, displayNameEn: null });
  }
  const clearedRowA = await prisma.classGroup.findFirst({
    where: { id: classGroup.id },
    select: classListSelect(centerA.id),
  });
  check(
    "Clearing both fields reverts to the canonical names; blank input is stored as null",
    catalogLabelWithSelection("en", clearedRowA?.subject ?? null) === subject.nameEn &&
      catalogLabelWithSelection("ar", clearedRowA?.subject ?? null) === subject.nameAr &&
      (await centerSubjects(prisma, centerA.id)).every((row) => row.displayNameAr === null && row.displayNameEn === null),
  );
  if (selectSubjectA.ok) {
    await updateCatalogSelection(prisma, selectSubjectA.selectionId, { displayNameAr: "   ", displayNameEn: "" });
    const blankStored = await prisma.centerCatalogSelection.findUnique({ where: { id: selectSubjectA.selectionId } });
    check("…whitespace and empty strings are normalised to null, not stored", blankStored?.displayNameAr === null && blankStored.displayNameEn === null);
    await updateCatalogSelection(prisma, selectSubjectA.selectionId, {
      displayNameAr: "فيزياء المركز أ",
      displayNameEn: "Centre A's Physics",
    });
  }

  // ── 14. Deactivating hides an entry from pickers, never from history ────
  const deactivated = await setCatalogEntryActive(prisma, admin.id, "SUBJECT", subject.id, false);
  check("A platform admin deactivates the subject Centre A's class uses", deactivated.ok, JSON.stringify(deactivated));
  const deactivateAudit = await prisma.auditLog.findFirst({
    where: { action: "platform.catalog.deactivate", entityId: subject.id },
  });
  check(
    "…audited as platform.catalog.deactivate with active true → false",
    (deactivateAudit?.before as { active?: boolean } | null)?.active === true &&
      (deactivateAudit?.after as { active?: boolean } | null)?.active === false,
    JSON.stringify(deactivateAudit),
  );
  check(
    "Deactivating twice is refused (alreadyInState)",
    refused(await setCatalogEntryActive(prisma, admin.id, "SUBJECT", subject.id, false), "alreadyInState"),
  );
  check(
    "The deactivated subject is gone from the picker/filter list (listCatalogSubjects, active only)…",
    !(await listCatalogSubjects(prisma)).some((row) => row.id === subject.id),
  );
  check(
    "…but still in the full list the admin screen reads",
    (await listCatalogSubjects(prisma, undefined, false)).some((row) => row.id === subject.id) &&
      (await listCatalogAdminRows(prisma, "SUBJECT")).some((row) => row.id === subject.id && row.active === false),
  );
  const pickAfter = await selectCatalogEntry(prisma, centerB.id, "SUBJECT", subject.id, null, null);
  check("A centre cannot pick a deactivated entry (notFound)", !pickAfter.ok && pickAfter.error === "notFound", JSON.stringify(pickAfter));
  const centreViews = await centerSubjects(prisma, centerA.id);
  const retiredView = centreViews.find((row) => row.id === subject.id);
  check(
    "Centre A's own view still lists the pick, flagged catalogActive = false, so a picker can leave it out",
    Boolean(retiredView) && retiredView?.catalogActive === false && retiredView.active === true,
    JSON.stringify(retiredView),
  );
  check(
    "…a picker built the way scoped().subjects.list({ active: true }) is (pick active AND entry active) excludes it",
    !centreViews.filter((row) => row.active && row.catalogActive).some((row) => row.id === subject.id),
  );
  const historyRow = await prisma.classGroup.findFirst({
    where: { id: classGroup.id },
    select: classListSelect(centerA.id),
  });
  check(
    "History still resolves: the class list shows the deactivated subject with Centre A's renames",
    catalogLabelWithSelection("en", historyRow?.subject ?? null) === "Centre A's Physics" &&
      catalogLabelWithSelection("ar", historyRow?.subject ?? null) === "فيزياء المركز أ",
  );
  const sessionHistory = await prisma.session.findMany({
    where: { id: sessionInheriting.id },
    select: sessionListSelect(centerA.id),
  });
  check(
    "…and so does the session list",
    catalogLabelWithSelection("en", sessionHistory[0]?.classGroup?.subject ?? null) === "Centre A's Physics",
  );
  const discoverAfter = (await discoverClassesForCenter(prisma, centerA.id)).find((row) => row.id === classGroup.id);
  check(
    "…and a Discover card for the existing class (it renders; the subject filter list no longer offers it)",
    Boolean(discoverAfter) && catalogLabelWithSelection("en", discoverAfter?.subject ?? null) === "Centre A's Physics",
  );
  check(
    "A deactivated entry cannot be hard-deleted while in use — the admin is pointed at Deactivate (inUse)",
    refused(await deleteCatalogEntry(prisma, admin.id, "SUBJECT", subject.id), "inUse"),
  );
  const reactivated = await setCatalogEntryActive(prisma, admin.id, "SUBJECT", subject.id, true);
  check(
    "Reactivating returns it to the picker list",
    reactivated.ok && (await listCatalogSubjects(prisma)).some((row) => row.id === subject.id),
  );
  // A deactivated grade and system behave the same way.
  await setCatalogEntryActive(prisma, admin.id, "GRADE", grade.id, false);
  await setCatalogEntryActive(prisma, admin.id, "EDUCATION_SYSTEM", system.id, false);
  check(
    "Deactivated grades and education systems also leave their picker lists",
    !(await listCatalogGrades(prisma)).some((row) => row.id === grade.id) &&
      !(await listCatalogEducationSystems(prisma)).some((row) => row.id === system.id),
  );
  check(
    "…while Centre A's view of the system it picked still resolves",
    (await centerEducationSystemById(prisma, centerA.id, system.id))?.catalogActive === false,
  );
  await setCatalogEntryActive(prisma, admin.id, "GRADE", grade.id, true);
  await setCatalogEntryActive(prisma, admin.id, "EDUCATION_SYSTEM", system.id, true);

  // ── 15. Cross-centre isolation on the money-adjacent rows above ─────────
  check(
    "Centre B cannot read Centre A's ClassGroup by id",
    (await scopedFindById(prisma.classGroup, centerB.id, classGroup.id)) === null,
  );
  check(
    "Centre B cannot read Centre A's Session by id",
    (await scopedFindById(prisma.session, centerB.id, sessionOverridden.id)) === null,
  );
  const selectionsInB = await prisma.centerCatalogSelection.findMany({ where: { centerId: centerB.id } });
  check(
    "Centre B's catalog selections hold only its own rows, none carrying Centre A's renames",
    selectionsInB.every((row) => row.centerId === centerB.id) &&
      selectionsInB.every((row) => row.displayNameAr === null && row.displayNameEn === null),
  );

  // ── 16. The migration's backfill rule (Arabic-script detection) ─────────
  // Pure function first…
  const cp = (codePoint: number) => String.fromCodePoint(codePoint);
  const samples: { text: string | null; ar: string | null; en: string | null }[] = [
    { text: "الرياضيات", ar: "الرياضيات", en: null },
    { text: "Maths", ar: null, en: "Maths" },
    { text: "  Grade 10  ", ar: null, en: "Grade 10" },
    { text: "Maths رياضيات", ar: "Maths رياضيات", en: null }, // any Arabic-script character wins
    { text: cp(0x0750), ar: cp(0x0750), en: null }, // Arabic Supplement
    { text: cp(0x08a0), ar: cp(0x08a0), en: null }, // Arabic Extended-A
    { text: cp(0xfb50), ar: cp(0xfb50), en: null }, // Presentation Forms-A
    { text: cp(0xfefb), ar: cp(0xfefb), en: null }, // Presentation Forms-B
    { text: "Français é ü 日本語", ar: null, en: "Français é ü 日本語" }, // other scripts are not Arabic
    { text: cp(0x0663), ar: cp(0x0663), en: null }, // an Arabic-Indic digit lives in the Arabic block
    { text: "   ", ar: null, en: null },
    { text: "", ar: null, en: null },
    { text: null, ar: null, en: null },
  ];
  check(
    "backfillLegacyName splits a legacy name by Arabic script (13 samples, all five Unicode ranges)",
    samples.every((sample) => {
      const got = backfillLegacyName(sample.text);
      return got.displayNameAr === sample.ar && got.displayNameEn === sample.en;
    }),
    JSON.stringify(samples.map((sample) => backfillLegacyName(sample.text))),
  );
  check(
    "containsArabicScript is false just outside each range edge",
    !containsArabicScript(String.fromCodePoint(0x05ff)) &&
      !containsArabicScript(String.fromCodePoint(0x0700)) &&
      !containsArabicScript(String.fromCodePoint(0x0780)) &&
      !containsArabicScript(String.fromCodePoint(0x08ff + 1)) &&
      !containsArabicScript(String.fromCodePoint(0xfb4f)) &&
      !containsArabicScript(String.fromCodePoint(0xfe00)) &&
      containsArabicScript(String.fromCodePoint(0x06ff)) &&
      containsArabicScript(String.fromCodePoint(0x08ff)) &&
      containsArabicScript(String.fromCodePoint(0xfdff)) &&
      containsArabicScript(String.fromCodePoint(0xfeff)),
  );

  // …then the actual SQL in the shipped migration, run over the same samples
  // in a temporary table, must agree with it.
  const migrationSql = readFileSync(
    join("prisma", "migrations", "20261016090000_r8_catalog_admin_bilingual_names", "migration.sql"),
    "utf8",
  );
  const updates = migrationSql.match(/UPDATE "CenterCatalogSelection"[\s\S]*?;/g) ?? [];
  check("The migration contains the two backfill UPDATE statements", updates.length === 2, `found ${updates.length}`);
  const sqlResult = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE r8_backfill ("id" int, "displayName" text, "displayNameAr" text, "displayNameEn" text) ON COMMIT DROP`,
    );
    for (const [index, sample] of samples.entries()) {
      await tx.$executeRawUnsafe(`INSERT INTO r8_backfill ("id", "displayName") VALUES ($1, $2)`, index, sample.text);
    }
    for (const statement of updates) {
      await tx.$executeRawUnsafe(statement.replace('"CenterCatalogSelection"', "r8_backfill"));
    }
    return tx.$queryRawUnsafe<{ id: number; displayNameAr: string | null; displayNameEn: string | null }[]>(
      `SELECT "id", "displayNameAr", "displayNameEn" FROM r8_backfill ORDER BY "id"`,
    );
  });
  check(
    "The migration's own UPDATE statements, run over those samples, give exactly what backfillLegacyName gives",
    sqlResult.length === samples.length &&
      sqlResult.every((row) => {
        const expected = backfillLegacyName(samples[row.id].text);
        return row.displayNameAr === expected.displayNameAr && row.displayNameEn === expected.displayNameEn;
      }),
    JSON.stringify(sqlResult),
  );

  // ── 17. Static: nothing of the suggestion queue, nothing reads displayName,
  //       no centre-side code writes a global row ────────────────────────────
  const root = process.cwd();
  const scanRoots = ["app", "lib", "components", "messages", "prisma", "supabase", "scripts", "proxy.ts"].map((entry) =>
    join(root, entry),
  );
  const files = scanRoots.flatMap((entry) => {
    try {
      return statSync(entry).isDirectory() ? sourceFiles(entry) : [entry];
    } catch {
      return [];
    }
  });
  const rel = (file: string) => relative(root, file).split(sep).join("/");
  const self = "scripts/catalog-check.ts";
  const isMigration = (file: string) => rel(file).startsWith("prisma/migrations/");
  const scannable = files.filter((file) => rel(file) !== self && !isMigration(file));

  const grepCode = (pattern: RegExp, within = scannable) =>
    within
      .filter((file) => !file.endsWith(".json") && !file.endsWith(".sql") ? pattern.test(stripComments(readFileSync(file, "utf8"))) : pattern.test(readFileSync(file, "utf8")))
      .map(rel);

  check(
    "The static scan actually covers the codebase (not vacuously empty)",
    scannable.length > 150 && scannable.some((file) => rel(file) === "lib/catalog.ts") && scannable.some((file) => rel(file) === "messages/en.json"),
    `${scannable.length} files`,
  );
  const suggestionHits = grepCode(/CatalogSuggestion|catalogSuggestion/);
  check(
    "No CatalogSuggestion / catalogSuggestion anywhere in app, lib, components, messages, prisma schema/seed, supabase or scripts",
    suggestionHits.length === 0,
    suggestionHits.join(", "),
  );
  const suggestionFnHits = grepCode(/\b(suggestCatalogEntry\w*|createCatalogSuggestion|approveCatalogSuggestion|rejectCatalogSuggestion|listPendingCatalogSuggestions|catalogSuggestionSchema|catalogSuggestionIdSchema)\b/);
  check("No suggestion action, query or schema exists", suggestionFnHits.length === 0, suggestionFnHits.join(", "));

  const displayNameHits = grepCode(/\bdisplayName\b/);
  check(
    "Nothing reads or writes the dropped CenterCatalogSelection.displayName (comments aside)",
    displayNameHits.length === 0,
    displayNameHits.join(", "),
  );
  const schemaText = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
  const selectionModel = schemaText.match(/model CenterCatalogSelection \{[\s\S]*?\n\}/)?.[0] ?? "";
  check(
    "schema.prisma: CenterCatalogSelection has displayNameAr + displayNameEn, no displayName; no suggestion model or enum",
    /displayNameAr\s+String\?/.test(selectionModel) &&
      /displayNameEn\s+String\?/.test(selectionModel) &&
      !/^\s*displayName\s/m.test(selectionModel) &&
      !/CatalogSuggestion/.test(schemaText) &&
      /enum CatalogEntryKind/.test(schemaText) &&
      /kind\s+CatalogEntryKind/.test(selectionModel),
  );

  const messageKeysWithSuggest: string[] = [];
  const walkKeys = (value: unknown, path: string) => {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/suggest/i.test(key) && (path.startsWith("Settings.catalog") || path.startsWith("AdminCatalog"))) {
          messageKeysWithSuggest.push(`${path}.${key}`);
        }
        walkKeys(child, path ? `${path}.${key}` : key);
      }
    }
  };
  for (const locale of ["en", "ar"]) {
    walkKeys(JSON.parse(readFileSync(join(root, "messages", `${locale}.json`), "utf8")), "");
  }
  check(
    "messages (en + ar): no suggestion keys under Settings.catalog or AdminCatalog",
    messageKeysWithSuggest.length === 0,
    messageKeysWithSuggest.join(", "),
  );

  const GLOBAL_WRITE = /\bcatalog(EducationSystem|Grade|Subject)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
  const runtimeCode = scannable.filter((file) => /^(app|lib|components)\//.test(rel(file)));
  const writers = grepCode(GLOBAL_WRITE, runtimeCode).filter((file) => file !== "lib/db/catalog-admin.ts");
  check(
    "Only lib/db/catalog-admin.ts writes a global catalog row in app/, lib/ or components/ — no centre-side code does",
    writers.length === 0,
    writers.join(", "),
  );
  const adminSource = stripComments(readFileSync(join(root, "lib", "db", "catalog-admin.ts"), "utf8"));
  const exportedWrites = ["createCatalogEntry", "updateCatalogEntry", "setCatalogEntryActive", "deleteCatalogEntry"];
  check(
    "Every exported global write starts with the platform-admin check",
    exportedWrites.every((name) => {
      const body = adminSource.split(`export async function ${name}(`)[1]?.split("\nexport ")[0] ?? "";
      return /if \(!\(await isPlatformAdminUser\(db, actorUserId\)\)\) return \{ ok: false, error: "forbidden" \};/.test(body);
    }),
  );
  const adminActions = readFileSync(join(root, "app", "[locale]", "(admin)", "admin", "catalog", "actions.ts"), "utf8");
  check(
    "Every admin catalog Server Action calls requirePlatformAdmin() before anything else",
    (adminActions.match(/export async function \w+Action/g) ?? []).length === 4 &&
      (adminActions.match(/await requirePlatformAdmin\(\)/g) ?? []).length === 4,
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
