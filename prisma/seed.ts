/**
 * Demo seed (P1) — a realistic, wholly fictional world to sign into and click
 * through. Run with:  npm run db:seed
 *
 * Read `docs/dev-accounts.md` for every sign-in (all `@<SEED_EMAIL_DOMAIN>`,
 * default `example.com`; the password of each is `SEED_PASSWORD`). Run
 * `npm run seed:preflight` first - it finds Auth problems before the wipe.
 *
 * **How it writes.** Every record goes through the real data-layer function
 * that owns it — never a shortcut around a rule:
 *   - a centre's floor (settings + permission baseline + payment methods) is
 *     `provisionCenterBaseline`, the same function Super Admin provisioning
 *     calls (`createCenterWithSettings`). The previous seed built centres with
 *     a bare `center.upsert` and forgot the baseline, so its Owner saw only the
 *     Dashboard — P1's root cause (docs/03-build-order.md P1);
 *   - catalog rows: `createCatalogEntry` (platform-admin write, audited);
 *   - classes and their sessions: the R4 engine (`createClassWithSessions`);
 *     extra / one-time sessions: `createManualSession` / `createOneOffSession`;
 *   - teachers: `createTeacherMembership` (identity-matching, one User per person);
 *   - attendance / payments: `createAttendance` / `recordPayment` — money is
 *     frozen by `lib/money.ts` at the instant it is recorded. Past history is
 *     the scripts-only `historicalBackfill` option (those days have ended; the
 *     live path would refuse them), then closed by the real `closeSession`;
 *   - settlements, reservations, ratings, parent links: their own modules.
 * The only direct writes are rows with no writer in `lib/db` (rooms, holidays,
 * expenses, catalog selections, change requests) — written in the exact shape
 * the app's own actions write them.
 *
 * Auth users are created/updated through the Supabase admin API for the seed's
 * own fixed list only (`prisma/seed-data/auth.ts`) - and the very first thing
 * the seed does, before any database write, is the same Auth preflight
 * `npm run seed:preflight` runs, so a problem fails fast instead of half-seeding.
 *
 * **Idempotent and resumable.** Every phase finds what it would create and
 * skips it, and the long ones (the five-week history, today's live session,
 * settlements, expenses, reservations) make progress per item, so a run that
 * dies half-way (a dropped connection, Ctrl-C) is simply run again: finished
 * sessions are left alone, an interrupted one is picked up where it stopped.
 * Nothing is ever deleted to make a re-run work (money is append-only).
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  CenterPaymentMethod,
  ClassGroup,
  Center,
  Room,
  Role,
  User,
} from "@prisma/client";

import { createAttendance, changeAttendanceStatus } from "../lib/db/attendance.ts";
import {
  createClassWithSessions,
  createManualSession,
  createOneOffSession,
  deactivateClass,
  updateClassWithSessions,
} from "../lib/db/class-sessions.ts";
import { createPaymentMethod, listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { createTeacherMembership } from "../lib/db/teacher-membership.ts";
import { createPerson } from "../lib/db/identity.ts";
import { originateParentLinks } from "../lib/db/parents.ts";
import { transitionCenterLifecycle } from "../lib/db/platform.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { auditRowData, writeAuditRow } from "../lib/db/audit-row.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { confirmReservation, reserveOrEnroll, rejectReservation } from "../lib/db/reservations.ts";
import { submitSessionRating } from "../lib/db/ratings.ts";
import { linkRooms, writeSessionExtraRooms } from "../lib/db/room-sets.ts";
import {
  closeEndedSessions,
  closeSession,
  WRITE_TRANSACTION_OPTIONS,
} from "../lib/db/session-lifecycle.ts";
import { cancelSession, rescheduleSession } from "../lib/db/sessions.ts";
import {
  approveSettlement,
  cancelSettlement,
  createPeriodSettlement,
  paySettlement,
} from "../lib/db/settlements.ts";
import { claimStudentCode } from "../lib/db/students.ts";
import { createTerm } from "../lib/db/terms.ts";
import {
  DEFAULT_TIMEZONE,
  addDays,
  dateKey,
  todayInTimezone,
  zonedClock,
  zonedDateTimeToUtc,
} from "../lib/scheduling.ts";
import { cardLayoutDocumentSchema } from "../lib/validation/settings.ts";

import { SeedAuth, offlineAuth, projectRefOf, runAuthPreflight, type AuthPort } from "./seed-data/auth.ts";
import { productionTargetReason } from "./seed-data/production-refs.ts";
import { SEED_EMAIL_DOMAIN, mail } from "./seed-data/domain.ts";
import { ensureCatalog, type Catalog, type SystemKey } from "./seed-data/catalog.ts";
import { PhoneBook, dayOf, hashString, hhmm, makeRng, pool, toMinutes } from "./seed-data/helpers.ts";
import { generatePerson, parentFirstName } from "./seed-data/names.ts";
import {
  BRANCHES,
  DISCOVER_STUDENT,
  ORGANIZATIONS,
  PARENTS,
  PLATFORM_ADMIN,
  TEACHERS,
  ZERO_CENTRE_TEACHER,
  seedAccounts,
  type BranchDef,
  type BranchKey,
  type ClassDef,
  type PersonDef,
  type StaffDef,
  type StudentSpecial,
  type TermKey,
} from "./seed-data/plan.ts";

const prisma = new PrismaClient();
const phones = new PhoneBook();

const line = (text = "") => console.log(text);

// ── Guards ───────────────────────────────────────────────────────────────────

/** A database on this machine (a throwaway one for a dry run), never a Supabase project. */
function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Returns "local" for a throwaway local database (Supabase Auth is then skipped entirely). */
function guardEnvironment(): "dev" | "local" {
  // This seed signs in real-looking accounts with one shared password and
  // writes thousands of rows. It must only ever run against the dev project
  // - or a database on this machine, where it touches no Supabase Auth at all.
  if (isLocalDatabase()) return "local";
  // SEC-70: a committed production denylist and the production deployment's
  // own environment refuse first — no .env value can talk past them.
  const production = productionTargetReason();
  if (production) throw new Error(`Refusing to seed: ${production}.`);
  const devRef = process.env.DEV_PROJECT_REF?.trim();
  const ref = projectRefOf(process.env.DATABASE_URL);
  if (!devRef || !ref || ref !== devRef) {
    throw new Error(
      "Refusing to seed: DATABASE_URL's project ref does not equal DEV_PROJECT_REF (or one is unset). The demo seed only runs against the dev project.",
    );
  }
  return "dev";
}

// ── Terms, holidays, the clock ───────────────────────────────────────────────

type TermWindow = { name: string; startDate: Date; endDate: Date };

/**
 * The academic year the demo runs in: Term 1 late September → mid January,
 * Term 2 February → end of May, "Full year" spanning both. From June on the
 * year that is about to start; before it, the one in progress.
 */
function academicTerms(today: Date): Record<TermKey, TermWindow> {
  const startYear = today.getUTCMonth() >= 5 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  return {
    T1: { name: "Term 1", startDate: dayOf(startYear, 9, 26), endDate: dayOf(startYear + 1, 1, 14) },
    T2: { name: "Term 2", startDate: dayOf(startYear + 1, 2, 1), endDate: dayOf(startYear + 1, 5, 31) },
    FULL: { name: "Full year", startDate: dayOf(startYear, 9, 26), endDate: dayOf(startYear + 1, 5, 31) },
  };
}

/** Orthodox Easter (Gregorian date) — Meeus' Julian algorithm + 13 days (valid 1900–2099). */
function orthodoxEaster(year: number): Date {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addDays(dayOf(year, month, day), 13);
}

type HolidayDef = { date: Date; name: string };

/**
 * Egyptian public holidays inside [from, to]. Fixed-date ones are exact;
 * Sham El-Nessim follows Orthodox Easter (computed, exact). The Islamic
 * holidays follow the lunar calendar and are sighting-dependent, so each is
 * labelled "(approx.)" and only listed for the years whose dates are known to
 * within a day — otherwise they are simply left out.
 */
