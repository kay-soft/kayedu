/** One-off sweep of every leftover e2e account (`npm run e2e:clean-users`, staging only). */
import { PrismaClient } from "@prisma/client";

import { assertSafeToWrite } from "./lib/env.ts";
import { removeE2eUsers } from "./lib/e2e-users.ts";

assertSafeToWrite("npm run e2e:clean-users");
const db = new PrismaClient();
try {
  console.log(`removed ${await removeE2eUsers(db)} e2e user(s)`);
} finally {
  await db.$disconnect();
}
