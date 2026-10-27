import type { Prisma, PrismaClient, User } from "@prisma/client";

// Relative imports only: `npm run check:security` runs these flows outside
// Next with a fake `AccountAuthPort`, so the gate exercises the REAL refusal
// order (rate limit → current password → collisions), not a copy of it.
import { writeAuditRow } from "../db/audit-row.ts";
import { normalizeEmail } from "../identity.ts";
import { checkRateLimits } from "../rate-limit.ts";
import { emailChangeMode } from "./auth-config.ts";
import { resolveAppIdentity, type AuthIdentity } from "./identity-link.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Env = Record<string, string | undefined>;

/** What a Supabase call answered, reduced to what the account page can say. */
export type AuthPortResult = { ok: true } | { ok: false; code: "emailTaken" | "weakPassword" | "failed" };

/**
 * The Supabase operations Account settings needs (F2). The app wires the real
 * one (`app/[locale]/account/actions.ts`); the gate passes a fake. Nothing
 * here touches a cookie.
 */
export type AccountAuthPort = {
  /** True when `password` signs `email` in — on a throwaway client, never this session. */
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** Sets the password of this session's login. */
  setPassword(password: string): Promise<AuthPortResult>;
  /** Ends every other session of this login; the current one stays. */
  signOutOthers(): Promise<boolean>;
  /** `direct` mode: the admin API sets the email, already confirmed. */
  setEmailConfirmed(email: string): Promise<AuthPortResult & { identity?: AuthIdentity }>;
  /** `confirm` mode: Supabase's email-change flow mails a link to the new address. */
  requestEmailChange(email: string): Promise<AuthPortResult>;
};

export type AccountCaller = {
  user: User;
  /** The login's email as Supabase holds it now — what the current password signs in with. */
  authEmail: string | null;
  /** For the per-IP rate-limit key only (SEC-27). */
  ip: string;
};

/** Message keys under `Account.errors`. */
export type AccountResult =
  | { ok: true; status: "passwordChanged" | "passwordChangedOthersKept" | "emailChanged" | "emailChangeRequested" }
  | { ok: false; error?: string; fieldErrors?: Record<string, string> };

/**
 * The gate every credential change passes (F2): rate-limited per account and
 * per client IP **before** Supabase is asked — a wrong guess counts like any
 * other — then the current password, checked by a real password sign-in.
 */
async function verifyCurrentPassword(
  port: AccountAuthPort,
  caller: AccountCaller,
  password: string,
): Promise<AccountResult | null> {
  const allowed = await checkRateLimits([
    { name: "accountVerifyPerUser", key: caller.user.id },
    { name: "accountVerifyPerIp", key: caller.ip },
  ]);
  if (!allowed) return { ok: false, error: "rateLimited" };
  if (!caller.authEmail) return { ok: false, error: "failed" };
  if (!(await port.verifyPassword(caller.authEmail, password))) {
    return { ok: false, fieldErrors: { currentPassword: "wrongPassword" } };
  }
  return null;
}

export async function changePassword(
  db: Db,
  port: AccountAuthPort,
  caller: AccountCaller,
  input: { currentPassword: string; newPassword: string; signOutOthers: boolean },
): Promise<AccountResult> {
  const refused = await verifyCurrentPassword(port, caller, input.currentPassword);
  if (refused) return refused;
  if (input.newPassword === input.currentPassword) {
    return { ok: false, fieldErrors: { newPassword: "samePassword" } };
  }

  const set = await port.setPassword(input.newPassword);
  if (!set.ok) {
    return set.code === "weakPassword"
      ? { ok: false, fieldErrors: { newPassword: "weakPassword" } }
      : { ok: false, error: "failed" };
  }

  const othersSignedOut = input.signOutOthers ? await port.signOutOthers() : false;
  await writeAuditRow(db, {
    centerId: null,
    actorUserId: caller.user.id,
    action: "account.password.change",
    entityType: "User",
    entityId: caller.user.id,
    after: { signOutOthers: input.signOutOthers, othersSignedOut },
  });
  return {
    ok: true,
    status: input.signOutOthers && !othersSignedOut ? "passwordChangedOthersKept" : "passwordChanged",
  };
}

/**
 * Changes the login's email (F2). Refused, in this order: no mode (neither
 * confirmation nor the override is on), the same address, the rate limit, a
 * wrong current password — and only then, so the answer is no oracle for a
 * stranger, an address someone else holds:
 * - another login's `User`, or another Supabase login (Supabase refuses it);
 * - a person a branch created who has never signed in. Settings **never**
 *   opens an `AccountClaim` (D-01) — that is sign-up's path, approved in
 *   person; here the answer is "ask that branch".
 *
 * `User.email` itself changes only in `syncUserFromAuth` (`resolveAppIdentity`
 * → `syncLinkedUser`), which audits `account.email.change` with the write.
 */
export async function changeEmail(
  db: Db,
  port: AccountAuthPort,
  caller: AccountCaller,
  input: { newEmail: string; currentPassword: string },
  env: Env = process.env,
): Promise<AccountResult> {
  const mode = emailChangeMode(env);
  if (mode === "off") return { ok: false, error: "emailChangeDisabled" };

  const email = normalizeEmail(input.newEmail);
  if (!email) return { ok: false, fieldErrors: { newEmail: "required" } };
  if (email === normalizeEmail(caller.authEmail) || email === caller.user.email) {
    return { ok: false, fieldErrors: { newEmail: "sameEmail" } };
  }

  const refused = await verifyCurrentPassword(port, caller, input.currentPassword);
  if (refused) return refused;

  const holder = await db.user.findUnique({ where: { email }, select: { id: true, authId: true } });
  if (holder && holder.id !== caller.user.id) {
    return { ok: false, fieldErrors: { newEmail: holder.authId ? "emailTaken" : "emailOnBranchRecord" } };
  }

  if (mode === "confirm") {
    const requested = await port.requestEmailChange(email);
    if (!requested.ok) {
      return requested.code === "emailTaken"
        ? { ok: false, fieldErrors: { newEmail: "emailTaken" } }
        : { ok: false, error: "failed" };
    }
    return { ok: true, status: "emailChangeRequested" };
  }

  const set = await port.setEmailConfirmed(email);
  if (!set.ok || !set.identity) {
    return !set.ok && set.code === "emailTaken"
      ? { ok: false, fieldErrors: { newEmail: "emailTaken" } }
      : { ok: false, error: "failed" };
  }
  const synced = await resolveAppIdentity(db, set.identity, env);
  if (synced.kind !== "user" || synced.user.email !== email) {
    // Someone took the address between the check and the sync: the app User
    // kept the old email, so the login goes back to it too.
    if (caller.authEmail) await port.setEmailConfirmed(caller.authEmail);
    return { ok: false, fieldErrors: { newEmail: "emailTaken" } };
  }
  return { ok: true, status: "emailChanged" };
}
