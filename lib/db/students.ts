import type { Prisma } from "@prisma/client";
// Relative import on purpose: `claimStudentCode` is exercised directly by
// `npm run check:people` outside the Next.js runtime, so this module and
// everything it pulls in must stay resolvable without the `@/` alias (same
// reasoning as lib/identity.ts).
import { normalizePhone } from "../phone.ts";
import type { ScopedDb } from "@/lib/db/scoped";
import { CATALOG_OVERRIDE_SELECT } from "../catalog.ts";

/**
 * Student & teacher policies that are neither scoping primitives nor UI: how
 * a student code is minted, how the lists are searched, and what makes a
 * person undeletable. Everything here goes through `ScopedDb` or takes a
 * `centerId` explicitly, so it stays centerId-filtered by construction.
 */

/** Where auto-generated codes start (docs/01-data-model.md §6). */
const FIRST_STUDENT_CODE = 1001;

/**
 * Claims the next student code for a center, race-free, and creates the
 * `StudentProfile` in the same transaction.
 *
 * The code is **never typed by staff** — it is a per-center sequence backed
 * by a `StudentCodeCounter` row. A single `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` claims the next value atomically (Postgres serializes concurrent
 * upserts on the same row via the primary-key lock), so two receptionists
 * registering at once still get consecutive, non-colliding codes. Running it
 * inside the caller's transaction — alongside the `StudentProfile` write, and
 * the new-person `User` write when there is one — means a rollback for any
 * other reason (a validation failure, a later constraint violation) undoes
 * the claim too: a crash never burns a code into a permanent gap.
 */
export async function claimStudentCode(
  tx: Prisma.TransactionClient,
  centerId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ code: number }[]>`
    INSERT INTO "StudentCodeCounter" ("centerId", "next")
    VALUES (${centerId}, ${FIRST_STUDENT_CODE + 1})
    ON CONFLICT ("centerId")
    DO UPDATE SET "next" = "StudentCodeCounter"."next" + 1
    RETURNING "next" - 1 AS code
  `;
  return String(rows[0].code);
}

/**
 * Fields a list row actually renders — never the whole `User`/`Grade` row.
 * `firstName`/`lastName` are the **local** name (docs/01 §6); `user` is kept
 * only as the fallback for a record whose local name was never seeded (see
 * `lib/identity.ts` `localName()`).
 *
 * A function of `centerId`, not a static object (M13): `grade` carries a
 * nested, centre-scoped `selections` lookup so the grade shown resolves this
 * centre's own rename when it has one (`lib/catalog.ts`'s
 * `catalogLabelWithSelection`) — no schema field freezes a catalog name.
 */
export function studentListSelect(centerId: string) {
  return {
    id: true,
    studentCode: true,
    active: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    parentPhone: true,
    gradeId: true,
    user: { select: { firstName: true, lastName: true } },
    grade: {
      select: {
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
  } satisfies Prisma.StudentProfileSelect;
}

export type StudentListRow = Prisma.StudentProfileGetPayload<{
  select: ReturnType<typeof studentListSelect>;
}>;

export const TEACHER_LIST_SELECT = {
  id: true,
  userId: true,
  active: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  user: { select: { firstName: true, lastName: true } },
} satisfies Prisma.MembershipSelect;

export type TeacherListRow = Prisma.MembershipGetPayload<{
  select: typeof TEACHER_LIST_SELECT;
}>;

/**
 * Reception searches by code, name or phone (spec §4.1 item 8). Each typed
 * word must match somewhere, so "ahmed 1004" finds Ahmed with code 1004.
 * Matches this center's **local** name/contact first — what the row actually
 * displays — plus the global `User` name as a fallback for a record whose
 * local name was never seeded, and the parent's contact.
 */
export function studentSearchWhere(
  query: string,
): Prisma.StudentProfileWhereInput | undefined {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length === 0) return undefined;

  return {
    AND: tokens.map((token) => {
      const asPhone = normalizePhone(token);
      const contains = { contains: token, mode: "insensitive" as const };

      return {
        OR: [
          { studentCode: contains },
          { firstName: contains },
          { lastName: contains },
          { user: { firstName: contains } },
          { user: { lastName: contains } },
          { parentFirstName: contains },
          { parentLastName: contains },
          { parentPhone: contains },
          { phone: contains },
          ...(asPhone
            ? [{ phone: asPhone }, { parentPhone: asPhone }]
            : []),
        ],
      };
    }),
  };
}

/** The teacher-list equivalent — this center's local name/contact, or the fallback. */
export function teacherSearchWhere(
  query: string,
): Prisma.MembershipWhereInput | undefined {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length === 0) return undefined;

  return {
    AND: tokens.map((token) => {
      const asPhone = normalizePhone(token);
      const contains = { contains: token, mode: "insensitive" as const };

      return {
        OR: [
          { firstName: contains },
          { lastName: contains },
          { user: { firstName: contains } },
          { user: { lastName: contains } },
          { phone: contains },
          { email: contains },
          ...(asPhone ? [{ phone: asPhone }] : []),
        ],
      };
    }),
  };
}

/**
 * Money and attendance history are append-only (CLAUDE.md rule 2), so a
 * student who has ever been on a roster is deactivated, never deleted.
 */
export async function studentDeleteBlockers(
  db: ScopedDb,
  studentProfileId: string,
): Promise<number> {
  const [attendees, payments] = await Promise.all([
    db.attendees.count({ studentProfileId }),
    db.payments.count({ studentProfileId }),
  ]);
  return attendees + payments;
}

/**
 * A teacher who already carries classes or sessions here is deactivated, not
 * deleted — the schedule and its history must keep resolving.
 */
export async function teacherDeleteBlockers(
  db: ScopedDb,
  teacherUserId: string,
): Promise<number> {
  const [classes, sessions] = await Promise.all([
    db.classGroups.count({ teacherId: teacherUserId }),
    db.sessions.count({ teacherId: teacherUserId }),
  ]);
  return classes + sessions;
}

