/**
 * `npm run db:migrate` used to run `prisma migrate dev` against the `.env`
 * database — the shared dev Supabase project. `migrate dev` uses a shadow
 * database and offers to RESET the schema when it detects drift, which is
 * exactly what CLAUDE.md working rule 7 forbids (a shadow-DB diff against that
 * URL wiped it once, in R4). SEC-2a (SEC-39): the script now refuses and says
 * what to do instead.
 */
console.error(
  [
    "",
    "npm run db:migrate is disabled (SEC-39, CLAUDE.md rule 7).",
    "",
    "  • Apply committed migrations:   npx prisma migrate deploy",
    "  • Write a new migration by hand under prisma/migrations/<timestamp>_<name>/migration.sql.",
    "    To draft its SQL without touching any database:",
    "      npx prisma migrate diff --from-schema-datamodel <old schema> --to-schema-datamodel prisma/schema.prisma --script",
    "    or, read-only against the dev database:",
    "      npx prisma migrate diff --from-url \"$DATABASE_URL\" --to-schema-datamodel prisma/schema.prisma --script",
    "",
    "Never run migrate dev / migrate reset / db push against a URL from .env.",
    "",
  ].join("\n"),
);
process.exit(1);
