/**
 * The one entry point behind every `npm run` script that needs the project's
 * environment (S1). It loads it through `scripts/lib/env.ts`, then either
 *
 *   node scripts/with-env.ts scripts/foo-check.ts [args]   runs the script in this process
 *   node scripts/with-env.ts --exec prisma migrate deploy  runs a command with that environment
 *   node scripts/with-env.ts --staging …                   same, forcing KAYEDU_ENV=staging
 *
 * `KAYEDU_ENV=staging` (or `--staging`) reads `.env.staging` instead of `.env`.
 * The write-guard is not here: it lives in `assertSafeToWrite`, called by the
 * things that write, so a gate run any other way is fenced just the same.
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadEnv } from "./lib/env.ts";

const args = process.argv.slice(2);
if (args[0] === "--staging") {
  process.env.KAYEDU_ENV = "staging";
  args.shift();
}
loadEnv();

if (args[0] === "--exec") {
  const [command, ...rest] = args.slice(1);
  if (!command) {
    console.error("Usage: node scripts/with-env.ts [--staging] --exec <command> [args…]");
    process.exit(1);
  }
  const child = spawn(command, rest, { stdio: "inherit", shell: process.platform === "win32", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (args[0]) {
  // Present the script to itself as the entry point: gate-db names a gate after argv[1], gates:users reads argv[2].
  const target = args[0];
  process.argv = [process.argv[0], target, ...args.slice(1)];
  await import(pathToFileURL(target).href);
} else {
  console.error("Usage: node scripts/with-env.ts [--staging] <script.ts> | --exec <command> [args…]");
  process.exit(1);
}
