import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * Teacher photos and class covers (U9) — the keys and the signed-in side of
 * their delivery. Every query takes one explicit `centerId` and goes through
 * `scopedWhere` (CLAUDE.md rule 1). A guest's side lives in
 * `lib/db/public-catalog.ts`, which adds the "listed branch" rule.
 *
 * Relative imports on purpose: `check:security` and `check:people` exercise
 * this module outside the Next.js runtime, like the other `lib/db` modules.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const TEACHER: Role = "TEACHER";

/** Sets (or clears) one class's cover key; false when the class is not in this centre. */
export async function setClassCoverKey(
  db: Db,
  centerId: string,
  classGroupId: string,
  coverKey: string | null,
): Promise<boolean> {
  const result = await db.classGroup.updateMany({
    where: scopedWhere(centerId, { id: classGroupId }),
    data: { coverKey },
  });
  return result.count > 0;
}

/** The cover key of a class in this centre, or undefined when the class is not here. */
export async function classCoverKeyOf(
  db: Db,
  centerId: string,
  classGroupId: string,
): Promise<string | null | undefined> {
  const row = await db.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: { coverKey: true },
  });
  return row ? row.coverKey : undefined;
}

/**
 * Sets (or clears) a teacher's photo key on one TEACHER membership of this
 * centre; false when there is no such membership here.
 */
export async function setTeacherPhotoKey(
  db: Db,
  centerId: string,
  membershipId: string,
  photoKey: string | null,
): Promise<boolean> {
  const result = await db.membership.updateMany({
    where: scopedWhere(centerId, { id: membershipId, role: TEACHER }),
    data: { photoKey },
  });
  return result.count > 0;
}

/** A teacher membership's photo key at this centre, by membership id; null when it is not a teacher here. */
export async function teacherPhotoKeyById(db: Db, centerId: string, membershipId: string) {
  const row = await db.membership.findFirst({
    where: scopedWhere(centerId, { id: membershipId, role: TEACHER }),
    select: { photoKey: true },
  });
  return row ? { photoKey: row.photoKey } : null;
}

/** A teacher's photo key at this centre, by their user id. */
export function teacherPhotoKeyAt(db: Db, centerId: string, teacherUserId: string) {
  return db.membership.findFirst({
    where: scopedWhere(centerId, { userId: teacherUserId, role: TEACHER }),
    select: { photoKey: true },
  });
}

/**
 * The signed-in delivery rule for `/api/class-images` and
 * `/api/teacher-photos`: the centre may operate (the same lifecycle rule as
 * Discover and the logo directory), then the row is read scoped to it.
 */
export async function accessibleCenterId(db: PrismaClient, centerId: string): Promise<boolean> {
  const row = await db.center.findFirst({ where: { id: centerId, ...ACCESSIBLE_CENTER }, select: { id: true } });
  return Boolean(row);
}

/** A class's cover key and its teacher's photo key at that branch (signed-in delivery). */
export async function classImageSource(db: Db, centerId: string, classGroupId: string) {
  const row = await db.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: { coverKey: true, teacherId: true },
  });
  if (!row) return null;
  const teacher = await teacherPhotoKeyAt(db, centerId, row.teacherId);
  return { coverKey: row.coverKey, teacherPhotoKey: teacher?.photoKey ?? null };
}
