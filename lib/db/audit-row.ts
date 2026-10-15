import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The one writer of `AuditLog` rows (SEC-2b). Relative-import-safe — the money
 * modules (lib/db/payments.ts, settlements.ts, attendance.ts …) and the gates
 * call it outside the Next.js runtime; `lib/db/audit.ts`'s `writeAuditLog` is
 * the app-side wrapper over the shared client.
 *
 * Two rules live here:
 * - **SEC-60:** it takes the caller's transaction client, so an audit row
 *   lands in the same transaction as the money change it records — a void can
 *   never commit without its row. The table itself is append-only (a trigger,
 *   migration `20261018090000_sec2b_money_integrity`).
 * - **D-20:** a row carries ids, amounts, counts, statuses/enums, booleans and
 *   dates — never a person's name or contact, and never text someone typed
 *   (a reason, a note, a title, a label). Those live on the record itself
 *   (`Payment.voidReason`, `SessionAttendanceChange.reason`, `Refund.reason`,
 *   `Expense.voidReason`, `StudentBlock.reason` …), which the centre audit
 *   screen reads beside the row. A payload carrying one of the keys below is
 *   refused — thrown, so the surrounding transaction rolls back rather than
 *   storing it. **Exempt:** `platform.catalog.*` rows (no centre), whose
 *   `nameAr`/`nameEn` are the platform's own reference catalog, not a centre's
 *   people or anyone's free text (SEC-2b decision, recorded in docs/00 §5.1).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AuditRowInput = {
  /** null only for platform-level actions that belong to no tenant. */
  centerId: string | null;
  actorUserId: string | null;
  /** Dotted action name, e.g. "payment.void", "settlement.approve". */
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
};

/** Keys an audit payload may never carry, at any depth (D-20). */
export const FORBIDDEN_AUDIT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "firstName",
  "lastName",
  "fullName",
  "studentName",
  "teacherName",
  "className",
  "gradeName",
  "email",
  "phone",
  "altPhone",
  "parentPhone",
  "parentAltPhone",
  "reason",
  "voidReason",
  "note",
  "notes",
  "description",
  "title",
  "label",
  "methodLabelSnapshot",
  "displayNameAr",
  "displayNameEn",
]);

/** Actions whose rows are platform reference data, not a centre's audit trail. */
const EXEMPT_ACTION_PREFIXES = ["platform.catalog."];

export class AuditPayloadError extends Error {
  constructor(action: string, key: string) {
    super(`Audit row "${action}" may not carry "${key}" (D-20: ids and amounts only).`);
    this.name = "AuditPayloadError";
  }
}

/** The first forbidden key anywhere in `value`, or null. */
export function forbiddenAuditKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = forbiddenAuditKey(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_AUDIT_KEYS.has(key)) return key;
      const found = forbiddenAuditKey(inner);
      if (found) return found;
    }
  }
  return null;
}

/** Throws `AuditPayloadError` when a payload breaks D-20. */
export function assertAuditPayload(input: Pick<AuditRowInput, "action" | "before" | "after">): void {
  if (EXEMPT_ACTION_PREFIXES.some((prefix) => input.action.startsWith(prefix))) return;
  const key = forbiddenAuditKey(input.before) ?? forbiddenAuditKey(input.after);
  if (key) throw new AuditPayloadError(input.action, key);
}

/** The `data` of one AuditLog create, checked. */
export function auditRowData(input: AuditRowInput): Prisma.AuditLogUncheckedCreateInput {
  assertAuditPayload(input);
  return {
    centerId: input.centerId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? undefined,
    after: input.after ?? undefined,
  };
}

/** Writes one audit row on `db` — pass the money transaction's client (SEC-60). */
export function writeAuditRow(db: Db, input: AuditRowInput) {
  return db.auditLog.create({ data: auditRowData(input) });
}
