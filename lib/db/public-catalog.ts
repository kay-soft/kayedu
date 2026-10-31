import type { CenterLifecycleState, Prisma, PrismaClient, Role, SessionBookingMode } from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same as lib/db/discover.ts).
import { fullName, localName } from "../identity.ts";
import { CATALOG_OVERRIDE_SELECT } from "../catalog.ts";
import { enrollmentCap, seatStatus, type SeatStatus } from "../capacity.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { effectiveCapacity } from "../rooms.ts";
import { centreTimeZone, dateKey, todayInTimezone } from "../scheduling.ts";
import { centerLogoSrc } from "../storage-paths.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { teacherRatingAverages } from "./ratings.ts";
import { pausedUntilFrom } from "./branch-pauses.ts";

/**
 * The public catalog (F5, docs/02-architecture.md §2 "(public)"): everything a
 * guest — no sign-in — may read on the Explore pages, and nothing else. It is
 * the **only** data module a `(public)` page imports (`npm run check:public`).
 *
 * Three rules hold every query here:
 * - **Explicit `select` allowlists**, never an `include`: a branch is its slug,
 *   names, logo and theme colour; a class is its catalog labels, schedule,
 *   period, price and join options; a teacher is that branch's local name.
 *   No phone, email, student, enrolment, payment, staff or rating-count field
 *   is ever selected (`check:public` reads the selects).
 * - **Listed branches only**: ACTIVE or GRACE *and* `CenterSettings.
 *   publicListing`. Anything else is `null` here, which a page turns into 404.
 *   The signed-in student Discover keeps its own rules (lib/db/discover.ts).
 * - **Per-branch reads stay `centerId`-scoped** through `scopedWhere`; a
 *   search across branches is a union of per-branch queries in memory
 *   (docs/02 §14), never a `where` spanning centres.
 *
 * Seats leave this module as a status (`seatStatus`), never a number.
 */

type Db = PrismaClient;

/** The lifecycle states a branch may be publicly listed in (never ONBOARDING, SUSPENDED or ARCHIVED). */
export const PUBLIC_LIFECYCLE_STATES: readonly CenterLifecycleState[] = ["ACTIVE", "GRACE"];

export const EXPLORE_BRANCH_PAGE_SIZE = 12;
export const EXPLORE_CLASS_PAGE_SIZE = 20;

/** Branches whose classes load in parallel on one Explore search (SEC-32). */
const EXPLORE_CENTER_CONCURRENCY = 5;

/** Classes read per branch — the same bound Discover uses. */
const CLASSES_PER_BRANCH = 200;

const TEACHER: Role = "TEACHER";

// ── Branches ────────────────────────────────────────────────────────────────

const PUBLIC_BRANCH_SELECT = {
  id: true,
  slug: true,
  name: true,
  nameEn: true,
  logoPath: true,
  themeColor: true,
  settings: { select: { timezone: true } },
  // U5: the newest pause not ended early — at most one is current or upcoming,
  // so if one covers today it is this one (`pausedUntilFrom`). Dates only.
  pauses: {
    where: { endedEarlyAt: null },
    select: { startDate: true, endDate: true },
    orderBy: { endDate: "desc" },
    take: 1,
  },
} satisfies Prisma.CenterSelect;

type PublicBranchRow = Prisma.CenterGetPayload<{ select: typeof PUBLIC_BRANCH_SELECT }>;

export type PublicBranch = {
  /** Kept for the per-branch scoped reads and the logo route; never shown. */
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  logoUrl: string | null;
  themeColor: string;
  timeZone: string;
  /** U5 — the last day of a platform admin's pause covering the branch's today, or null. */
  pausedUntil: Date | null;
};

function publicBranchWhere(extra: Prisma.CenterWhereInput = {}): Prisma.CenterWhereInput {
  return {
    ...extra,
    lifecycleState: { in: [...PUBLIC_LIFECYCLE_STATES] },
    // U5: a branch a platform admin deleted is gone from Explore at once.
    deletedAt: null,
    settings: { is: { publicListing: true } },
  };
}

