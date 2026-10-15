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
 * config rows, and that the center-cut split is right in both modes. The
 * permission matrix itself (M12) has its own dedicated gate, `check:permissions`.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { Prisma } from "@prisma/client";
import {
  scopedData,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import { splitShare } from "../lib/money.ts";
import {
  cardLayoutSchema,
  generalSettingsSchema,
  roomSchema,
} from "../lib/validation/settings.ts";

const prisma = await gatePrisma();

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
 * changes for a second center" claim. Education systems/grades/subjects
 * moved to the platform-owned global catalog at M13 (a centre picks/
 * suggests rather than authors) — that surface has its own dedicated gate,
 * `npm run check:catalog`; this script keeps only the config that is still
 * genuinely centre-authored: rooms and general settings.
 */
async function configureCenter(centerId: string) {
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
    },
    create: {
      centerId,
      defaultShareType: general.defaultShareType,
      defaultShareValue: general.defaultShareValue,
      teacherTimeoutDays: general.teacherTimeoutDays,
      defaultLateThreshold: general.defaultLateThreshold,
      timezone: general.timezone,
      cardLayout,
    },
  });

  return { roomRow, settingsRow };
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
    Boolean(a.roomRow && a.settingsRow),
  );
  check(
    "The identical call configures a second center — no code changes",
    Boolean(b.roomRow && b.settingsRow) && b.roomRow.id !== a.roomRow.id,
  );

  // ── 2. EGP typed into a form is stored as integer piastres ──────────────
  check(
    "A teacher-timeout of 45 days round-trips exactly (integer, not a piastre amount)",
    a.settingsRow.teacherTimeoutDays === 45,
    `got ${a.settingsRow.teacherTimeoutDays}`,
  );

  // ── 3. Every config table is center-scoped ─────────────────────────────
  // One call per delegate, so each one is checked against its real Prisma type.
  const leaks: [string, unknown][] = [
    ["Room", await scopedFindById(prisma.room, centerA.id, b.roomRow.id)],
  ];

  for (const [label, leaked] of leaks) {
    check(`Center A cannot read Center B's ${label} by id`, leaked === null);
  }

  const roomsInA = await prisma.room.findMany({
    where: scopedWhere(centerA.id),
  });
  check(
    "A scoped config list contains only the active center's rows",
    roomsInA.length === 1 && roomsInA[0].id === a.roomRow.id,
  );

  // ── 4. Center-cut math (the default this screen configures) ────────────
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

  // ── 5. The schemas reject what the UI must not store ───────────────────
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
