import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { writeAuditRow, type AuditRowInput } from "@/lib/db/audit-row";

export type AuditInput = AuditRowInput;

/**
 * Financial changes, permission changes and attendance corrections MUST write
 * an audit row (CLAUDE.md rule 7, docs/01-data-model.md §2). Pass the money
 * transaction's client as `db` so the row commits with the change it records
 * (SEC-60); the payload rule (ids and amounts only, D-20) is
 * lib/db/audit-row.ts's.
 */
export async function writeAuditLog(
  input: AuditInput,
  db: PrismaClient | Prisma.TransactionClient = prisma,
) {
  return writeAuditRow(db, input);
}