function toPublicBranch(row: PublicBranchRow): PublicBranch {
  const timeZone = centreTimeZone(row.settings);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.nameEn,
    logoUrl: centerLogoSrc(row),
    themeColor: row.themeColor,
    timeZone,
    pausedUntil: pausedUntilFrom(row.pauses, dateKey(todayInTimezone(timeZone))),
  };
}

/** One page of listed branches, by name. */
export async function listPublicBranches(
  db: Db,
  page: number,
): Promise<{ branches: PublicBranch[]; total: number }> {
  const where = publicBranchWhere();
  const [rows, total] = await Promise.all([
    db.center.findMany({
      where,
      select: PUBLIC_BRANCH_SELECT,
      orderBy: { name: "asc" },
      skip: (page - 1) * EXPLORE_BRANCH_PAGE_SIZE,
      take: EXPLORE_BRANCH_PAGE_SIZE,
    }),
    db.center.count({ where }),
  ]);
  return { branches: rows.map(toPublicBranch), total };
}

/** A listed branch by its slug, or `null` (unlisted, wrong state, unknown). */
export async function publicBranchBySlug(db: Db, slug: string): Promise<PublicBranch | null> {
  if (!slug || slug.length > 200) return null;
  const row = await db.center.findFirst({
    where: publicBranchWhere({ slug }),
    select: PUBLIC_BRANCH_SELECT,
  });
  return row ? toPublicBranch(row) : null;
}

/**
 * A listed branch's stored logo key, for `/api/logos/[centerId]` serving a
 * guest (F5). `null` for every branch a guest may not see.
 */
export function publicBranchLogo(db: Db, centerId: string) {
  return db.center.findFirst({
    where: publicBranchWhere({ id: centerId }),
    select: { id: true, logoPath: true },
  });
}

// ── Classes ─────────────────────────────────────────────────────────────────

function publicClassSelect(centerId: string) {
  return {
    id: true,
    teacherId: true,
    price: true,
    requiresConfirmation: true,
    // F6 — a join option: whether one session can be booked online.
    sessionBookingMode: true,
    startDate: true,
    endDate: true,
    subject: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    grade: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    // Capacity only (R3: the room set's summed capacity) — never a room name.
    room: { select: { capacity: true } },
    extraRooms: { select: { room: { select: { capacity: true } } } },
    schedules: {
      select: { dayOfWeek: true, startTime: true, endTime: true },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    },
    // Turned into a SeatStatus below and dropped; the number never leaves.
    _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
  } satisfies Prisma.ClassGroupSelect;
}

type PublicClassRow = Prisma.ClassGroupGetPayload<{ select: ReturnType<typeof publicClassSelect> }>;

type CatalogRef = PublicClassRow["subject"];

export type PublicClass = {
  id: string;
  teacherUserId: string;
  /** The branch's own local name for the teacher (rule 4). */
  teacherName: string;
  /** Platform-wide average out of 5, or null — never a count (spec §5 "Teacher ratings"). */
  teacherRating: number | null;
  subject: CatalogRef;
  grade: CatalogRef;
  schedules: PublicClassRow["schedules"];
  startDate: Date;
  endDate: Date;
  /** Piastres per session. */
  price: number;
  requiresConfirmation: boolean;
  /** F6 — OFF / INSTANT / APPROVAL; sessions themselves are read signed-in only. */
  sessionBookingMode: SessionBookingMode;
  seats: SeatStatus;
};

export type PublicClassWithBranch = PublicClass & { branch: PublicBranch };

export type PublicClassFilters = { subjectId?: string; gradeId?: string; day?: number };

/**
 * A class is listed when it is active, still accepts new students, and has
 * not ended by the branch's own today (R7b — the branch's timezone).
 */
