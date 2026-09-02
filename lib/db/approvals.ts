import type { ChangeRequest, ChangeRequestStatus, Prisma, PrismaClient } from "@prisma/client";
// Relative imports on purpose — `npm run check:approvals` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/reservations.ts and lib/db/payments.ts).
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The Approvals screen's write path for `ChangeRequest` (M6/M7 gap, closed at
 * this milestone — docs/00-master-product-spec.md §4.1 item 9). A plain
 * status flip, unlike `Reservation`'s `confirmReservation` — accepting a
 * `NEW_CLASS` request does **not** create a `ClassGroup`: the request payload
 * (subject/grade/day/time/capacity/attendance settings, `lib/validation/
 * teacher.ts`'s `classRequestSchema`) is missing fields a real class needs
 * (price, center-cut config, room) that only a center decides, so
 * auto-creating one would have to guess at money — never acceptable
 * (CLAUDE.md rule 2). Accepting here means "yes, go create this class" and
 * staff do that manually at `/classes`, reading the approved request's
 * details off this screen. Never `UPDATE`s in place without a status check —
 * a request already resolved cannot be re-resolved.
 *
 * Takes `centerId`/`db` explicitly rather than `ScopedDb`, exactly like
 * `lib/db/reservations.ts`'s `confirmReservation`/`rejectReservation` and
 * `lib/db/payments.ts`'s `recordPayment`/`voidPayment` — the caller (the
 * Server Action) writes the `AuditLog` row afterward (CLAUDE.md rule 7),
 * this function does not.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const PENDING: ChangeRequestStatus = "PENDING";

export type ResolveChangeRequestResult =
  | { ok: true; changeRequest: ChangeRequest }
  | { ok: false; error: "notFound" | "notPending" };

export async function resolveChangeRequest(
  db: Db,
  centerId: string,
  changeRequestId: string,
  decision: Exclude<ChangeRequestStatus, "PENDING">,
  resolvedBy: string,
): Promise<ResolveChangeRequestResult> {
  const existing = await db.changeRequest.findFirst({
    where: scopedWhere(centerId, { id: changeRequestId }),
  });
  if (!existing) return { ok: false, error: "notFound" };
  if (existing.status !== PENDING) return { ok: false, error: "notPending" };

  const updated = await db.changeRequest.update({
    where: { id: changeRequestId },
    data: { status: decision, resolvedBy, resolvedAt: new Date() },
  });
  return { ok: true, changeRequest: updated };
}
