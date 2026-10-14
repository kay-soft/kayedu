/**
 * `npm run gates:users -- record` / `-- verify` (SEC-2c) — the run-level
 * user-leak check, split in two so CI can record before its first gate step
 * and verify after its last. `npm run check:all` does both itself.
 */
import { PrismaClient } from "@prisma/client";

import { describeUserLeak, recordUserBaseline, verifyUserBaseline, BASELINE_FILE } from "./lib/gate-users.ts";

const prisma = new PrismaClient();
const mode = process.argv[2];

async function main() {
  if (mode === "record") {
    const baseline = await recordUserBaseline(prisma);
    console.log(`User rows before the gate run: ${baseline.count} (baseline written to ${BASELINE_FILE})`);
    return;
  }
  if (mode === "verify") {
    const result = await verifyUserBaseline(prisma);
    const message = describeUserLeak(result);
    if (result.ok) console.log(message);
    else {
      console.error(message);
      process.exitCode = 1;
    }
    return;
  }
  console.error('Usage: npm run gates:users -- record|verify');
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
