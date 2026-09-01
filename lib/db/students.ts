import type { Prisma } from "@prisma/client";
import { normalizePhone } from "@/lib/identity";
import type { ScopedDb } from "@/lib/db/scoped";

/**
 * Student policies that are neither scoping primitives nor UI: how a student
 * code is minted, how the list is searched, and what makes a student
 * undeletable. Everything here goes through `ScopedDb`, so it is centerId
 * filtered by construction.
 */

/** Where auto-generated codes start, so they never look like a row number. */
const FIRST_STUDENT_CODE = 1001;
const CODE_ATTEMPTS = 50;

/**
 * The next free ID-card number for this center. `@@unique([centerId,
 * studentCode])` means the same number can exist in another center — codes are
 * a center's own numbering, not a platform id.
 *
 * Two receptionists registering at once can still collide on the same
 * candidate, so the caller also retries on P2002; this just makes that rare.
 */
export async function nextStudentCode(db: ScopedDb): Promise<string> {
  const used = await db.students.count();

  for (let offset = 0; offset < CODE_ATTEMPTS; offset += 1) {
    const candidate = String(FIRST_STUDENT_CODE + used + offset);
    if ((await db.students.count({ studentCode: candidate })) === 0) {
      return candidate;
    }
  }

  // Every candidate in the window was taken — fall back to something unique.
  return `${FIRST_STUDENT_CODE + used}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Reception searches by code, name or phone (spec §4.1 item 8). Each typed
 * word must match somewhere, so "ahmed 1004" finds Ahmed with code 1004.
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
          { user: { firstName: contains } },
          { user: { lastName: contains } },
          { parentFirstName: contains },
          { parentLastName: contains },
          { parentPhone: contains },
          ...(asPhone
            ? [
                { user: { phone: asPhone } },
                { parentPhone: asPhone },
              ]
            : []),
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
