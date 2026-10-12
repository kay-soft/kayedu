import type { Prisma } from "@prisma/client";
// Relative imports on purpose — `npm run check:classes` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/students.ts).
import { catalogLabel } from "../catalog.ts";
import { ROOM_SET_SELECT } from "./room-sets.ts";
import type { ScopedDb } from "@/lib/db/scoped";

/**
 * Class-group policy that is neither a scoping primitive nor UI: the lean
 * list select, the search/filter `where`, and what makes a class undeletable.
 */

/**
 * Fields a class row on the list page actually renders. `teacherId` only —
 * not the `teacher` relation — because the name shown is this center's own
 * local record on the teacher's `Membership` (docs/01-data-model.md §6), not
 * the raw global `User`; the page batches that lookup once per page of rows,
 * the same way the teacher block-counts are batched (docs/02 §14).
 *
 * A function of `centerId`, not a static object (M13): `subject`/`grade`
 * each carry a nested, centre-scoped `selections` lookup so a display reads
 * this centre's own rename when it has one — no schema field freezes a
 * catalog entry's name (unlike `priceSnapshot` for money), so every live
 * read resolves the override, not just the settings/catalog screen and the
 * class form. `lib/catalog.ts`'s `catalogLabelWithSelection` reads it back.
 */
export function classListSelect(centerId: string) {
  return {
    id: true,
    active: true,
    price: true,
    centerShareType: true,
    centerShareValue: true,
    teacherId: true,
    subject: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: { displayName: true }, take: 1 },
      },
    },
    grade: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: { displayName: true }, take: 1 },
      },
    },
    // R3 — the class's room set (primary + extras) and the seats it adds up to.
    ...ROOM_SET_SELECT,
    _count: {
      select: {
        schedules: true,
        enrollments: { where: { status: "ACTIVE" } },
      },
    },
  } satisfies Prisma.ClassGroupSelect;
}

export type ClassListRow = Prisma.ClassGroupGetPayload<{
  select: ReturnType<typeof classListSelect>;
}>;

/** A class detail page — every field it actually renders, plus its schedules. */
export function classDetailInclude(centerId: string) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return {
    teacher: true,
    subject: withSelection,
    grade: withSelection,
    educationSystem: withSelection,
    room: true,
    extraRooms: { include: { room: true }, orderBy: { createdAt: "asc" } },
    schedules: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
  } satisfies Prisma.ClassGroupInclude;
}

export type ClassDetailRow = Prisma.ClassGroupGetPayload<{
  include: ReturnType<typeof classDetailInclude>;
}>;

export function classListWhere(filters: {
  teacherId?: string | null;
  subjectId?: string | null;
  gradeId?: string | null;
}): Prisma.ClassGroupWhereInput | undefined {
  const where: Prisma.ClassGroupWhereInput = {};
  if (filters.teacherId) where.teacherId = filters.teacherId;
  if (filters.subjectId) where.subjectId = filters.subjectId;
  if (filters.gradeId) where.gradeId = filters.gradeId;
  return Object.keys(where).length > 0 ? where : undefined;
}

/**
 * A class that already carries enrollments or generated sessions is
 * deactivated, not deleted — the roster and the calendar must keep resolving
 * (CLAUDE.md rule 2, docs/01-data-model.md §6 "config master data …
 * deactivates by default").
 */
export async function classDeleteBlockers(
  db: ScopedDb,
  classGroupId: string,
): Promise<number> {
  const [enrollments, sessions] = await Promise.all([
    db.enrollments.count({ classGroupId }),
    db.sessions.count({ classGroupId }),
  ]);
  return enrollments + sessions;
}

/**
 * A short label for the class in a conflict message ("Math · Grade 10") —
 * the catalog entry's bilingual name in the given locale (M13), never a
 * centre's display-name override: a conflict warning is internal
 * plumbing text, not a screen a centre customizes.
 */
export function classDisplayName(
  locale: string,
  row: Pick<ClassListRow, "subject" | "grade">,
): string {
  return (
    [
      row.subject ? catalogLabel(locale, row.subject) : null,
      row.grade ? catalogLabel(locale, row.grade) : null,
    ]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}
