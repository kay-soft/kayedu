import type { PrismaClient } from "@prisma/client";

/**
 * The live, read-only posture audit behind `npm run check:rls` and the
 * SEC-10/30/31/55/57 assertions in `npm run check:security` (SEC-2a, D-19 (a)).
 * Every query reads the Postgres catalog; nothing is written.
 *
 * The posture it proves: every table in `public` has RLS on, `public` has zero
 * policies, and the Supabase Data API roles (`anon`, `authenticated`) hold no
 * privilege on the schema, its tables, sequences or functions — now or, via
 * default privileges, later. Storage buckets are all private.
 */

export type RlsAuditResult = {
  tables: number;
  tablesWithoutRls: string[];
  publicPolicies: number;
  /** Per Data API role present in this database. */
  roles: {
    role: string;
    schemaUsage: boolean;
    tables: string[];
    sequences: string[];
    functions: string[];
  }[];
  defaultAclGrants: string[];
  /** null when there is no `storage` schema (plain Postgres, CI). */
  buckets: { id: string; public: boolean }[] | null;
  storageObjectPolicies: number | null;
  currentRole: string;
  currentRoleBypassesRls: boolean;
};

export const EXPECTED_BUCKETS = ["avatars", "id-cards", "logos", "session-uploads"] as const;

export async function auditRls(prisma: PrismaClient): Promise<RlsAuditResult> {
  const tables = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;

  const [{ count: publicPolicies }] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`;

  const presentRoles = await prisma.$queryRaw<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`;

  const roles: RlsAuditResult["roles"] = [];
  for (const { rolname } of presentRoles) {
    const [{ usage }] = await prisma.$queryRaw<{ usage: boolean }[]>`
      SELECT has_schema_privilege(${rolname}, 'public', 'USAGE') AS usage`;
    const tableGrants = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(${rolname}, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`;
    const sequenceGrants = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
        -- CASE, not AND: the planner may evaluate the privilege function on
        -- non-sequence rows first, and it errors on anything but a sequence.
        AND CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege(${rolname}, c.oid, 'USAGE,SELECT,UPDATE')
              ELSE false END`;
    const functionGrants = await prisma.$queryRaw<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND has_function_privilege(${rolname}, p.oid, 'EXECUTE')`;
    roles.push({
      role: rolname,
      schemaUsage: usage,
      tables: tableGrants.map((row) => row.relname),
      sequences: sequenceGrants.map((row) => row.relname),
      functions: functionGrants.map((row) => row.proname),
    });
  }

  const defaultAcls = await prisma.$queryRaw<{ owner: string; objtype: string; acl: string }[]>`
    SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public'`;
  const defaultAclGrants = defaultAcls
    .filter((row) => /(^|[{,])(anon|authenticated)=/.test(row.acl))
    .map((row) => `${row.owner}:${row.objtype}:${row.acl}`);

  const [{ hasStorage }] = await prisma.$queryRaw<{ hasStorage: boolean }[]>`
    SELECT to_regclass('storage.buckets') IS NOT NULL AS "hasStorage"`;
  let buckets: RlsAuditResult["buckets"] = null;
  let storageObjectPolicies: number | null = null;
  if (hasStorage) {
    buckets = await prisma.$queryRaw<{ id: string; public: boolean }[]>`
      SELECT id, public FROM storage.buckets ORDER BY id`;
    const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'`;
    storageObjectPolicies = count;
  }

  const [me] = await prisma.$queryRaw<{ rolname: string; rolbypassrls: boolean }[]>`
    SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

  return {
    tables: tables.length,
    tablesWithoutRls: tables.filter((row) => !row.relrowsecurity).map((row) => row.relname).sort(),
    publicPolicies,
    roles,
    defaultAclGrants,
    buckets,
    storageObjectPolicies,
    currentRole: me?.rolname ?? "unknown",
    currentRoleBypassesRls: me?.rolbypassrls ?? false,
  };
}

/** Every reason the posture is not deny-all — empty means it holds. */
export function rlsProblems(result: RlsAuditResult): string[] {
  const problems: string[] = [];
  if (result.tables === 0) problems.push("no tables found in public");
  if (result.tablesWithoutRls.length > 0) {
    problems.push(`RLS off on: ${result.tablesWithoutRls.join(", ")}`);
  }
  if (result.publicPolicies > 0) problems.push(`${result.publicPolicies} policy(ies) on public (expected 0)`);
  for (const role of result.roles) {
    if (role.schemaUsage) problems.push(`${role.role} has USAGE on schema public`);
    if (role.tables.length > 0) problems.push(`${role.role} has privileges on: ${role.tables.join(", ")}`);
    if (role.sequences.length > 0) problems.push(`${role.role} has privileges on sequences: ${role.sequences.join(", ")}`);
    if (role.functions.length > 0) problems.push(`${role.role} can execute: ${role.functions.join(", ")}`);
  }
  if (result.defaultAclGrants.length > 0) {
    problems.push(`default privileges still grant: ${result.defaultAclGrants.join(" | ")}`);
  }
  if (result.buckets) {
    const publicBuckets = result.buckets.filter((bucket) => bucket.public).map((bucket) => bucket.id);
    if (publicBuckets.length > 0) problems.push(`public buckets: ${publicBuckets.join(", ")}`);
    const missing = EXPECTED_BUCKETS.filter((id) => !result.buckets!.some((bucket) => bucket.id === id));
    if (missing.length > 0) problems.push(`missing buckets: ${missing.join(", ")}`);
  }
  if (result.storageObjectPolicies !== null && result.storageObjectPolicies > 0) {
    problems.push(`${result.storageObjectPolicies} policy(ies) on storage.objects (expected 0 — service-role only)`);
  }
  return problems;
}
