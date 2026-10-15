/**
 * Test cleanup for `AuditLog`, which is append-only since SEC-2b (SEC-60): a
 * trigger refuses every DELETE unless the transaction opts in with
 * `kayedu.audit_maintenance = 'on'` (transaction-local). Only the gate
 * scripts' own throwaway fixtures are ever deleted through here — nothing in
 * the app deletes an audit row, and the shared dev data is never touched.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export async function deleteAuditRows(
  prisma: PrismaClient,
  where: Prisma.AuditLogWhereInput,
): Promise<number> {
  const [, deleted] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('kayedu.audit_maintenance', 'on', true)`,
    prisma.auditLog.deleteMany({ where }),
  ]);
  return deleted.count;
}
