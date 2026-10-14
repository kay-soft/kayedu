import type { Prisma, PrismaClient, User } from "@prisma/client";
import { z } from "zod";

// Relative imports only: this is the pure half of `lib/auth/session.ts` —
// "which app `User` is this login?" — kept loadable outside Next so
// `npm run check:security` runs the REAL linking rule, not a copy of it.
import { normalizeEmail } from "../identity.ts";
import {
  AuthMisconfiguredError,
  isProductionDeployment,
  requireEmailConfirmation,
} from "./auth-config.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Env = Record<string, string | undefined>;

/** The slice of a Supabase auth user this module reads. */
export type AuthIdentity = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/**
 * What a login resolves to (SEC-2a, D-01):
 * - `user` — the app `User` this login is linked to (created on first sight
 *   when nobody holds its email);
 * - `unconfirmed` — `REQUIRE_EMAIL_CONFIRMATION=true` and Supabase has not
 *   confirmed the email: no app `User` at all, nothing created or linked;
 * - `claimPending` — the email belongs to a person a centre created who has
 *   never signed in. **Never auto-linked**: a PENDING `AccountClaim` waits for
 *   staff to approve it in person, and until then this login has no app user;
 * - `blocked` — the email is already held by a different login's user.
 */
export type AppIdentity =
  | { kind: "user"; user: User }
  | { kind: "unconfirmed" }
  | { kind: "claimPending"; claimId: string }
  | { kind: "blocked" };

/**
 * Sign-up metadata is client-controlled (a direct GoTrue sign-up skips the
 * app's form), so it is parsed, trimmed and capped like any other input
 * (SEC-41). A phone in the metadata is ignored outright: a self-typed phone
 * is never stored on the global identity (D-02).
 */
const capped = (max: number) =>
  z
    .string()
    .catch("")
    .transform((value) => value.trim().slice(0, max));
const metadataSchema = z.object({
  first_name: capped(60).optional(),
  last_name: capped(60).optional(),
  full_name: capped(121).optional(),
  locale: z.enum(["ar", "en"]).catch("ar").optional(),
});

export function profileFromMetadata(identity: AuthIdentity): {
  firstName: string;
  lastName: string;
  locale: "ar" | "en";
} {
  const parsed = metadataSchema.safeParse(identity.user_metadata ?? {});
  const meta = parsed.success ? parsed.data : {};
  const locale = meta.locale ?? "ar";
  const first = meta.first_name ?? "";
  const last = meta.last_name ?? "";
  if (first || last) return { firstName: first || "-", lastName: last || "-", locale };

  const full = meta.full_name ?? "";
  if (full) {
    const [head, ...rest] = full.split(/\s+/);
    return { firstName: head.slice(0, 60), lastName: rest.join(" ").slice(0, 60) || "-", locale };
  }

  const local = (identity.email?.split("@")[0] ?? "user").slice(0, 60);
  return { firstName: local || "user", lastName: "-", locale };
}

function confirmedAt(identity: AuthIdentity): Date | null {
  if (!identity.email_confirmed_at) return null;
  const date = new Date(identity.email_confirmed_at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Resolves a Supabase login to its app identity (docs/02 §3, SEC-2a).
 *
 * Linking rules — the only place they live:
 * 1. A login already linked (`User.authId`) is that user. Its email is synced
 *    only when (under REQUIRE_EMAIL_CONFIRMATION) the new email is confirmed
 *    and no other person holds it; `emailVerifiedAt` mirrors Supabase.
 * 2. A login whose email equals a person a centre created (`authId` null) is
 *    **never** linked here — not by email, not by phone, confirmed or not
 *    (D-01). It opens a PENDING claim; staff approve it in person
 *    (`lib/db/account-claims.ts`). This holds even when the project
 *    auto-confirms every sign-up, which is exactly the dev configuration.
 * 3. Otherwise a new `User` is created for the login.
 */
export async function resolveAppIdentity(
  db: Db,
  identity: AuthIdentity,
  env: Env = process.env,
): Promise<AppIdentity> {
  const mustConfirm = requireEmailConfirmation(env);
  if (isProductionDeployment(env) && !mustConfirm) {
    throw new AuthMisconfiguredError('REQUIRE_EMAIL_CONFIRMATION is not "true"');
  }

  const email = normalizeEmail(identity.email);
  const confirmed = confirmedAt(identity);
  if (mustConfirm && !confirmed) return { kind: "unconfirmed" };

  const linked = await db.user.findUnique({ where: { authId: identity.id } });
  if (linked) return { kind: "user", user: await syncLinkedUser(db, linked, email, confirmed) };

  if (email) {
    const holder = await db.user.findUnique({ where: { email } });
    if (holder) {
      if (holder.authId) return { kind: "blocked" };
      const claim = await db.accountClaim.upsert({
        where: { authId_targetUserId: { authId: identity.id, targetUserId: holder.id } },
        create: { authId: identity.id, email, targetUserId: holder.id },
        update: {},
      });
      if (claim.status === "PENDING") return { kind: "claimPending", claimId: claim.id };
      // Approved: the target is linked by now (rule 1 answers next time).
      // Rejected but the email is still on the target: nothing to create.
      return { kind: "blocked" };
    }
  }

  const profile = profileFromMetadata(identity);
  try {
    const user = await db.user.create({
      data: {
        authId: identity.id,
        email,
        emailVerifiedAt: confirmed,
        phone: null,
        firstName: profile.firstName,
        lastName: profile.lastName,
        locale: profile.locale,
      },
    });
    return { kind: "user", user };
  } catch (error) {
    // Two first requests of the same login racing: the other one created it.
    if (!isUniqueViolation(error)) throw error;
    const winner = await db.user.findUnique({ where: { authId: identity.id } });
    if (winner) return { kind: "user", user: winner };
    return { kind: "blocked" };
  }
}

async function syncLinkedUser(
  db: Db,
  user: User,
  email: string | null,
  confirmed: Date | null,
): Promise<User> {
  const data: Prisma.UserUpdateInput = {};
  if (email && user.email !== email) {
    const taken = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!taken) {
      data.email = email;
      data.emailVerifiedAt = confirmed;
    }
  } else if (email && user.email === email) {
    const current = user.emailVerifiedAt?.getTime() ?? null;
    if ((confirmed?.getTime() ?? null) !== current) data.emailVerifiedAt = confirmed;
  }
  if (Object.keys(data).length === 0) return user;
  return db.user.update({ where: { id: user.id }, data });
}
