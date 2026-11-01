/**
 * The phone-column report (U4, docs/01-data-model.md "Phone numbers").
 *
 *   npm run report:phones                          # dev (.env)
 *   KAYEDU_ENV=staging npm run report:phones       # staging
 *
 * SELECT-only, inside a READ ONLY transaction: it writes nothing, so it is safe
 * against dev. For every phone column it sorts the non-null values into
 *  - **E.164** — already the stored form `+20XXXXXXXXXX`;
 *  - **01…** — the pre-U4 stored form `01XXXXXXXXX`;
 *  - **punctuation** — neither, but an Egyptian mobile once spaces, dashes and
 *    a leading `+` are stripped (the seed's raw teacher numbers);
 *  - **invalid** — anything else, each printed with its row id.
 * It is the same test the U4 data migration makes before converting (that
 * migration RAISEs on any invalid value), and the post-check after it: a
 * converted database shows every non-null value as E.164.
 *
 * `User.phone` is the one unique phone column (no phone column is unique per
 * centre); the report also confirms no two of its values normalize to the
 * same E.164 number.
 */
import { PrismaClient } from "@prisma/client";

import { LEGACY_PHONE_PATTERN, MIGRATABLE_PHONE_PATTERN, STORED_PHONE_PATTERN } from "../lib/phone.ts";

const COLUMNS: readonly { table: string; column: string; unique?: boolean }[] = [
  { table: "User", column: "phone", unique: true },
  { table: "User", column: "altPhone" },
  { table: "User", column: "contactPhone" },
  { table: "Membership", column: "phone" },
  { table: "Membership", column: "altPhone" },
  { table: "StudentProfile", column: "phone" },
  { table: "StudentProfile", column: "altPhone" },
  { table: "StudentProfile", column: "parentPhone" },
  { table: "StudentProfile", column: "parentAltPhone" },
  { table: "FamilyInvitation", column: "declaredParentPhone" },
  { table: "ParentLink", column: "matchedPhone" },
];

const prisma = new PrismaClient();

type Counts = { total: bigint; e164: bigint; legacy: bigint; migratable: bigint };

/** The value with spaces, dashes and one leading `+` removed — the migration's own strip. */
const stripped = (ref: string) => `regexp_replace(regexp_replace(${ref}, '[[:space:]-]', '', 'g'), '^\\+', '')`;

async function main(): Promise<number> {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();
  console.log(`report:phones — ${process.env.KAYEDU_ENV === "staging" ? "STAGING" : "dev"} (${host}), read-only`);
  console.log(`  ${"column".padEnd(37)} ${"non-null".padStart(8)} ${"E.164".padStart(6)} ${"01…".padStart(6)} ${"punct.".padStart(6)} ${"invalid".padStart(7)}`);

  let invalid = 0;
  let notE164 = 0;
  let collisions = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    for (const { table, column, unique } of COLUMNS) {
      const ref = `"${table}"."${column}"`;
      const [counts] = await tx.$queryRawUnsafe<Counts[]>(
        `SELECT count(${ref}) AS total,
                count(*) FILTER (WHERE ${ref} ~ '${STORED_PHONE_PATTERN}') AS e164,
                count(*) FILTER (WHERE ${ref} ~ '${LEGACY_PHONE_PATTERN}') AS legacy,
                count(*) FILTER (WHERE ${stripped(ref)} ~ '${MIGRATABLE_PHONE_PATTERN}') AS migratable
           FROM "${table}"`,
      );
      const punctuation = Number(counts.migratable - counts.e164 - counts.legacy);
      const bad = Number(counts.total - counts.migratable);
      invalid += bad;
      notE164 += Number(counts.total - counts.e164);
      console.log(
        `  ${`${table}.${column}`.padEnd(37)} ${String(counts.total).padStart(8)} ${String(counts.e164).padStart(6)} ${String(counts.legacy).padStart(6)} ${String(punctuation).padStart(6)} ${String(bad).padStart(7)}`,
      );
      if (bad > 0) {
        const rows = await tx.$queryRawUnsafe<{ id: string; value: string }[]>(
          `SELECT "id", ${ref} AS value FROM "${table}"
            WHERE ${ref} IS NOT NULL AND ${stripped(ref)} !~ '${MIGRATABLE_PHONE_PATTERN}'
            ORDER BY "id" LIMIT 50`,
        );
        for (const row of rows) console.log(`      invalid ${row.id}  ${JSON.stringify(row.value)}`);
      }
      if (unique) {
        // Normalize first, then look for two rows that would end up equal.
        const [{ clashes }] = await tx.$queryRawUnsafe<{ clashes: bigint }[]>(
          `SELECT count(*) AS clashes FROM (
             SELECT '+20' || regexp_replace(${stripped(ref)}, '^(0|20)', '') AS mapped
               FROM "${table}" WHERE ${stripped(ref)} ~ '${MIGRATABLE_PHONE_PATTERN}'
              GROUP BY 1 HAVING count(*) > 1) AS dup`,
        );
        collisions += Number(clashes);
        console.log(`      unique after normalizing: ${Number(clashes) === 0 ? "yes" : `NO — ${clashes} clashing number(s)`}`);
      }
    }
  });

  if (invalid > 0 || collisions > 0) {
    console.log(`  ${invalid} invalid value(s), ${collisions} unique clash(es) — the U4 migration would RAISE`);
    return 1;
  }
  console.log(notE164 === 0 ? "  every non-null value is E.164 (+20…)" : `  ${notE164} value(s) to convert, all convertible`);
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
