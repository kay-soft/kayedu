/**
 * The assessments the e2e suite creates, and the one way to remove them again.
 *
 * Every title starts with `E2E_ASSESSMENT_PREFIX` (registered once, in
 * `scripts/lib/gate-fixtures.ts`), followed by the test's own tag, so one project's
 * teardown cannot touch a test still running in another. Deleting by prefix removes
 * attempts first, then their audit rows and the assessment's, then the assessment
 * (questions and options cascade), so a second run leaves the same row counts.
 *
 * Staging-guarded: it refuses unless the run may write (S1, docs/staging.md).
 */
import type { PrismaClient } from "@prisma/client";

import { assertSafeToWrite } from "./env.ts";
import { deleteAuditRows } from "./audit-maintenance.ts";
import { E2E_ASSESSMENT_PREFIX } from "./gate-fixtures.ts";

export { E2E_ASSESSMENT_PREFIX };

export type RemovedE2eAssessments = { assessments: number; attempts: number; auditRows: number };

/** Everything titled `<prefix><tag>…`; with no tag, every e2e assessment. */
export async function removeE2eAssessments(db: PrismaClient, tag = ""): Promise<RemovedE2eAssessments> {
  assertSafeToWrite("the e2e assessment teardown");
  const assessments = await db.assessment.findMany({
    where: { title: { startsWith: `${E2E_ASSESSMENT_PREFIX}${tag}` } },
    select: { id: true },
  });
  const assessmentIds = assessments.map((row) => row.id);
  if (assessmentIds.length === 0) return { assessments: 0, attempts: 0, auditRows: 0 };

  const attempts = await db.assessmentAttempt.findMany({ where: { assessmentId: { in: assessmentIds } }, select: { id: true } });
  const attemptIds = attempts.map((row) => row.id);
  await db.assessmentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
  const auditRows = await deleteAuditRows(db, {
    OR: [
      { entityType: "AssessmentAttempt", entityId: { in: attemptIds } },
      { entityType: "Assessment", entityId: { in: assessmentIds } },
    ],
  });
  await db.assessment.deleteMany({ where: { id: { in: assessmentIds } } });
  return { assessments: assessmentIds.length, attempts: attemptIds.length, auditRows };
}
