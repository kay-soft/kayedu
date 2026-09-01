import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export type AuditInput = {
  /** null only for platform-level actions that belong to no tenant. */
  centerId: string | null;
  actorUserId: string | null;
  /** Dotted action name, e.g. "invitation.create", "membership.create". */
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
};

/**
 * Financial changes, permission changes and attendance corrections MUST write
 * an audit row (CLAUDE.md rule 7, docs/01-data-model.md §2).
 */
export async function writeAuditLog(input: AuditInput) {
  return prisma.auditLog.create({
    data: {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
    },
  });
}
