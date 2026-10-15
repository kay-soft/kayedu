/**
 * Regenerates the accounts table in docs/dev-accounts.md from the seed's
 * blueprint (`prisma/seed-data/plan.ts`) and the configured
 * `SEED_EMAIL_DOMAIN` — so the doc always lists the addresses the seed will
 * really create. Touches only the text between the two marker comments.
 *
 *   npm run seed:docs
 *
 * Needs no database and no network. `seed:verify` fails if the doc and the
 * configured domain disagree and points here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_EMAIL_DOMAIN } from "../prisma/seed-data/domain.ts";
import { seedAccounts } from "../prisma/seed-data/plan.ts";

const START = "<!-- accounts:start -->";
const END = "<!-- accounts:end -->";
const file = join(import.meta.dirname, "..", "docs", "dev-accounts.md");

const rows = seedAccounts().map(
  (account) => `| \`${account.email}\` | ${account.first} ${account.last} | ${account.role} | ${account.centre} |`,
);
const table = ["| Email | Person | Role | Centre |", "|---|---|---|---|", ...rows].join("\n");

const doc = readFileSync(file, "utf8");
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a === -1 || b === -1 || b < a) {
  console.error(`docs/dev-accounts.md is missing the ${START} / ${END} markers.`);
  process.exit(1);
}
const next = `${doc.slice(0, a + START.length)}\n${table}\n${doc.slice(b)}`;
writeFileSync(file, next);
console.log(`docs/dev-accounts.md: ${rows.length} accounts at @${SEED_EMAIL_DOMAIN}${next === doc ? " (already up to date)" : " (updated)"}`);