function holidaysBetween(from: Date, to: Date): HolidayDef[] {
  const years = new Set<number>();
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y += 1) years.add(y);

  const all: HolidayDef[] = [];
  for (const year of years) {
    all.push(
      { date: dayOf(year, 1, 7), name: "Coptic Christmas" },
      { date: dayOf(year, 1, 25), name: "Revolution Day (January 25)" },
      { date: dayOf(year, 4, 25), name: "Sinai Liberation Day" },
      { date: dayOf(year, 5, 1), name: "Labour Day" },
      { date: dayOf(year, 6, 30), name: "June 30 Revolution" },
      { date: dayOf(year, 7, 23), name: "July 23 Revolution" },
      { date: dayOf(year, 10, 6), name: "Armed Forces Day" },
      { date: addDays(orthodoxEaster(year), 1), name: "Sham El-Nessim" },
    );
  }
  // Islamic holidays, approximate (±1 day depending on the moon sighting).
  const islamic: HolidayDef[] = [
    ...[0, 1, 2].map((i) => ({ date: dayOf(2027, 3, 9 + i), name: "Eid al-Fitr (approx.)" })),
    ...[0, 1, 2, 3].map((i) => ({ date: dayOf(2027, 5, 16 + i), name: "Eid al-Adha (approx.)" })),
    { date: dayOf(2027, 6, 6), name: "Islamic New Year (approx.)" },
    { date: dayOf(2027, 8, 14), name: "Prophet's Birthday (approx.)" },
    ...[0, 1, 2].map((i) => ({ date: dayOf(2028, 2, 26 + i), name: "Eid al-Fitr (approx.)" })),
    ...[0, 1, 2, 3].map((i) => ({ date: dayOf(2028, 5, 5 + i), name: "Eid al-Adha (approx.)" })),
    { date: dayOf(2026, 8, 25), name: "Prophet's Birthday (approx.)" },
  ];
  all.push(...islamic);

  const seen = new Set<string>();
  return all
    .filter((holiday) => holiday.date >= from && holiday.date <= to)
    .filter((holiday) => {
      const key = dateKey(holiday.date);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => x.date.getTime() - y.date.getTime());
}

// ── People ───────────────────────────────────────────────────────────────────

let auth: AuthPort;

async function linkAuth(user: User, def: PersonDef, isPlatformAdmin = false): Promise<User> {
  // Only the seed's fixed account list ever touches Supabase Auth - a person
  // with a seed-domain address who is not on it is a plain app-side User.
  if (!def.email || !auth.has(def.email)) return user;
  const authId = await auth.ensure({
    email: def.email,
    firstName: def.first,
    lastName: def.last,
    locale: def.locale ?? "en",
    // D-21 (a): the platform admin signs in with SEED_ADMIN_PASSWORD.
    admin: isPlatformAdmin,
  });
  // Seed accounts are created confirmed (`email_confirm: true`), so the app
  // row carries the stamp too (SEC-2a: REQUIRE_EMAIL_CONFIRMATION reads it).
  return user.authId === authId && user.emailVerifiedAt
    ? user
    : prisma.user.update({
        where: { id: user.id },
        data: { authId, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
      });
}

/** A global `User` for this person — found by email/phone, else created (one User per person). */
async function ensurePerson(
  def: PersonDef,
  options: { phone?: boolean; isPlatformAdmin?: boolean } = {},
): Promise<User> {
  const phone = options.phone === false ? null : phones.forKey(def.key);
  let user =
    (def.email ? await prisma.user.findUnique({ where: { email: def.email.toLowerCase() } }) : null) ??
    (phone ? await prisma.user.findUnique({ where: { phone: phone.canonical } }) : null);
  if (!user) {
    user = await createPerson(
      {
        firstName: def.first,
        lastName: def.last,
        email: def.email ?? null,
        phone: phone?.raw ?? null,
        altPhone: null,
        locale: def.locale ?? "en",
      },
      prisma,
    );
  }
  if (options.isPlatformAdmin && !user.isPlatformAdmin) {
    user = await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
  }
  return linkAuth(user, def, options.isPlatformAdmin === true);
}

/** Through the app's own audit writer, so a seeded row obeys D-20 too. */
async function audit(
  centerId: string | null,
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  after?: Prisma.InputJsonValue,
) {
  await writeAuditRow(prisma, { centerId, actorUserId, action, entityType, entityId, after });
}

// ── One centre ───────────────────────────────────────────────────────────────

type ClassRow = {
  def: ClassDef;
  group: ClassGroup;
  roomId: string;
  extraRoomIds: string[];
};

type StudentRow = {
  key: string;
  userId: string;
  profileId: string;
  gradeId: string | null;
  email: string | null;
  login: boolean;
};

type Centre = {
  branch: BranchDef;
  center: Center;
  tz: string;
  ownerId: string | null;
  managerId: string | null;
  receptionistId: string | null;
  /** Whoever acts for the centre in actions that need a staff actor. */
  actorId: string;
  teacherIds: Record<string, string>;
  rooms: Room[];
  methods: CenterPaymentMethod[];
  classes: ClassRow[];
  students: StudentRow[];
};

const orgIds = new Map<string, string>();

async function ensureOrganization(orgKey: string): Promise<string> {
  const known = orgIds.get(orgKey);
  if (known) return known;
  const def = ORGANIZATIONS[orgKey];
  const existing = await prisma.organization.findFirst({ where: { name: def.name } });
  // F1: a re-run puts the demo limit back too (an organization the migration
  // backfilled to its branch count, or one an admin edited while testing).
  const org = existing
    ? existing.maxBranches === def.maxBranches
      ? existing
      : await prisma.organization.update({ where: { id: existing.id }, data: { maxBranches: def.maxBranches } })
    : await prisma.organization.create({ data: def });
  orgIds.set(orgKey, org.id);
  return org.id;
}

const NASR_CITY_CARD_LAYOUT = {
  version: 1,
  background: "#0f2a1d",
  headerBand: true,
  accent: "#166534",
  footer: "#f59e0b",
  elements: {
    logo: { x: 6, y: 8, width: 13 },
    centerName: {
      x: 28,
      y: 10,
      width: 66,
      fontSize: 15,
      weight: 700,
      color: "#fde68a",
      align: "start",
      family: "serif",
      text: "Center 60 · Nasr City",
    },
    photo: { x: 6, y: 36, width: 24 },
    studentName: {
      x: 36,
      y: 40,
      width: 36,
      fontSize: 16,
      weight: 700,
      color: "#ffffff",
      align: "center",
      family: "system",
    },
    grade: { x: 36, y: 56, width: 36, fontSize: 12, color: "#bbf7d0", align: "center" },
    studentCode: { x: 36, y: 68, fontSize: 12, weight: 600 },
    qr: { x: 74, y: 46, width: 20 },
  },
};

/**
 * Seed-only options a branch carries beyond the blueprint (`plan.ts`). R9: the
 * Nasr City branch gets a styled ID card (solid background, header band,
 * custom bottom line and branch text, per-text style); Downtown keeps the
 * default card on purpose so the old and new looks are both on screen.
 * `npm run check:card-layout` reads this literal and proves it valid.
 */
const BRANCH_EXTRAS: Partial<Record<BranchKey, { cardLayout?: unknown }>> = {
  nasrcity: { cardLayout: NASR_CITY_CARD_LAYOUT },
};

async function seedCentre(
  branch: BranchDef,
  catalog: Catalog,
  terms: Record<TermKey, TermWindow>,
  holidays: HolidayDef[],
): Promise<Centre> {
  line(`\n■ ${branch.name}  [${branch.lifecycle}]`);

  // The centre row — created once, never rewritten (its lifecycle is the
  // platform admin's to change).
  let center = await prisma.center.findUnique({ where: { slug: branch.slug } });
  if (!center) {
    center = await prisma.center.create({
      data: {
        slug: branch.slug,
        name: branch.name,
        nameEn: branch.name,
        themeColor: branch.themeColor,
        lifecycleState: branch.lifecycle === "SUSPENDED" ? "ACTIVE" : branch.lifecycle,
        organizationId: await ensureOrganization(branch.orgKey),
      },
    });
  }

  // THE floor every centre stands on — settings, the permission baseline and
  // the default payment methods — from the one function that owns it.
  const report = await prisma.$transaction((tx) => provisionCenterBaseline(tx, center!.id), WRITE_TRANSACTION_OPTIONS);
  line(
    `  baseline: settings ${report.settingsCreated ? "created" : "present"}, +${report.grantsCreated} grant row(s), +${report.paymentMethodsCreated} payment method(s)`,
  );

  if (branch.lifecycle === "SUSPENDED" && center.lifecycleState !== "SUSPENDED") {
    const moved = await transitionCenterLifecycle(prisma, center.id, "SUSPENDED");
    if (!moved.ok) throw new Error(`Could not suspend ${branch.name}: ${moved.error}`);
    center = moved.center;
  }

  // Per-branch configuration on top of the baseline.
  await prisma.centerSettings.update({
    where: { centerId: center.id },
    data: { dataVisibilityDays: branch.dataVisibilityDays },
  });
  const extras = BRANCH_EXTRAS[branch.key];
  if (extras?.cardLayout !== undefined) {
    const settings = await prisma.centerSettings.findUniqueOrThrow({ where: { centerId: center.id } });
    // Only while the branch has no layout of its own, and only if it passes the real schema.
    if (settings.cardLayout === null) {
      const layout = cardLayoutDocumentSchema.parse(extras.cardLayout);
      await prisma.centerSettings.update({
        where: { centerId: center.id },
        data: { cardLayout: layout as Prisma.InputJsonValue },
      });
      line("  styled ID card layout");
    }
  }
  if (branch.customMethod) {
    const made = await createPaymentMethod(prisma, center.id, branch.customMethod);
    if (made.ok) line(`  + payment method: ${branch.customMethod}`);
  }
  const methods = await listActivePaymentMethods(prisma, center.id);

  // Staff.
  const staffIds: Record<string, string> = {};
  for (const staff of branch.staff) {
    const user = await ensurePerson(staff);
    staffIds[staff.key] = user.id;
    const local = {
      firstName: staff.first,
      lastName: staff.last,
      email: staff.email ?? null,
      phone: phones.forKey(staff.key).canonical,
    };
    const existing = await prisma.membership.findUnique({
      where: { userId_centerId_role: { userId: user.id, centerId: center.id, role: staff.role as Role } },
    });
    if (!existing) {
      const membership = await prisma.membership.create({
        data: { userId: user.id, centerId: center.id, role: staff.role as Role, joinedAt: new Date(), ...local },
      });
      await audit(center.id, user.id, "membership.create", "Membership", membership.id, { role: staff.role, via: "seed" });
    }
  }
  const byRole = (role: StaffDef["role"]) => {
    const found = branch.staff.find((staff) => staff.role === role);
    return found ? staffIds[found.key] : null;
  };
  // Center 60's one Owner lives on Downtown (the org-level widening reaches Nasr City).
  const ownerId =
    byRole("OWNER") ?? (branch.orgKey === "center60" ? await orgOwnerId() : null);
  const managerId = byRole("MANAGER");
  const receptionistId = byRole("RECEPTIONIST");
  const actorId = managerId ?? ownerId ?? receptionistId ?? Object.values(staffIds)[0];

  // Nothing more to build for a centre that is only a sign-in test bed.
  if (branch.rooms.length === 0) {
    return {
      branch, center, tz: DEFAULT_TIMEZONE, ownerId, managerId, receptionistId, actorId,
      teacherIds: {}, rooms: [], methods, classes: [], students: [],
    };
  }

  // Teachers — the identity-aware path: a person who already exists (the
  // shared and cross-organization teachers) gets a second Membership, never
  // a second User.
  const teacherIds: Record<string, string> = {};
  for (const key of branch.teachers) {
    teacherIds[key] = await addTeacher(center.id, TEACHERS[key], actorId);
  }
  line(`  teachers: ${branch.teachers.length}`);

  // Rooms, joinable pairs.
  const rooms: Room[] = [];
  for (const def of branch.rooms) {
    const existing = await prisma.room.findFirst({ where: { centerId: center.id, name: def.name } });
    rooms.push(existing ?? (await prisma.room.create({ data: { centerId: center.id, ...def } })));
  }
  for (const [a, b] of branch.roomLinks) await linkRooms(prisma, center.id, rooms[a].id, rooms[b].id);
  line(`  rooms: ${rooms.length} (${branch.roomLinks.length} joinable pair${branch.roomLinks.length === 1 ? "" : "s"})`);

  // Terms and holidays.
  for (const key of ["T1", "T2", "FULL"] as const) await createTerm(prisma, center.id, terms[key]);
  await prisma.holiday.createMany({
    data: holidays.map((holiday) => ({ centerId: center!.id, date: holiday.date, name: holiday.name })),
    skipDuplicates: true,
  });

  // The centre's picks from the global catalog — every grade and subject of
  // its education systems, a few renamed for the centre itself.
  await pickCatalog(center.id, branch, catalog);

  return {
    branch, center, tz: DEFAULT_TIMEZONE, ownerId, managerId, receptionistId, actorId,
    teacherIds, rooms, methods, classes: [], students: [],
  };
}

let cachedOwnerId: string | null = null;
async function orgOwnerId(): Promise<string> {
  if (cachedOwnerId) return cachedOwnerId;
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: mail("owner.center60") } });
  cachedOwnerId = owner.id;
  return owner.id;
}

