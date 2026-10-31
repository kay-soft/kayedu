import type { Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:security` exercises this
// module outside the Next.js runtime (same reasoning as lib/db/payments.ts).
import { ACCESSIBLE_CENTER } from "./platform.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Account settings (F2) — the signed-in person's own `User` row, and only
 * that. Identity-scoped, like `resolveCenterRelations`: every read and write
 * here is keyed on the caller's own `userId`, never on a `centerId`, because
 * the global `User` belongs to no tenant.
 *
 * **Rule 4:** the account never writes a branch's local record. A
 * `Membership`/`StudentProfile` keeps its own name and contact — seeded once,
 * then the branch's to edit — so `updateAccountProfile` touches the `User`
 * row alone, and the page shows each branch's record read-only.
 */

export type AccountProfileInput = {
  firstName: string;
  lastName: string;
  /** Already normalized by lib/phone.ts (the zod schema), or null. */
  contactPhone: string | null;
  locale: "ar" | "en";
};

/**
 * The platform-wide default name, the self-declared contact phone and the
 * preferred language. Never `User.phone` (staff-typed and unique — a
 * self-typed value there would let anyone squat a number, D-02), never
 * `email` (that is a sign-in credential: `lib/auth/account.ts`).
 */
export function updateAccountProfile(db: Db, userId: string, input: AccountProfileInput) {
  return db.user.update({
    where: { id: userId },
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      contactPhone: input.contactPhone,
      locale: input.locale,
    },
  });
}

/** One branch's record of this person — read-only on the account page. */
export type RecordOnFile = {
  id: string;
  kind: "membership" | "student";
  role: Role | "STUDENT";
  centerId: string;
  centerName: string;
  /** The local name, null where it was never seeded (falls back to the User's). */
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

/**
 * How each branch has this person on file: their **real** active
 * `Membership` rows and `StudentProfile` rows at accessible branches. Read
 * here rather than off `resolveCenterRelations`, whose Owner and branch-grant
 * widening adds synthetic relations that copy one branch's record onto its
 * siblings — a branch that has no record of this person must not appear to.
 */
export async function recordsOnFile(db: Db, userId: string): Promise<RecordOnFile[]> {
  const accessible = ACCESSIBLE_CENTER;
  const [memberships, profiles] = await Promise.all([
    db.membership.findMany({
      where: { userId, active: true, center: accessible },
      select: {
        id: true,
        role: true,
        firstName: true,
        lastName: true,
        phone: true,
        center: { select: { id: true, name: true } },
      },
    }),
    db.studentProfile.findMany({
      where: { userId, active: true, center: accessible },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        center: { select: { id: true, name: true } },
      },
    }),
  ]);

  const rows: RecordOnFile[] = [
    ...memberships.map((row) => ({
      id: row.id,
      kind: "membership" as const,
      role: row.role,
      centerId: row.center.id,
      centerName: row.center.name,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
    })),
    ...profiles.map((row) => ({
      id: row.id,
      kind: "student" as const,
      role: "STUDENT" as const,
      centerId: row.center.id,
      centerName: row.center.name,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
    })),
  ];
  return rows.sort((a, b) => a.centerName.localeCompare(b.centerName));
}

// ── Teacher portal history (U6) ─────────────────────────────────────────────

/**
 * Whether Account settings shows "History shown in my teacher portal" (U6):
 * only for a person with an active TEACHER membership at an accessible
 * branch. The person's own rows only — the same scope `recordsOnFile` reads.
 */
export async function hasTeacherMembership(db: Db, userId: string): Promise<boolean> {
  const count = await db.membership.count({
    where: { userId, role: "TEACHER", active: true, center: ACCESSIBLE_CENTER },
  });
  return count > 0;
}

export type TeacherHistoryResult = { ok: true } | { ok: false; error: "forbidden" };

/**
 * Sets the caller's own teacher-portal history preference (U6):
 * `User.teacherHistoryDays`, 0 = all history. Refused for a person with no
 * teacher membership. It writes that one column and nothing else — it never
 * widens or narrows any branch's window (lib/db/visibility.ts).
 */
export async function setTeacherHistoryDays(
  db: PrismaClient,
  userId: string,
  teacherHistoryDays: number,
): Promise<TeacherHistoryResult> {
  if (!(await hasTeacherMembership(db, userId))) return { ok: false, error: "forbidden" };
  await db.user.update({ where: { id: userId }, data: { teacherHistoryDays } });
  return { ok: true };
}
