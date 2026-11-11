import type { EnrollmentStatus, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assistants` calls these
// outside the Next.js runtime.
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The assistant's read-only views of the teacher's PERSONAL workspace (W8d,
 * D-W41 items 9, 10). Every function takes the workspace's centre id, which
 * the caller took from the assistant's scope — the teacher's own workspaces,
 * resolved from the teacher's id (`resolveAssistantActing`) — never from a
 * request. Reads only; scoped by `centerId` (tenant rule 1).
 *
 * **Phones (item 9).** A roster row carries the student's phone in the
 * workspace's own record only when the caller passes `withPhones` — an
 * assistant granted `students.phones` there (`assistantCan`). Otherwise the
 * phone is not even selected, so it can never reach the page.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE: EnrollmentStatus = "ACTIVE";

export type AssistantWorkspaceRosterRow = {
  studentProfileId: string;
  firstName: string;
  lastName: string;
  studentCode: string;
  /** Present only when read `withPhones`. */
  phone?: string | null;
};

/** A workspace class's ACTIVE roster, names (and phones only when allowed), by name. */
export async function assistantWorkspaceClassRoster(
  db: Db,
  centerId: string,
  classGroupId: string,
  options: { withPhones: boolean },
): Promise<AssistantWorkspaceRosterRow[]> {
  const rows = await db.enrollment.findMany({
    where: scopedWhere(centerId, { classGroupId, status: ACTIVE, studentProfile: { active: true } }),
    select: {
      studentProfile: {
        select: { id: true, firstName: true, lastName: true, studentCode: true, phone: options.withPhones },
      },
    },
  });
  return rows
    .map(({ studentProfile: profile }) => ({
      studentProfileId: profile.id,
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      studentCode: profile.studentCode,
      ...(options.withPhones ? { phone: (profile as { phone?: string | null }).phone ?? null } : {}),
    }))
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
}