async function addTeacher(centerId: string, def: PersonDef, actorUserId: string): Promise<string> {
  const phone = phones.forKey(def.key);
  const input = {
    firstName: def.first,
    lastName: def.last,
    email: def.email ?? null,
    phone: phone.raw,
    altPhone: null,
    locale: def.locale ?? "en",
  };
  const options = { actorUserId, linkUserId: null as string | null, via: "teacher.add" as const, refusePrivileged: false };
  let result = await createTeacherMembership(prisma, centerId, input, options);
  if (!result.ok && result.error === "matchFound" && result.match) {
    result = await createTeacherMembership(prisma, centerId, input, { ...options, linkUserId: result.match.userId });
  }
  let userId: string;
  if (result.ok) userId = result.userId;
  else if (result.error === "alreadyTeacher" && result.match) userId = result.match.userId;
  else throw new Error(`Teacher ${def.first} ${def.last}: ${result.error}`);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await linkAuth(user, def);
  return userId;
}

async function pickCatalog(centerId: string, branch: BranchDef, catalog: Catalog) {
  const systems = new Set(branch.systems);
  const rows: Prisma.CenterCatalogSelectionCreateManyInput[] = [];
  const basePrice: Record<SystemKey, number> = { EG: 12_000, US: 20_000, IG: 24_000 };
  for (const key of branch.systems) {
    rows.push({ centerId, kind: "EDUCATION_SYSTEM", educationSystemId: catalog.systemIds[key], basePrice: basePrice[key] });
  }
  for (const grade of catalog.grades) {
    if (systems.has(catalog.systemOfGrade(grade.id))) rows.push({ centerId, kind: "GRADE", gradeId: grade.id });
  }
  for (const subject of catalog.subjects) {
    if (subject.gradeId && systems.has(catalog.systemOfGrade(subject.gradeId))) {
      rows.push({ centerId, kind: "SUBJECT", subjectId: subject.id });
    }
  }
  await prisma.centerCatalogSelection.createMany({ data: rows, skipDuplicates: true });
  for (const rename of branch.renames ?? []) {
    const subject = catalog.subject(rename.system, rename.grade, rename.subject);
    await prisma.centerCatalogSelection.updateMany({
      where: { centerId, kind: "SUBJECT", subjectId: subject.id },
      data: { displayNameAr: rename.ar ?? null, displayNameEn: rename.en ?? null },
    });
  }
  line(`  catalog picks: ${rows.length} (${branch.systems.join(", ")})`);
}

// ── Students ─────────────────────────────────────────────────────────────────

type StudentSpec = {
  key: string;
  first: string;
  last: string;
  email: string;
  login: boolean;
  gradeId: string;
  parentFirst: string;
  parentLast: string;
  parentPhoneKey: string;
  hasPhone: boolean;
  locale: "ar" | "en";
};

