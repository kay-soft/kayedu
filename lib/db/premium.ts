import type { Prisma, PrismaClient } from "@prisma/client";

import {
  isPremium,
  premiumEndDayError,
  premiumUntilForDay,
  type PremiumDateError,
} from "../auth/premium.ts";
import { normalizeEmail } from "../identity.ts";
import { writeAuditRow } from "./audit-row.ts";
import { isPlatformAdminUser } from "./catalog-admin.ts";
import { runInTransaction } from "./session-lifecycle.ts";

/**
 * The platform admin's premium control (W6, D-W14, D-W35) — **the only code
 * that writes `User.premiumUntil`**. Every function starts by loading the
 * acting user fresh and refusing `forbidden` unless they are a platform admin,
 * whatever the caller checked first: a centre owner, a teacher or anyone else
 * calling it directly gets nothing, not even whether the email exists. The
 * Server Actions in `app/[locale]/(admin)/admin/teachers/actions.ts` also run
 * `requirePlatformAdmin()`; this is the second, structural lock (the
 * `lib/db/catalog-admin.ts` shape).
 *
 * - **Lookup** is by exact email only (trimmed, lower-cased — the one
 *   `normalizeEmail`, the rule every stored email was written under). No list,
 *   no partial match, no browsing. An unknown email is `account: null`, one
 *   neutral answer.
 * - **Grant** (not premium now — never premium, or expired), **Extend**
 *   (premium now, and the new end strictly later than the current one) and
 *   **Revoke** (any stored end → null). The end date follows
 *   `premiumEndDayError` (today or later, ≤ 400 days ahead, Cairo).
 * - Each write is one transaction: re-check → conditional update (lost to a
 *   concurrent change → `stale`, nothing written) → `AuditLog`
 *   `platform.premium.grant|extend|revoke`, no centre (premium belongs to no
 *   tenant), carrying the user's id and the new end instant only — never the
 *   email or a name (D-20).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PremiumAccount = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  premiumUntil: Date | null;
};

export type PremiumLookupResult = { ok: true; account: PremiumAccount | null } | { ok: false; error: "forbidden" };

export type PremiumWriteError =
  | "forbidden"
  | "accountNotFound"
  | "alreadyPremium"
  | "notPremium"
  | "notLater"
  | "stale"
  | PremiumDateError;

export type PremiumWriteResult = { ok: true; account: PremiumAccount } | { ok: false; error: PremiumWriteError };

export const PREMIUM_AUDIT_ACTIONS = {
  grant: "platform.premium.grant",
  extend: "platform.premium.extend",
  revoke: "platform.premium.revoke",
} as const;

const ACCOUNT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  premiumUntil: true,
} as const;

function toAccount(row: { id: string; firstName: string; lastName: string; email: string | null; premiumUntil: Date | null }): PremiumAccount {
  return { userId: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, premiumUntil: row.premiumUntil };
}

/** One account by its exact email, for a platform admin; `null` for no match (or a blank email). */
export async function findPremiumAccountByEmail(
  db: Db,
  input: { actorUserId: string | null | undefined; email: string },
): Promise<PremiumLookupResult> {
  if (!(await isPlatformAdminUser(db, input.actorUserId))) return { ok: false, error: "forbidden" };
  const email = normalizeEmail(input.email);
  if (!email) return { ok: true, account: null };
  const row = await db.user.findUnique({ where: { email }, select: ACCOUNT_SELECT });
  return { ok: true, account: row ? toAccount(row) : null };
}

/** One account by id, for a platform admin — the page's re-read after a write or a refusal. */
export async function findPremiumAccountById(
  db: Db,
  input: { actorUserId: string | null | undefined; userId: string },
): Promise<PremiumLookupResult> {
  if (!(await isPlatformAdminUser(db, input.actorUserId))) return { ok: false, error: "forbidden" };
  const row = await db.user.findUnique({ where: { id: input.userId }, select: ACCOUNT_SELECT });
  return { ok: true, account: row ? toAccount(row) : null };
}

type Kind = keyof typeof PREMIUM_AUDIT_ACTIONS;

async function writePremium(
  db: Db,
  kind: Kind,
  input: { actorUserId: string | null | undefined; userId: string; endDay?: string; now?: Date },
): Promise<PremiumWriteResult> {
  const now = input.now ?? new Date();
  return runInTransaction(db, async (tx): Promise<PremiumWriteResult> => {
    if (!(await isPlatformAdminUser(tx, input.actorUserId))) return { ok: false, error: "forbidden" };

    let next: Date | null = null;
    if (kind !== "revoke") {
      const dateError = premiumEndDayError(input.endDay ?? "", now);
      if (dateError) return { ok: false, error: dateError };
      next = premiumUntilForDay(input.endDay!);
    }

    const current = await tx.user.findUnique({ where: { id: input.userId }, select: { premiumUntil: true } });
    if (!current) return { ok: false, error: "accountNotFound" };
    const active = isPremium(current, now);
    if (kind === "grant" && active) return { ok: false, error: "alreadyPremium" };
    if (kind === "extend") {
      if (!active) return { ok: false, error: "notPremium" };
      if (next!.getTime() <= current.premiumUntil!.getTime()) return { ok: false, error: "notLater" };
    }
    if (kind === "revoke" && current.premiumUntil === null) return { ok: false, error: "notPremium" };

    // Conditional on the value just read: a concurrent change makes this a no-op.
    const { count } = await tx.user.updateMany({
      where: { id: input.userId, premiumUntil: current.premiumUntil },
      data: { premiumUntil: next },
    });
    if (count !== 1) return { ok: false, error: "stale" };

    await writeAuditRow(tx, {
      centerId: null,
      actorUserId: input.actorUserId ?? null,
      action: PREMIUM_AUDIT_ACTIONS[kind],
      entityType: "User",
      entityId: input.userId,
      after: { premiumUntil: next ? next.toISOString() : null },
    });

    const row = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: ACCOUNT_SELECT });
    return { ok: true, account: toAccount(row) };
  });
}

/** Grant premium to an account that is not premium now, until the end of `endDay` (Cairo). */
export function grantPremium(
  db: Db,
  input: { actorUserId: string | null | undefined; userId: string; endDay: string; now?: Date },
): Promise<PremiumWriteResult> {
  return writePremium(db, "grant", input);
}

/** Move a premium account's end to a strictly later `endDay`. */
export function extendPremium(
  db: Db,
  input: { actorUserId: string | null | undefined; userId: string; endDay: string; now?: Date },
): Promise<PremiumWriteResult> {
  return writePremium(db, "extend", input);
}

/** End premium now: `premiumUntil` → null. */
export function revokePremium(
  db: Db,
  input: { actorUserId: string | null | undefined; userId: string; now?: Date },
): Promise<PremiumWriteResult> {
  return writePremium(db, "revoke", input);
}
