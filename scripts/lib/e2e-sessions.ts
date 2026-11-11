/**
 * The one-time sessions the e2e suite inserts (V9), and the one way to remove them
 * again. Each is titled `<tag>-…`, the tag from `uniqueTag(E2E_USER_PREFIX)` (the
 * shared e2e prefix), and has no class (`classGroupId` null), so deleting by that
 * shape cannot reach a seeded or gate row: seed sessions belong to classes or carry
 * seed titles, and gate fixtures live in their own `<gate>-check` centres.
 *
 * Staging-guarded: it refuses unless the run may write (S1, docs/staging.md).
 */
import type { PrismaClient } from "@prisma/client";

import { deleteAuditRows } from "./audit-maintenance.ts";
import { assertSafeToWrite } from "./env.ts";
import { E2E_USER_PREFIX } from "./e2e-users.ts";

/** Every one-time session titled `<needle>…`; with no needle, every e2e one. */
export function e2eOneOffSessionWhere(needle: string = E2E_USER_PREFIX) {
  if (!needle.startsWith(E2E_USER_PREFIX)) throw new Error(`e2e sessions: "${needle}" is not an e2e tag`);
  return { classGroupId: null, title: { startsWith: needle } };
}

export async function removeE2eOneOffSessions(db: PrismaClient, needle: string = E2E_USER_PREFIX): Promise<number> {
  assertSafeToWrite("the e2e session teardown");
  const rows = await db.session.findMany({ where: e2eOneOffSessionWhere(needle), select: { id: true } });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  await deleteAuditRows(db, { entityType: "Session", entityId: { in: ids } });
  // Rooms, attendance and payments cascade with the session; a fixture has none.
  const removed = await db.session.deleteMany({ where: { id: { in: ids } } });
  return removed.count;
}