function planStudents(branch: BranchDef, catalog: Catalog): StudentSpec[] {
  const rng = makeRng(hashString(`students:${branch.slug}`));
  const taken = new Set<string>();
  // Names already used by the fixed people are not reused for generated ones.
  for (const special of branch.specials) taken.add(`${special.first} ${special.last}`);
  const tag = branch.key === "downtown" ? "d" : branch.key === "nasrcity" ? "n" : "k";
  const specs: StudentSpec[] = [];

  const parentOf = (special: StudentSpecial) =>
    special.parent === "family" ? PARENTS.family : special.parent === "nokhba" ? PARENTS.nokhba : null;

  for (const special of branch.specials) {
    const parent = parentOf(special);
    const fallbackParent = parentFirstName(rng, false);
    specs.push({
      key: special.key,
      first: special.first,
      last: special.last,
      email: special.email ?? `${special.first}.${special.last}.${tag}00@${SEED_EMAIL_DOMAIN}`.toLowerCase(),
      login: Boolean(special.email),
      gradeId: catalog.grade(special.system, special.grade).id,
      parentFirst: parent?.first ?? fallbackParent.name,
      parentLast: parent?.last ?? special.last,
      parentPhoneKey: parent?.key ?? `${special.key}:parent`,
      hasPhone: true,
      locale: special.locale ?? "en",
    });
  }

  // Generated students fill each grade's quota (specials count toward it).
  const have = new Map<string, number>();
  for (const special of branch.specials) {
    const k = `${special.system}:${special.grade}`;
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  let index = 1;
  for (const slice of branch.mix) {
    const need = slice.count - (have.get(`${slice.system}:${slice.grade}`) ?? 0);
    for (let n = 0; n < need; n += 1) {
      // Every tenth student is written in Arabic script (~10%).
      const person = generatePerson(rng, taken, { arabic: index % 10 === 4 });
      const parent = parentFirstName(rng, person.arabicScript, person.firstName);
      const nn = String(index).padStart(2, "0");
      const key = `${branch.key}:student:${nn}`;
      specs.push({
        key,
        first: person.firstName,
        last: person.lastName,
        email: `${person.slug}.${tag}${nn}@${SEED_EMAIL_DOMAIN}`,
        login: false,
        gradeId: catalog.grade(slice.system, slice.grade).id,
        parentFirst: parent.name,
        parentLast: person.lastName,
        parentPhoneKey: `${key}:parent`,
        // Older students carry their own number; younger ones do not.
        hasPhone: slice.grade.startsWith("Secondary") || slice.grade.startsWith("Grade") || slice.grade.startsWith("Year"),
        locale: person.arabicScript ? "ar" : "en",
      });
      index += 1;
    }
  }
  return specs;
}

async function ensureStudents(ctx: Centre, catalog: Catalog): Promise<void> {
  const specs = planStudents(ctx.branch, catalog);
  const centerId = ctx.center.id;
  const rows: StudentRow[] = [];

  await pool(specs, 1, async (spec, position) => {
    const parentPhone = phones.forKey(spec.parentPhoneKey);
    const phone = spec.hasPhone ? phones.forKey(spec.key) : null;

    const existingUser = await prisma.user.findUnique({ where: { email: spec.email.toLowerCase() } });
    if (existingUser) {
      const profile = await prisma.studentProfile.findFirst({ where: { userId: existingUser.id, centerId } });
      if (profile) {
        rows[position] = { key: spec.key, userId: existingUser.id, profileId: profile.id, gradeId: profile.gradeId, email: spec.email, login: spec.login };
        return;
      }
    }
    const created = await prisma.$transaction(async (tx) => {
      const user =
        existingUser ??
        (await createPerson(
          {
            firstName: spec.first,
            lastName: spec.last,
            email: spec.email,
            phone: phone?.raw ?? null,
            altPhone: null,
            locale: spec.locale,
          },
          tx,
        ));
      const code = await claimStudentCode(tx, centerId);
      const profile = await tx.studentProfile.create({
        data: {
          userId: user.id,
          centerId,
          studentCode: code,
          gradeId: spec.gradeId,
          firstName: spec.first,
          lastName: spec.last,
          email: spec.email.toLowerCase(),
          phone: phone?.canonical ?? null,
          parentFirstName: spec.parentFirst,
          parentLastName: spec.parentLast,
          parentPhone: parentPhone.canonical,
          // A receptionist-entered profile is already whole (M18).
          profileCompletedAt: new Date(),
        },
      });
      return { user, profile };
    }, WRITE_TRANSACTION_OPTIONS);
    await audit(centerId, ctx.actorId, "student.create", "StudentProfile", created.profile.id, {
      userId: created.user.id,
      studentCode: created.profile.studentCode,
      via: "seed",
    });
    rows[position] = { key: spec.key, userId: created.user.id, profileId: created.profile.id, gradeId: spec.gradeId, email: spec.email, login: spec.login };
  });

  // Sign-in accounts for the students that have one.
  for (const spec of specs.filter((s) => s.login)) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: spec.email.toLowerCase() } });
    await linkAuth(user, { key: spec.key, first: spec.first, last: spec.last, email: spec.email, locale: spec.locale });
  }
  ctx.students = rows.filter(Boolean);
  line(`  students: ${ctx.students.length}`);
}

// ── Classes and enrolments ───────────────────────────────────────────────────

async function ensureClasses(ctx: Centre, catalog: Catalog, terms: Record<TermKey, TermWindow>, today: Date, historyStart: Date) {
  const centerId = ctx.center.id;
  for (const def of ctx.branch.classes) {
    const subject = catalog.subject(def.system, def.grade, def.subject);
    const term = terms[def.term];
    // A class's period is COPIED from its term preset (R4). A class that ran
    // before the term preset's start (it is already five weeks into its run)
    // starts on its first history day instead — typed dates, as the class form allows.
    const startDate = def.term === "T2" || term.startDate <= historyStart ? term.startDate : historyStart;
    const teacherId = ctx.teacherIds[def.teacher];
    const roomId = ctx.rooms[def.room].id;
    const extraRoomIds = (def.extraRooms ?? []).map((index) => ctx.rooms[index].id);
    const input = {
      teacherId,
      subjectId: subject.id,
      gradeId: subject.gradeId,
      educationSystemId: catalog.systemIds[def.system],
      roomId,
      extraRoomIds,
      price: def.price,
      centerShareType: def.share.type,
      centerShareValue: def.share.value,
      lateThresholdMinutes: 10,
      acceptsNewStudents: def.acceptsNewStudents ?? true,
      requiresConfirmation: def.requiresConfirmation ?? false,
      startDate,
      endDate: term.endDate,
    };
    const options = { confirmConflicts: true, actorUserId: ctx.actorId, now: new Date() };
    const existing = await prisma.classGroup.findFirst({ where: { centerId, subjectId: subject.id, teacherId } });
    let group: ClassGroup;
    if (existing) {
      // A class deactivated by an earlier run keeps its history and stays off.
      if (existing.active) {
        const updated = await updateClassWithSessions(prisma, centerId, existing.id, input, options);
        if (!updated.ok) throw new Error(`Class ${def.key}: ${updated.error}`);
      }
      group = existing;
    } else {
      const created = await createClassWithSessions(
        prisma,
        centerId,
        { ...input, slots: [{ dayOfWeek: def.day, startTime: def.start, endTime: def.end }] },
        options,
      );
      if (!created.ok) throw new Error(`Class ${def.key}: ${created.error}`);
      group = await prisma.classGroup.findUniqueOrThrow({ where: { id: created.classGroupId } });
    }
    ctx.classes.push({ def, group, roomId, extraRoomIds });
  }
  line(`  classes: ${ctx.classes.length}`);

  // Enrolments: every student joins each class of their own grade. Backdated
  // to when the class began so a closed session counts them as enrolled.
  const enrolledAt = addDays(today, -60);
  let enrolled = 0;
  for (const row of ctx.classes) {
    const roster = ctx.students.filter((student) => student.gradeId === row.group.gradeId);
    const result = await prisma.enrollment.createMany({
      data: roster.map((student) => ({
        centerId,
        studentProfileId: student.profileId,
        classGroupId: row.group.id,
        status: "ACTIVE" as const,
        enrolledAt,
      })),
      skipDuplicates: true,
    });
    enrolled += result.count;
  }
  line(`  enrolments: ${enrolled} new`);
}

// ── History: the last five weeks, closed ─────────────────────────────────────

function pickMethod(methods: CenterPaymentMethod[], roll: number): CenterPaymentMethod {
  // Cash most of the time, then InstaPay, Vodafone Cash, and the centre's custom one.
  const named = (name: string) => methods.find((method) => method.name === name);
  const custom = methods.find((method) => !["Cash", "InstaPay", "Vodafone Cash"].includes(method.name));
  if (roll < 0.5) return named("Cash") ?? methods[0];
  if (roll < 0.78) return named("InstaPay") ?? methods[0];
  if (roll < 0.95) return named("Vodafone Cash") ?? methods[0];
  return custom ?? named("Cash") ?? methods[0];
}