function publicClassWhere(branch: PublicBranch, now: Date, extra: Prisma.ClassGroupWhereInput = {}) {
  return scopedWhere(branch.id, {
    ...extra,
    active: true,
    acceptsNewStudents: true,
    endDate: { gte: todayInTimezone(branch.timeZone, now) },
  });
}

async function teacherNamesAt(db: Db, centerId: string, teacherUserIds: string[]) {
  if (teacherUserIds.length === 0) return new Map<string, string>();
  const rows = await db.membership.findMany({
    where: scopedWhere(centerId, { userId: { in: teacherUserIds }, role: TEACHER }),
    select: {
      userId: true,
      firstName: true,
      lastName: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });
  return new Map(rows.map((row) => [row.userId, fullName(localName(row, row.user))]));
}

function toPublicClasses(
  rows: PublicClassRow[],
  names: Map<string, string>,
  ratings: Map<string, number>,
): PublicClass[] {
  return rows
    .filter((row) => names.has(row.teacherId))
    .map((row) => {
      const rooms = row.room ? [row.room, ...row.extraRooms.map((extra) => extra.room)] : [];
      return {
        id: row.id,
        teacherUserId: row.teacherId,
        teacherName: names.get(row.teacherId) ?? "",
        teacherRating: ratings.get(row.teacherId) ?? null,
        subject: row.subject,
        grade: row.grade,
        schedules: row.schedules,
        startDate: row.startDate,
        endDate: row.endDate,
        price: row.price,
        requiresConfirmation: row.requiresConfirmation,
        sessionBookingMode: row.sessionBookingMode,
        seats: seatStatus(row._count.enrollments, enrollmentCap(effectiveCapacity(rooms))),
      };
    });
}

function matchesDay(row: { schedules: { dayOfWeek: number }[] }, day: number | undefined) {
  return day === undefined || row.schedules.some((slot) => slot.dayOfWeek === day);
}

/** Every listed class at one listed branch (rows only; names/ratings added by callers). */
function classRowsAt(db: Db, branch: PublicBranch, now: Date, filters: PublicClassFilters = {}) {
  return db.classGroup.findMany({
    where: publicClassWhere(branch, now, {
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
      ...(filters.gradeId ? { gradeId: filters.gradeId } : {}),
    }),
    select: publicClassSelect(branch.id),
    orderBy: [{ createdAt: "desc" }],
    take: CLASSES_PER_BRANCH,
  });
}

/** One listed branch's listed classes, with the day filter applied. */
export async function publicClassesForBranch(
  db: Db,
  branch: PublicBranch,
  now: Date,
  filters: PublicClassFilters = {},
): Promise<PublicClass[]> {
  const rows = (await classRowsAt(db, branch, now, filters)).filter((row) => matchesDay(row, filters.day));
  const teacherIds = [...new Set(rows.map((row) => row.teacherId))];
  const [names, ratings] = await Promise.all([
    teacherNamesAt(db, branch.id, teacherIds),
    teacherRatingAverages(db, teacherIds),
  ]);
  return toPublicClasses(rows, names, ratings);
}

/**
 * The Explore class search: every listed branch's listed classes matching the
 * filters — a union of per-branch scoped queries (docs/02 §14), at most
 * EXPLORE_CENTER_CONCURRENCY branches in flight. The caller pages the result.
 */
export async function searchPublicClasses(
  db: Db,
  now: Date,
  filters: PublicClassFilters,
): Promise<PublicClassWithBranch[]> {
  const branches = await db.center.findMany({
    where: publicBranchWhere(),
    select: PUBLIC_BRANCH_SELECT,
    orderBy: { name: "asc" },
  });

  const perBranch = await mapWithConcurrency(
    branches.map(toPublicBranch),
    EXPLORE_CENTER_CONCURRENCY,
    async (branch) => {
      const rows = (await classRowsAt(db, branch, now, filters)).filter((row) => matchesDay(row, filters.day));
      const names = await teacherNamesAt(db, branch.id, [...new Set(rows.map((row) => row.teacherId))]);
      return { branch, rows, names };
    },
  );

  // Ratings are platform-wide (M17): one batched read across every branch.
  const ratings = await teacherRatingAverages(db, [
    ...new Set(perBranch.flatMap(({ rows }) => rows.map((row) => row.teacherId))),
  ]);

  return perBranch.flatMap(({ branch, rows, names }) =>
    toPublicClasses(rows, names, ratings).map((item) => ({ ...item, branch })),
  );
}

/** One listed class at a listed branch, or `null`. */
export async function publicClassById(
  db: Db,
  branch: PublicBranch,
  classId: string,
  now: Date,
): Promise<PublicClass | null> {
  const row = await db.classGroup.findFirst({
    where: publicClassWhere(branch, now, { id: classId }),
    select: publicClassSelect(branch.id),
  });
  if (!row) return null;
  const [names, ratings] = await Promise.all([
    teacherNamesAt(db, branch.id, [row.teacherId]),
    teacherRatingAverages(db, [row.teacherId]),
  ]);
  return toPublicClasses([row], names, ratings)[0] ?? null;
}

// ── Teachers ────────────────────────────────────────────────────────────────

export type PublicTeacher = {
  teacherUserId: string;
  name: string;
  rating: number | null;
};

/**
 * The teachers a branch page lists: exactly the teachers of its listed
 * classes — never its staff, and never a teacher with nothing listed.
 */
export function publicTeachersOf(classes: PublicClass[]): PublicTeacher[] {
  const byId = new Map<string, PublicTeacher>();
  for (const item of classes) {
    if (!byId.has(item.teacherUserId)) {
      byId.set(item.teacherUserId, {
        teacherUserId: item.teacherUserId,
        name: item.teacherName,
        rating: item.teacherRating,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A teacher's page at one branch: that branch's local name for them, the
 * platform-wide average (no count), and their listed classes there. `null`
 * when they have no listed class at this branch — a guest can't use the page
 * to probe who works where.
 */
export async function publicTeacherAt(
  db: Db,
  branch: PublicBranch,
  teacherUserId: string,
  now: Date,
): Promise<(PublicTeacher & { classes: PublicClass[] }) | null> {
  const rows = await db.classGroup.findMany({
    where: publicClassWhere(branch, now, { teacherId: teacherUserId }),
    select: publicClassSelect(branch.id),
    orderBy: [{ createdAt: "desc" }],
    take: CLASSES_PER_BRANCH,
  });
  if (rows.length === 0) return null;
  const [names, ratings] = await Promise.all([
    teacherNamesAt(db, branch.id, [teacherUserId]),
    teacherRatingAverages(db, [teacherUserId]),
  ]);
  const classes = toPublicClasses(rows, names, ratings);
  const name = names.get(teacherUserId);
  if (!name || classes.length === 0) return null;
  return { teacherUserId, name, rating: ratings.get(teacherUserId) ?? null, classes };
}

// ── Filter options ──────────────────────────────────────────────────────────

const CATALOG_OPTION_SELECT = { id: true, nameAr: true, nameEn: true } as const;

/**
 * The active global catalog, for the grade → subject filters (M13: one id means
 * the same everywhere). Each subject once, with the grades it links to (U3).
 */
export async function publicFilterOptions(db: Db) {
  const [subjects, grades] = await Promise.all([
    db.catalogSubject.findMany({
      where: { active: true },
      select: { ...CATALOG_OPTION_SELECT, gradeLinks: { select: { gradeId: true } } },
    }),
    db.catalogGrade.findMany({ where: { active: true }, select: CATALOG_OPTION_SELECT }),
  ]);
  return {
    subjects: subjects.map(({ gradeLinks, ...subject }) => ({
      ...subject,
      gradeIds: gradeLinks.map((link) => link.gradeId),
    })),
    grades,
  };
}
