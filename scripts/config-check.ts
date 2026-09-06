/**
 * Center-configuration check — the M2 acceptance gate:
 * "a fresh center can be fully configured through the UI with no SQL, and
 *  adding a *second* center and configuring it needs zero code changes."
 *
 * Run with:  npm run check:config
 *
 * It configures **two** throwaway centers by calling one `configureCenter()`
 * with nothing but a centerId — no per-center branching anywhere — using the
 * same zod schemas the settings Server Actions parse with and the same
 * tenant-scoping primitives lib/db/scoped.ts is built on. Then it asserts the
 * two configurations are independent, that neither center can see the other's
 * config rows, that the permission-grant seam widens a receptionist and
 * nobody else, and that the center-cut split is right in both modes.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import {
  scopedData,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import { can, permissionGrantsFromSettings } from "../lib/auth/permissions.ts";
import { splitShare } from "../lib/money.ts";
import {
  cardLayoutSchema,
  educationSystemSchema,
  generalSettingsSchema,
  gradeSchema,
  permissionGrantsSchema,
  roomSchema,
  subjectSchema,
} from "../lib/validation/settings.ts";

const prisma = new PrismaClient();

const SLUG_A = "config-check-a";
const SLUG_B = "config-check-b";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Parses like a Server Action does, and shouts if the fixture is wrong. */
function parse<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: Record<string, string>,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined) {
    throw new Error(`${label} failed validation: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * The whole of M2's configuration surface, driven by form-shaped input.
 * Takes a centerId and nothing else — this function *is* the "zero code
 * changes for a second center" claim.
 */
async function configureCenter(centerId: string) {
  const system = parse(
    educationSystemSchema,
    { locale: "en", name: "National", basePrice: "120" },
    "educationSystem",
  );
  const systemRow = await prisma.educationSystem.create({
    data: scopedData(centerId, {
      name: system.name,
      basePrice: system.basePrice,
    }),
  });

  const grade = parse(
    gradeSchema,
    { locale: "en", name: "Grade 10", educationSystemId: systemRow.id },
    "grade",
  );
  const gradeRow = await prisma.grade.create({
    data: scopedData(centerId, {
      name: grade.name,
      educationSystemId: grade.educationSystemId,
    }),
  });

  const subject = parse(
    subjectSchema,
    { locale: "en", name: "Mathematics", gradeId: gradeRow.id },
    "subject",
  );
  const subjectRow = await prisma.subject.create({
    data: scopedData(centerId, {
      name: subject.name,
      gradeId: subject.gradeId,
    }),
  });

  const room = parse(
    roomSchema,
    { locale: "en", name: "Room 1", capacity: "30" },
    "room",
  );
  const roomRow = await prisma.room.create({
    data: scopedData(centerId, {
      name: room.name,
      capacity: room.capacity,
    }),
  });

  const general = parse(
    generalSettingsSchema,
    {
      locale: "en",
      defaultShareType: "PERCENTAGE",
      shareValue: "20",
      teacherTimeoutEnabled: "on",
      teacherTimeoutDays: "45",
      defaultLateThreshold: "15",
      timezone: "Africa/Cairo",
    },
    "generalSettings",
  );

  const card = parse(
    cardLayoutSchema,
    { locale: "en", cardLayout: '{"version":1,"elements":{"qr":{"x":74}}}' },
    "cardLayout",
  );

  const grants = parse(
    permissionGrantsSchema,
    {
      locale: "en",
      receptionistCanViewProfit: "on",
      receptionistCanCorrectAttendance: "on",
    },
    "permissionGrants",
  );

  const cardLayout = (card.cardLayout ?? undefined) as
    | Prisma.InputJsonValue
    | undefined;

  const settingsRow = await prisma.centerSettings.upsert({
    where: { centerId },
    update: {
      defaultShareType: general.defaultShareType,
      defaultShareValue: general.defaultShareValue,
      teacherTimeoutDays: general.teacherTimeoutDays,
      defaultLateThreshold: general.defaultLateThreshold,
      timezone: general.timezone,
      cardLayout,
      receptionistCanViewProfit: grants.receptionistCanViewProfit,
      receptionistCanCorrectAttendance: grants.receptionistCanCorrectAttendance,
    },
    create: {
      centerId,
      defaultShareType: general.defaultShareType,
      defaultShareValue: general.defaultShareValue,
      teacherTimeoutDays: general.teacherTimeoutDays,
      defaultLateThreshold: general.defaultLateThreshold,
      timezone: general.timezone,
      cardLayout,
      receptionistCanViewProfit: grants.receptionistCanViewProfit,
      receptionistCanCorrectAttendance: grants.receptionistCanCorrectAttendance,
    },
  });

  return { systemRow, gradeRow, subjectRow, roomRow, settingsRow };
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
}

async function main() {
  await cleanup();

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Config A", organization: { create: { name: "Config A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Config B", organization: { create: { name: "Config B" } } },
  });

  console.log("Center configuration check");

  // ── 1. The same code configures both centers ────────────────────────────
  const a = await configureCenter(centerA.id);
  const b = await configureCenter(centerB.id);

  check(
    "One configureCenter() fully configures a fresh center",
    Boolean(a.systemRow && a.gradeRow && a.subjectRow && a.roomRow && a.settingsRow),
  );
  check(
    "The identical call configures a second center — no code changes",
    Boolean(b.systemRow && b.gradeRow && b.subjectRow && b.roomRow && b.settingsRow) &&
      b.systemRow.id !== a.systemRow.id,
  );

  // ── 2. EGP typed into a form is stored as integer piastres ──────────────
  check(
    "Base price 120 EGP is stored as 12000 piastres",
    a.systemRow.basePrice === 12_000,
    `got ${a.systemRow.basePrice}`,
  );

  // ── 3. Every config table is center-scoped ─────────────────────────────
  // One call per delegate, so each one is checked against its real Prisma type.
  const leaks: [string, unknown][] = [
    [
      "EducationSystem",
      await scopedFindById(prisma.educationSystem, centerA.id, b.systemRow.id),
    ],
    ["Grade", await scopedFindById(prisma.grade, centerA.id, b.gradeRow.id)],
    [
      "Subject",
      await scopedFindById(prisma.subject, centerA.id, b.subjectRow.id),
    ],
    ["Room", await scopedFindById(prisma.room, centerA.id, b.roomRow.id)],
  ];

  for (const [label, leaked] of leaks) {
    check(`Center A cannot read Center B's ${label} by id`, leaked === null);
  }

  const systemsInA = await prisma.educationSystem.findMany({
    where: scopedWhere(centerA.id),
  });
  check(
    "A scoped config list contains only the active center's rows",
    systemsInA.length === 1 && systemsInA[0].id === a.systemRow.id,
  );

  // ── 4. The permission-grant seam ───────────────────────────────────────
  const noGrants = permissionGrantsFromSettings({
    receptionistCanViewProfit: false,
    receptionistCanCorrectAttendance: false,
  });
  check(
    "Receptionist is denied profit by default",
    !can("RECEPTIONIST", "center.profit.view", noGrants),
  );
  check(
    "Receptionist is denied attendance correction by default",
    !can("RECEPTIONIST", "attendance.correct", noGrants),
  );

  const granted = permissionGrantsFromSettings(a.settingsRow);
  check(
    "Granting profit in settings lets a receptionist view profit",
    can("RECEPTIONIST", "center.profit.view", granted),
  );
  check(
    "Granting corrections in settings lets a receptionist correct attendance",
    can("RECEPTIONIST", "attendance.correct", granted),
  );
  check(
    "A grant cannot widen a role it is not grantable for (TEACHER + profit)",
    !can("TEACHER", "center.profit.view", granted),
  );
  check(
    "A grant never removes a baseline permission (OWNER keeps profit)",
    can("OWNER", "center.profit.view", noGrants),
  );

  // ── 5. Center-cut math (the default this screen configures) ────────────
  const percentage = splitShare(12_000, "PERCENTAGE", 15);
  const fixed = splitShare(12_000, "FIXED", 1_500);
  check(
    "PERCENTAGE 15% of 120 EGP → 18 / 102 EGP",
    percentage.centerShare === 1_800 && percentage.teacherShare === 10_200,
    JSON.stringify(percentage),
  );
  check(
    "FIXED 15 EGP of 120 EGP → 15 / 105 EGP",
    fixed.centerShare === 1_500 && fixed.teacherShare === 10_500,
    JSON.stringify(fixed),
  );

  // ── 6. The schemas reject what the UI must not store ───────────────────
  check(
    "A percentage above 100 is rejected",
    !generalSettingsSchema.safeParse({
      locale: "en",
      defaultShareType: "PERCENTAGE",
      shareValue: "150",
      defaultLateThreshold: "10",
      timezone: "Africa/Cairo",
    }).success,
  );
  check(
    "A negative base price is rejected",
    !educationSystemSchema.safeParse({
      locale: "en",
      name: "Bad",
      basePrice: "-5",
    }).success,
  );
  check(
    "A blank name is rejected",
    !roomSchema.safeParse({ locale: "en", name: "   " }).success,
  );
  check(
    "A non-JSON card layout is rejected",
    !cardLayoutSchema.safeParse({ locale: "en", cardLayout: "{nope" }).success,
  );
  check(
    "A JSON array card layout is rejected",
    !cardLayoutSchema.safeParse({ locale: "en", cardLayout: "[1,2]" }).success,
  );
  check(
    "An empty card layout clears the customization",
    cardLayoutSchema.safeParse({ locale: "en", cardLayout: "  " }).data
      ?.cardLayout === null,
  );
  check(
    "Teacher timeout off is stored as null, not 0",
    generalSettingsSchema.safeParse({
      locale: "en",
      defaultShareType: "FIXED",
      shareValue: "15",
      defaultLateThreshold: "10",
      timezone: "Africa/Cairo",
    }).data?.teacherTimeoutDays === null,
  );
  check(
    "Teacher edit-deadline off is stored as null, not 0 (M10)",
    generalSettingsSchema.safeParse({
      locale: "en",
      defaultShareType: "FIXED",
      shareValue: "15",
      defaultLateThreshold: "10",
      timezone: "Africa/Cairo",
    }).data?.teacherEditDeadlineHours === null,
  );
  check(
    "Teacher edit-deadline on, with a value, is stored as that many hours (M10)",
    generalSettingsSchema.safeParse({
      locale: "en",
      defaultShareType: "FIXED",
      shareValue: "15",
      defaultLateThreshold: "10",
      timezone: "Africa/Cairo",
      teacherEditDeadlineEnabled: "on",
      teacherEditDeadlineHours: "48",
    }).data?.teacherEditDeadlineHours === 48,
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
      console.error(`\n${failures} configuration check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll configuration checks passed.");
  });