async function seedHistory(ctx: Centre, today: Date, historyStart: Date, holidays: Set<string>) {
  const { center, tz } = ctx;
  const centerId = center.id;
  const receptionist = ctx.receptionistId ?? ctx.actorId;

  let sessions = 0;
  let attendance = 0;
  let paymentsMade = 0;
  let switched = 0;
  let cancelled = 0;
  let skipped = 0;
  const autoClosePick = ctx.classes.length > 2 ? 2 : 0;

  for (const [classIndex, row] of ctx.classes.entries()) {
    if (row.def.term === "T2") continue; // next term's intake: no history
    const slot = row.def;
    const roster = await prisma.enrollment.findMany({
      where: { centerId, classGroupId: row.group.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });

    const dates: Date[] = [];
    for (let day = historyStart; day < today; day = addDays(day, 1)) {
      if (day.getUTCDay() !== slot.day) continue;
      if (day < row.group.startDate) continue;
      if (holidays.has(dateKey(day))) continue;
      dates.push(day);
    }

    for (const [dateIndex, date] of dates.entries()) {
      const dayKey = dateKey(date);
      const startAt = zonedDateTimeToUtc(dayKey, toMinutes(slot.start), tz);
      const isCancelledPick = classIndex === 3 && dateIndex === 1;
      const isAutoClosePick = classIndex === autoClosePick && dateIndex === 1;

      // RESUMABLE: a session is the unit of progress. One that is already
      // closed or cancelled is finished and left alone; one that exists but is
      // not finished (the run was interrupted inside it) is picked up where it
      // stopped - existing roster rows are kept, missing ones and their
      // payments are added. Nothing is ever deleted (money is append-only).
      let session = await prisma.session.findFirst({
        where: { centerId, classGroupId: row.group.id, date, startTime: slot.start },
      });
      if (session && (session.closedAt || session.status === "CANCELLED")) {
        skipped += 1;
        continue;
      }
      if (!session) {
        session = await prisma.session.create({
          data: {
            centerId,
            classGroupId: row.group.id,
            teacherId: row.group.teacherId,
            roomId: row.roomId,
            date,
            startTime: slot.start,
            endTime: slot.end,
            priceSnapshot: row.group.price,
          },
        });
        await writeSessionExtraRooms(prisma, centerId, session.id, row.extraRoomIds);
        sessions += 1;
      }
      const sessionId = session.id;

      // One session a branch never happened: cancelled before it began.
      if (isCancelledPick) {
        const result = await cancelSession(prisma, centerId, sessionId, {
          now: new Date(startAt.getTime() - 3 * 3_600_000),
        });
        if (!result.ok) throw new Error(`Cancel ${sessionId}: ${result.error}`);
        await audit(centerId, ctx.actorId, "session.cancel", "Session", sessionId, { status: "CANCELLED", via: "seed" });
        cancelled += 1;
        continue;
      }

      const rng = makeRng(hashString(`${row.group.id}:${dayKey}`));
      const checkInAt = new Date(startAt.getTime() + 5 * 60_000);
      const paymentAudit: Prisma.AuditLogCreateManyInput[] = [];

      // Every roll is drawn up front, in roster order, so a run is reproducible
      // however the check-ins below interleave.
      const rolls = roster.map(() => ({ attend: rng.next(), method: rng.next(), mistake: rng.next() }));
      await pool(roster, 5, async (enrollment, position) => {
        const { attend: roll, method: methodRoll, mistake } = rolls[position];
        // ~10% never come (the close writes their ABSENT), ~10% are late, the rest on time.
        if (roll < 0.1) return;
        const status = roll < 0.2 ? "LATE" : "PRESENT";

        let attendee = await prisma.sessionAttendee.findFirst({
          where: { centerId, sessionId, studentProfileId: enrollment.studentProfileId },
        });
        if (!attendee) {
          attendee = await createAttendance(
            prisma,
            { centerId, sessionId, studentProfileId: enrollment.studentProfileId, enrollmentId: enrollment.id, isDropIn: false, recordedBy: receptionist },
            { historicalBackfill: true, status },
          );
          attendance += 1;
        }
        // Already switched to Absent (its payment voided) or already paid: done.
        if (attendee.attendanceStatus === "ABSENT") return;
        if ((await prisma.payment.count({ where: { centerId, sessionAttendeeId: attendee.id } })) > 0) return;

        const method = pickMethod(ctx.methods, methodRoll);
        const attendeeId = attendee.id;
        const paid = await prisma.$transaction(
          (tx) => recordPayment(tx, centerId, attendeeId, method.id, receptionist, { historicalBackfill: true }),
          WRITE_TRANSACTION_OPTIONS,
        );
        if (!paid.ok) throw new Error(`Payment for ${attendeeId}: ${paid.error}`);
        paymentsMade += 1;
        paymentAudit.push(
          auditRowData({
            centerId,
            actorUserId: receptionist,
            action: "payment.record",
            entityType: "Payment",
            entityId: paid.payment.id,
            after: {
              amount: paid.payment.amount,
              sessionId: paid.payment.sessionId,
              paymentMethodId: paid.payment.paymentMethodId,
              centerShareSnapshot: paid.payment.centerShareSnapshot,
              teacherShareSnapshot: paid.payment.teacherShareSnapshot,
            },
          }),
        );

        // A few were marked in by mistake and switched to Absent while the
        // session was live: the payment voids with the change, a change-log row.
        if (mistake < 0.012) {
          const changed = await changeAttendanceStatus(
            prisma,
            {
              centerId,
              attendeeId,
              status: "ABSENT",
              changedBy: receptionist,
              reason: "Checked in by mistake — did not attend",
              mayVoidPayment: true,
            },
            { historicalBackfill: true, now: new Date(startAt.getTime() + 25 * 60_000) },
          );
          if (!changed.ok) throw new Error(`Switch to absent ${attendeeId}: ${changed.error}`);
          switched += 1;
        }
      });
      if (paymentAudit.length > 0) await prisma.auditLog.createMany({ data: paymentAudit });

      // Receipts read as the day they ran: backdate the clock stamps (never an
      // amount or a snapshot) to the session's own check-in time.
      await prisma.sessionAttendee.updateMany({ where: { sessionId, attendanceStatus: { not: "ABSENT" } }, data: { recordedAt: checkInAt } });
      await prisma.payment.updateMany({ where: { sessionId }, data: { recordedAt: checkInAt } });

      // Close it — by hand, at the end of its slot — except one session a
      // branch, left for the end-of-day sweep below (an automatic close).
      if (isAutoClosePick) continue;
      const closed = await closeSession(prisma, centerId, sessionId, {
        closedBy: receptionist,
        now: zonedDateTimeToUtc(dayKey, toMinutes(slot.end) + 5, tz),
      });
      if (!closed.ok) throw new Error(`Close ${sessionId}: ${closed.error}`);
      await audit(centerId, receptionist, "session.close", "Session", sessionId, {
        status: closed.session.status,
        closeMode: closed.session.closeMode,
        closedAt: closed.session.closedAt?.toISOString() ?? null,
        absentCreated: closed.absentCreated,
      });
    }
  }

  const auto = await closeEndedSessions(prisma, centerId);
  line(
    `  history: ${sessions} sessions (${cancelled} cancelled, ${auto} auto-closed), ${attendance} check-ins, ${paymentsMade} payments, ${switched} live absent-switch void(s)${skipped > 0 ? `; ${skipped} already finished` : ""}`,
  );
}

// ── Today, upcoming, and the one-offs ────────────────────────────────────────

/** Friday is the weekend: a hand-made session is moved on to Saturday. */
function skipFriday(date: Date): Date {
  return date.getUTCDay() === 5 ? addDays(date, 1) : date;
}

async function seedToday(ctx: Centre, today: Date) {
  const { center, tz } = ctx;
  const centerId = center.id;
  const receptionist = ctx.receptionistId;
  if (!receptionist || ctx.classes.length === 0) return;

  const clock = zonedClock(new Date(), tz);
  const rng = makeRng(hashString(`today:${centerId}`));

  // A session that started earlier today and is still open (not ended), so
  // reception has a live roster with some students in and some still to come.
  const liveCandidate = ctx.classes.find(
    (row) => row.group.active && row.def.day !== today.getUTCDay() && row.def.term !== "T2" && !row.def.deactivate,
  );
  const existingLive = liveCandidate
    ? await prisma.session.findFirst({
        where: { centerId, classGroupId: liveCandidate.group.id, date: today, isManual: true },
      })
    : null;
  if (liveCandidate && (existingLive || clock.minutes >= 20)) {
    // RESUMABLE: if a previous (interrupted) run already made today's live
    // session, keep it and top up its check-ins; otherwise create it.
    let sessionId: string;
    let start: number;
    let end: number;
    if (existingLive) {
      sessionId = existingLive.id;
      start = toMinutes(existingLive.startTime);
      end = toMinutes(existingLive.endTime);
    } else {
      start = Math.max(0, Math.floor((clock.minutes - 50) / 5) * 5);
      end = Math.min(23 * 60 + 55, start + 90);
      const created = await createManualSession(
        prisma,
        centerId,
        {
          classGroupId: liveCandidate.group.id,
          teacherId: liveCandidate.group.teacherId,
          roomId: liveCandidate.roomId,
          extraRoomIds: liveCandidate.extraRoomIds,
          date: today,
          startTime: hhmm(start),
          endTime: hhmm(end),
        },
        { confirmConflicts: true, actorUserId: ctx.actorId },
      );
      if (!created.ok) throw new Error(`Live session: ${created.error}`);
      sessionId = created.sessionId;
    }

    const roster = await prisma.enrollment.findMany({
      where: { centerId, classGroupId: liveCandidate.group.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
    // Every roll is drawn up front, so the same roster gets the same day.
    const rolls = roster.map(() => ({ late: rng.next(), offset: rng.int(16), pay: rng.next(), method: rng.next() }));
    let checkedIn = 0;
    let paid = 0;
    for (const [index, enrollment] of roster.entries()) {
      const roll = rolls[index];
      if (roll.late < 0.35) continue; // not here yet
      let attendee = await prisma.sessionAttendee.findFirst({
        where: { centerId, sessionId, studentProfileId: enrollment.studentProfileId },
      });
      if (!attendee) {
        attendee = await createAttendance(
          prisma,
          { centerId, sessionId, studentProfileId: enrollment.studentProfileId, enrollmentId: enrollment.id, isDropIn: false, recordedBy: receptionist },
          { now: zonedDateTimeToUtc(dateKey(today), start + roll.offset, tz) }, // 0-15 minutes after the start
        );
      }
      checkedIn += 1;
      const attendeeId = attendee.id;
      if (roll.pay < 0.7 && (await prisma.payment.count({ where: { centerId, sessionAttendeeId: attendeeId } })) === 0) {
        const method = pickMethod(ctx.methods, roll.method);
        const result = await prisma.$transaction(
          (tx) => recordPayment(tx, centerId, attendeeId, method.id, receptionist),
          WRITE_TRANSACTION_OPTIONS,
        );
        if (result.ok) {
          paid += 1;
          await audit(centerId, receptionist, "payment.record", "Payment", result.payment.id, {
            amount: result.payment.amount,
            sessionId: result.payment.sessionId,
            paymentMethodId: result.payment.paymentMethodId,
          });
        }
      }
    }
    line(`  today: live session ${hhmm(start)}–${hhmm(end)} on ${liveCandidate.def.key}: ${checkedIn}/${roster.length} checked in, ${paid} paid this run`);
  } else {
    line("  today: too early in the day for a live session — skipped");
  }

  // One more session later today, still to come.
  const later = ctx.classes.find((row) => row.group.active && row !== liveCandidate && row.def.term !== "T2" && !row.def.deactivate && row.def.day !== today.getUTCDay());
  const laterStart = Math.ceil((clock.minutes + 90) / 15) * 15;
  const laterExists = later
    ? (await prisma.session.count({ where: { centerId, classGroupId: later.group.id, date: today, isManual: true } })) > 0
    : false;
  if (later && !laterExists && laterStart <= 21 * 60 + 30) {
    const result = await createManualSession(
      prisma,
      centerId,
      {
        classGroupId: later.group.id,
        teacherId: later.group.teacherId,
        roomId: later.roomId,
        extraRoomIds: later.extraRoomIds,
        date: today,
        startTime: hhmm(laterStart),
        endTime: hhmm(laterStart + 90),
      },
      { confirmConflicts: true, actorUserId: ctx.actorId },
    );
    if (result.ok) line(`  today: upcoming extra session at ${hhmm(laterStart)}`);
  }
}

async function seedSpecialSessions(ctx: Centre, catalog: Catalog, today: Date) {
  const centerId = ctx.center.id;
  if (ctx.branch.key !== "downtown") return;

  // A one-time session tomorrow (no class) and an extra session on a class.
  const title = "Exam revision day";
  const oneOffDay = skipFriday(addDays(today, 1));
  if ((await prisma.session.count({ where: { centerId, classGroupId: null, title } })) === 0) {
    const subject = catalog.subject("EG", "Secondary 3", "Physics");
    const created = await createOneOffSession(
      prisma,
      centerId,
      {
        title,
        subjectId: subject.id,
        gradeId: subject.gradeId,
        teacherId: ctx.teacherIds.yasser,
        roomId: ctx.rooms[3].id,
        extraRoomIds: [ctx.rooms[4].id],
        date: oneOffDay,
        startTime: "19:00",
        endTime: "21:00",
        price: 15_000,
        centerShareType: "PERCENTAGE",
        centerShareValue: 15,
      },
      { confirmConflicts: true, actorUserId: ctx.actorId },
    );
    if (!created.ok) throw new Error(`One-time session: ${created.error}`);
    line(`  one-time session "${title}" on ${dateKey(oneOffDay)}`);
  }
  const target = ctx.classes.find((row) => row.def.key === "dt-math-s2");
  const extraDay = skipFriday(addDays(today, 3));
  if (target && (await prisma.session.count({ where: { centerId, classGroupId: target.group.id, isManual: true, date: { gt: today } } })) === 0) {
    const created = await createManualSession(
      prisma,
      centerId,
      {
        classGroupId: target.group.id,
        teacherId: target.group.teacherId,
        roomId: target.roomId,
        extraRoomIds: target.extraRoomIds,
        date: extraDay,
        startTime: "10:00",
        endTime: "12:00",
      },
      { confirmConflicts: true, actorUserId: ctx.actorId },
    );
    if (!created.ok) throw new Error(`Extra session: ${created.error}`);
    line(`  extra session on ${target.def.key}: ${dateKey(extraDay)} 10:00–12:00`);
  }

  // One upcoming session moved to another day (the original keeps a link to it).
  const movable = ctx.classes.find((row) => row.def.key === "dt-english-p6");
  if (movable) {
    const upcoming = await prisma.session.findFirst({
      where: { centerId, classGroupId: movable.group.id, date: { gt: addDays(today, 6) }, rescheduledToId: null, status: "SCHEDULED" },
      orderBy: { date: "asc" },
    });
    const already = await prisma.session.count({ where: { centerId, classGroupId: movable.group.id, rescheduledToId: { not: null } } });
    if (upcoming && already === 0) {
      const moved = await rescheduleSession(
        prisma,
        centerId,
        upcoming.id,
        { date: addDays(upcoming.date, -1), startTime: "16:00", endTime: "17:30" },
        "WARN",
        "en",
        { confirmConflicts: true, actorUserId: ctx.actorId },
      );
      if (!moved.ok) throw new Error(`Reschedule: ${moved.error}`);
      line(`  rescheduled ${dateKey(upcoming.date)} → ${dateKey(moved.session.date)}`);
    }
  }
}

// ── Money and workflow ───────────────────────────────────────────────────────

async function seedSettlements(ctx: Centre, today: Date, historyStart: Date) {
  const centerId = ctx.center.id;
  if (ctx.branch.key === "nokhba") return;
  const plan: Record<string, [string, "PAID" | "APPROVED" | "DRAFT"][]> = {
    downtown: [["yasser", "PAID"], ["mona", "APPROVED"], ["karim", "DRAFT"]],
    nasrcity: [["mahmoud", "PAID"], ["salma", "APPROVED"], ["omar", "DRAFT"]],
  };
  const actor = ctx.actorId;
  // D-12: the manager drafts; someone else (the owner) approves and pays.
  const approver = { userId: ctx.ownerId ?? actor, isOwner: ctx.ownerId !== null };
  const to = addDays(today, -8);
  for (const [teacherKey, wanted] of plan[ctx.branch.key] ?? []) {
    const teacherId = ctx.teacherIds[teacherKey];
    // D-16: the DRAFT teacher first got a mistyped one-week draft, cancelled
    // (its claims released) before the real one was made.
    if (wanted === "DRAFT" && (await prisma.settlement.count({ where: { centerId, teacherId, status: "CANCELLED" } })) === 0) {
      const mistake = await prisma.$transaction(
        (tx) => createPeriodSettlement(tx, centerId, teacherId, historyStart, addDays(historyStart, 6), actor),
        WRITE_TRANSACTION_OPTIONS,
      );
      if (mistake.ok) {
        await audit(centerId, actor, "settlement.create", "Settlement", mistake.settlement.id, {
          teacherId, totalAmount: mistake.settlement.totalAmount, claimedPayments: mistake.claimedPayments,
        });
        const cancelled = await cancelSettlement(prisma, centerId, mistake.settlement.id, { userId: actor });
        if (!cancelled.ok) throw new Error(`Cancel draft ${teacherKey}: ${cancelled.error}`);
        await audit(centerId, actor, "settlement.cancel", "Settlement", mistake.settlement.id, {
          status: "CANCELLED", releasedClaims: cancelled.releasedClaims,
        });
      }
    }
    // RESUMABLE: one live settlement per teacher; an existing one is advanced
    // only as far as this run wants it, never re-created.
    let settlement = await prisma.settlement.findFirst({ where: { centerId, teacherId, status: { not: "CANCELLED" } } });
    if (!settlement) {
      const created = await prisma.$transaction(
        (tx) => createPeriodSettlement(tx, centerId, teacherId, historyStart, to, actor),
        WRITE_TRANSACTION_OPTIONS,
      );
      if (!created.ok) throw new Error(`Settlement ${teacherKey}: ${created.error}`);
      settlement = created.settlement;
      await audit(centerId, actor, "settlement.create", "Settlement", settlement.id, {
        teacherId, periodFrom: dateKey(historyStart), periodTo: dateKey(to), totalAmount: settlement.totalAmount,
      });
    }
    if (wanted !== "DRAFT" && settlement.status === "DRAFT") {
      const approved = await approveSettlement(prisma, centerId, settlement.id, approver);
      if (!approved.ok) throw new Error(`Approve ${teacherKey}: ${approved.error}`);
      settlement = approved.settlement;
      await audit(centerId, approver.userId, "settlement.approve", "Settlement", settlement.id, {
        status: "APPROVED", selfApproved: approved.selfApproved,
      });
    }
    if (wanted === "PAID" && settlement.status === "APPROVED") {
      const paid = await paySettlement(prisma, centerId, settlement.id, approver);
      if (!paid.ok) throw new Error(`Pay ${teacherKey}: ${paid.error}`);
      await audit(centerId, approver.userId, "settlement.pay", "Settlement", settlement.id, {
        status: "PAID", selfApproved: paid.selfApproved,
      });
    }
  }
  line("  settlements: one PAID, one APPROVED, one DRAFT (after a cancelled draft) — approved by the owner");
}

async function seedExpenses(ctx: Centre, today: Date) {
  const centerId = ctx.center.id;
  if (ctx.branch.rooms.length === 0) return;

  const names = ["Rent", "Salaries", "Utilities", "Supplies", "Marketing"];
  const categories: Record<string, string> = {};
  for (const name of names) {
    const existing = await prisma.expenseCategory.findFirst({ where: { centerId, name } });
    categories[name] = (existing ?? (await prisma.expenseCategory.create({ data: { centerId, name } }))).id;
  }
  const scale = ctx.branch.key === "downtown" ? 1 : ctx.branch.key === "nasrcity" ? 0.9 : 0.6;
  const entries: [string, number, number, string][] = [
    // [category, days ago, EGP, note]
    ["Rent", 12, 12_000, "October rent"],
    ["Rent", 42, 12_000, "September rent"],
    ["Salaries", 3, 8_500, "Front-desk and cleaning staff"],
    ["Salaries", 33, 8_500, "Front-desk and cleaning staff — September"],
    ["Utilities", 9, 1_850, "Electricity and water"],
    ["Utilities", 31, 1_720, "Electricity and water — September"],
    ["Supplies", 6, 650, "Markers, paper and printer toner"],
    ["Supplies", 20, 480, "Whiteboard cleaner and cups"],
    ["Marketing", 15, 1_500, "Social media posts and flyers"],
    ["Marketing", 38, 900, "Back-to-school banner"],
  ];
  for (const [category, daysAgo, egp, note] of entries) {
    const amount = Math.round(egp * scale) * 100;
    const date = addDays(today, -daysAgo);
    // RESUMABLE: an entry already written (same category, day and note) is skipped.
    const already = await prisma.expense.count({ where: { centerId, categoryId: categories[category], date, note } });
    if (already > 0) continue;
    const expense = await prisma.expense.create({
      data: { centerId, categoryId: categories[category], amount, date, note, recordedBy: ctx.actorId },
    });
    await audit(centerId, ctx.actorId, "expense.create", "Expense", expense.id, {
      categoryId: categories[category], amount, date: dateKey(date),
    });
  }
  // One entry recorded twice by mistake and voided (D-24): it stays in the
  // list, struck through, and is left out of every total.
  const duplicateNote = "Markers, paper and printer toner (entered twice)";
  const duplicateDate = addDays(today, -6);
  if ((await prisma.expense.count({ where: { centerId, note: duplicateNote } })) === 0) {
    const duplicate = await prisma.expense.create({
      data: {
        centerId,
        categoryId: categories.Supplies,
        amount: Math.round(650 * scale) * 100,
        date: duplicateDate,
        note: duplicateNote,
        recordedBy: ctx.actorId,
        voided: true,
        voidReason: "Recorded twice — the same receipt is already entered",
        voidedAt: new Date(),
        voidedBy: ctx.actorId,
      },
    });
    await audit(centerId, ctx.actorId, "expense.void", "Expense", duplicate.id, { voided: true });
  }
  line(`  expenses: ${entries.length} across ${names.join(", ")}, plus one voided duplicate`);
}

async function seedRatings(ctx: Centre, today: Date) {
  const centerId = ctx.center.id;
  if (ctx.branch.rooms.length === 0) return;
  const loginUserIds = new Set(ctx.students.filter((student) => student.login).map((student) => student.userId));
  const rows = await prisma.sessionAttendee.findMany({
    where: {
      centerId,
      attendanceStatus: { in: ["PRESENT", "LATE"] },
      session: { date: { gte: addDays(today, -6), lt: today } },
      studentProfileId: { not: null },
    },
    select: { sessionId: true, studentProfile: { select: { userId: true } } },
  });
  const rng = makeRng(hashString(`ratings:${centerId}`));
  let rated = 0;
  for (const row of rows) {
    const studentUserId = row.studentProfile?.userId;
    // Students who can sign in keep their sessions unrated, so the pop-up appears for them.
    if (!studentUserId || loginUserIds.has(studentUserId) || !rng.chance(0.4)) continue;
    const score = rng.chance(0.6) ? 5 : rng.chance(0.7) ? 4 : 3;
    const result = await submitSessionRating(prisma, { studentUserId, sessionId: row.sessionId, score });
    if (result.ok) rated += 1;
  }
  line(`  ratings: ${rated} (last 6 days)`);
}

async function seedReservationsAndRequests(ctx: Centre, catalog: Catalog, today: Date) {
  const centerId = ctx.center.id;
  if (ctx.branch.key !== "downtown" && ctx.branch.key !== "nasrcity") return;

  const confirmingClass = ctx.classes.find((row) => row.def.requiresConfirmation);
  if (confirmingClass) {
    const classGroupId = confirmingClass.group.id;
    // RESUMABLE: each reservation is found first; only a missing one is
    // requested, and only a still-PENDING one is confirmed / rejected.
    const reserve = async (def: PersonDef) => {
      const user = await ensurePerson(def, { phone: true });
      const existing = await prisma.reservation.findFirst({ where: { centerId, classGroupId, studentId: user.id } });
      if (existing) return existing;
      const result = await prisma.$transaction(
        (tx) => reserveOrEnroll(tx, { centerId, classGroupId, studentUserId: user.id }),
        WRITE_TRANSACTION_OPTIONS,
      );
      if (!result.ok || result.kind !== "pending") throw new Error(`Reservation for ${user.email}: ${result.ok ? result.kind : result.error}`);
      return prisma.reservation.findUniqueOrThrow({ where: { id: result.reservationId } });
    };

    if (ctx.branch.key === "downtown") {
      // Pending (a person with no centre yet), confirmed, and rejected inside the 7-day cooldown.
      await reserve(DISCOVER_STUDENT);
      const confirming = await reserve({ key: "res-confirmed", first: "Mostafa", last: "Reda", email: mail("mostafa.reda.res"), locale: "en" });
      if (confirming.status === "PENDING") {
        const confirmed = await prisma.$transaction(
          (tx) => confirmReservation(tx, centerId, confirming.id, ctx.actorId),
          WRITE_TRANSACTION_OPTIONS,
        );
        if (!confirmed.ok) throw new Error(`Confirm reservation: ${confirmed.error}`);
        await audit(centerId, ctx.actorId, "reservation.confirm", "Reservation", confirming.id);
      }
      const rejecting = await reserve({ key: "res-rejected", first: "Hana", last: "Zaki", email: mail("hana.zaki.res"), locale: "en" });
      if (rejecting.status === "PENDING") {
        const rejected = await rejectReservation(prisma, centerId, rejecting.id, ctx.actorId);
        if (!rejected.ok) throw new Error(`Reject reservation: ${rejected.error}`);
        await audit(centerId, ctx.actorId, "reservation.reject", "Reservation", rejecting.id);
      }
    } else {
      await reserve({ key: "res-nasr", first: "Adam", last: "Khalil", email: mail("adam.khalil.res"), locale: "en" });
    }
    line("  reservations: pending / confirmed / rejected (cooldown) seeded");
  }

  // Teacher change requests, written the way the teacher pages write them.
  if (ctx.branch.key === "downtown") {
    const request = async (
      type: "NEW_CLASS" | "NEW_SESSION",
      requestedBy: string,
      payload: Prisma.InputJsonObject,
    ) => {
      // RESUMABLE: one pending request per (type, teacher) is the whole demo.
      const exists = await prisma.changeRequest.count({ where: { centerId, type, requestedBy } });
      if (exists === 0) await prisma.changeRequest.create({ data: { centerId, type, requestedBy, payload } });
    };

    const english = catalog.subject("EG", "Primary 6", "English");
    await request("NEW_CLASS", ctx.teacherIds.karim, {
      subjectId: english.id,
      gradeId: english.gradeId,
      dayOfWeek: 0,
      startTime: "15:00",
      endTime: "16:30",
      lateThresholdMinutes: 10,
      note: "A second weekly group — the Wednesday class is full.",
    });
    const arabic = ctx.classes.find((row) => row.def.key === "dt-arabic-p6");
    if (arabic) {
      await request("NEW_SESSION", arabic.group.teacherId, {
        classGroupId: arabic.group.id,
        date: dateKey(skipFriday(addDays(today, 9))),
        startTime: "16:00",
        endTime: "17:30",
        note: "Revision before the unit test.",
      });
    }
    // A teacher with no centre at all asking to teach here (from the centre directory).
    const walid = await ensurePerson(ZERO_CENTRE_TEACHER);
    const physics = catalog.subject("EG", "Secondary 3", "Physics");
    await request("NEW_CLASS", walid.id, {
      subjectId: physics.id,
      gradeId: physics.gradeId,
      dayOfWeek: 4,
      startTime: "13:00",
      endTime: "15:00",
      lateThresholdMinutes: 10,
      note: "Ten years teaching Thanaweya Amma physics; available on Thursdays.",
    });
    line("  change requests: pending NEW_CLASS, NEW_SESSION, and a zero-centre teacher's request to teach");
  }
}

// ── Parents ──────────────────────────────────────────────────────────────────

async function seedParents(centres: Centre[]) {
  for (const def of [PARENTS.family, PARENTS.nokhba]) {
    const parent = await ensurePerson(def);
    // A phone match only ever produces PENDING links - origination is not verification.
    const origin = await originateParentLinks(prisma, { parentUserId: parent.id, phone: phones.forKey(def.key).canonical });
    if (origin.refused) throw new Error(`Parent ${def.email}: ${origin.reason}`);
  }

  const keyByProfile = new Map<string, string>();
  for (const centre of centres) for (const student of centre.students) keyByProfile.set(student.profileId, student.key);

  const family = await prisma.user.findUniqueOrThrow({ where: { email: PARENTS.family.email } });
  const nokhba = await prisma.user.findUniqueOrThrow({ where: { email: PARENTS.nokhba.email } });
  const links = await prisma.parentLink.findMany({
    where: { parentUserId: { in: [family.id, nokhba.id] } },
    include: { studentProfile: { include: { center: true } } },
  });
  for (const link of links) {
    const key = keyByProfile.get(link.studentProfileId);
    // family: the two Center 60 children (one per branch) are verified; the third stays PENDING.
    // nokhba: the Al Nokhba link is verified; the same child's Downtown link stays PENDING.
    const shouldVerify =
      link.parentUserId === family.id
        ? key === "dt-yara" || key === "nc-ziad"
        : link.studentProfile.center.slug === "al-nokhba-academy";
    if (!shouldVerify || link.status !== "PENDING") continue;
    // No app path verifies a link since SEC-2a (D-03 (d) — OD-6 is open), so
    // the demo world marks its two verified links directly, as fixture data,
    // exactly like the links the dev data held before SEC-2a. Conditional on
    // PENDING, and audited like any verification.
    const verifier = await centreStaffId(link.centerId);
    const verified = await prisma.parentLink.updateMany({
      where: { id: link.id, centerId: link.centerId, status: "PENDING" },
      data: { status: "VERIFIED", verifiedAt: new Date(), verifiedBy: verifier },
    });
    if (verified.count !== 1) throw new Error(`Verify parent link ${link.id}: not PENDING`);
    await audit(link.centerId, verifier, "parentLink.verify", "ParentLink", link.id, { via: "seed" });
  }
  const summary = await prisma.parentLink.groupBy({ by: ["status"], _count: { _all: true } });
  line(`\n■ Parents: ${summary.map((row) => `${row._count._all} ${row.status}`).join(", ")}`);
}

async function centreStaffId(centerId: string): Promise<string> {
  const membership = await prisma.membership.findFirstOrThrow({
    where: { centerId, role: { in: ["OWNER", "MANAGER"] } },
    orderBy: { role: "asc" },
  });
  return membership.userId;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = guardEnvironment();

  const accounts = seedAccounts();
  if (mode === "dev") {
    // FIRST, before any database write: the same Auth check `npm run
    // seed:preflight` runs (password, project refs, service-role key, address
    // clashes, one probe user created and deleted). A problem stops us here
    // with nothing half-seeded.
    const preflight = await runAuthPreflight(accounts.map((account) => account.email));
    for (const step of preflight.steps) line(`  ${step.ok ? "PASS" : "FAIL"}  ${step.name} — ${step.detail}`);
    if (!preflight.ok) throw new Error("Auth preflight failed - nothing was written. Fix the FAIL line(s) above (npm run seed:preflight repeats this check).");
  }
  auth = mode === "local" ? offlineAuth() : await SeedAuth.connect(accounts.map((account) => account.email));

  line("KayEdu demo seed (P1)");
  line(
    mode === "local"
      ? "  local database: Supabase Auth is skipped (no sign-in accounts are created)"
      : `  ${accounts.length} sign-in accounts in the fixed list`,
  );

  const tz = DEFAULT_TIMEZONE;
  const today = todayInTimezone(tz);
  const historyStart = addDays(today, -35);
  const terms = academicTerms(today);
  const holidayList = holidaysBetween(historyStart, terms.FULL.endDate);
  const holidayKeys = new Set(holidayList.map((holiday) => dateKey(holiday.date)));
  line(`  today (Cairo): ${dateKey(today)}; history from ${dateKey(historyStart)}; Full year ends ${dateKey(terms.FULL.endDate)}`);

  // Platform admin + the global catalog (written as the admin).
  const admin = await ensurePerson(PLATFORM_ADMIN, { isPlatformAdmin: true });
  line("\n■ Global catalog");
  const catalog = await ensureCatalog(prisma, admin.id, line);

  // Centres and their people, structure first.
  const centres: Centre[] = [];
  for (const branch of BRANCHES) {
    // Center 60's Owner must exist before its branches are built (it acts for them).
    if (branch.key === "downtown") await ensurePerson(branch.staff[0]);
    centres.push(await seedCentre(branch, catalog, terms, holidayList));
  }

  // Everyone who studies, then each active centre's classes and calendar.
  for (const ctx of centres) {
    if (ctx.branch.rooms.length === 0) continue;
    await ensureStudents(ctx, catalog);
  }
  for (const ctx of centres) {
    if (ctx.branch.rooms.length === 0) continue;
    line(`\n■ ${ctx.branch.name} — classes & calendar`);
    await ensureClasses(ctx, catalog, terms, today, historyStart);
    await seedHistory(ctx, today, historyStart, holidayKeys);
    await seedToday(ctx, today);
    await seedSpecialSessions(ctx, catalog, today);
    await seedSettlements(ctx, today, historyStart);
    await seedExpenses(ctx, today);
    await seedRatings(ctx, today);
    await seedReservationsAndRequests(ctx, catalog, today);
  }

  // Parents once their children exist.
  await seedParents(centres);

  // The deactivation of a class comes last: its history stays, its future goes.
  for (const ctx of centres) {
    for (const row of ctx.classes.filter((r) => r.def.deactivate)) {
      const current = await prisma.classGroup.findUniqueOrThrow({ where: { id: row.group.id } });
      if (!current.active) continue;
      const result = await deactivateClass(prisma, ctx.center.id, row.group.id, { actorUserId: ctx.actorId });
      if (result.ok) line(`  deactivated ${row.def.key} (${result.deleted} future session(s) removed, ${result.cancelled} cancelled)`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  line("\n──────────────────────────────────────────────────────────────");
  line("Seed complete. Sign in at /en/login (or /ar/login) with any account in");
  line("docs/dev-accounts.md — the password of every one is SEED_PASSWORD, except the");
  line("platform admin, whose password is SEED_ADMIN_PASSWORD.");
  line(
    mode === "local"
      ? "\nAccounts created or reset: none (local database — Supabase Auth skipped)"
      : `\nAccounts created or reset: ${accounts.length}`,
  );
  const others = auth.otherAuthUsers();
  if (others.length > 0) {
    line(`\nOther Supabase Auth users in this project (NOT in the seed's list — left untouched): ${others.length}`);
    for (const email of others) line(`  ${email}`);
  }
  line("\nNext: npm run seed:verify");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
