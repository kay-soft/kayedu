import { catalogNameKey } from "./catalog.ts";

/**
 * Typed text against Postgres `LIKE` (SEC-2c, SEC-61). Prisma's `contains` and
 * case-insensitive `equals` compile to `ILIKE` without escaping `%` or `_`, so
 * `%` matched every row and `_` any one character — `Cash_` was refused as a
 * duplicate of `Cash1`. They cannot be escaped through Prisma either: a
 * backslash escape does not survive its model layer (probed at SEC-2c — the
 * same pattern matches through `$queryRaw` and matches nothing through a model
 * query). So the two uses are handled the two ways that work:
 *
 * - a **search token** has the pattern characters removed (`likeSearchToken`)
 *   — no name, student code or phone contains them, so nothing findable is
 *   lost, and a token of only `%`/`_` searches for nothing;
 * - a **duplicate-name check** never uses `LIKE` at all: it compares the
 *   centre's existing names in memory by the one name key (`nameClashes`,
 *   `catalogNameKey` — trimmed, inner spaces collapsed, lower-cased), as the
 *   platform catalog's own duplicate check already did.
 */
export function likeSearchToken(value: string): string {
  return value.replace(/[\\%_]/g, "");
}

/** Whether `name` duplicates one of `existing` by the one name key. */
export function nameClashes(name: string, existing: readonly { name: string }[]): boolean {
  const key = catalogNameKey(name);
  return existing.some((row) => catalogNameKey(row.name) === key);
}
