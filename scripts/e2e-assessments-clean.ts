/**
 * Sweeps every assessment the e2e suite left behind (a killed run):
 * `KAYEDU_ENV=staging npm run e2e:clean-assessments`. A test removes its own when
 * it ends; this is the backstop. Refuses to run against the dev project (S1).
 */
import { PrismaClient } from "@prisma/client";

import { removeE2eAssessments } from "./lib/e2e-assessments.ts";
import { assertSafeToWrite } from "./lib/env.ts";

assertSafeToWrite("npm run e2e:clean-assessments");
const prisma = new PrismaClient();
try {
  const removed = await removeE2eAssessments(prisma);
  console.log(`Removed ${removed.assessments} assessment(s), ${removed.attempts} attempt(s), ${removed.auditRows} audit row(s).`);
} finally {
  await prisma.$disconnect();
}
