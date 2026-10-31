/**
 * The security gate (SEC-2a; docs/07-security-audit.md). One assertion per
 * fixed finding, named after it — `SEC-NN` — each ported from the finding's
 * repro script (`scripts/security-repro/`, deleted once its assertion here
 * proved NOT REPRODUCED) or from its stated gate. A fixed finding that
 * regresses fails this script.
 *
 *   npm run check:security
 *
 * Needs a reachable database. Works on the shared dev project and on plain
 * Postgres: it creates its own throwaway organisations, centres and users
 * (slug/email prefix `seccheck-`, `@kayedu.test`), cleans them up before and
 * after, never touches seed data, never creates a Supabase Auth user, and runs
 * nothing destructive. The one network call is the read-only anon-key probe
 * of SEC-10, skipped when the Supabase env is absent.
 *
 * SEC-2b adds the money, concurrency and anti-fraud findings (`sec2bMoney`
 * below) — the concurrency ones with real parallel transactions on two
 * separate clients. Findings still open keep no assertion; docs/07 §1.1 says
 * why for each.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

import { AuthMisconfiguredError, productionAuthProblems } from "../lib/auth/auth-config.ts";
import { profileFromMetadata, resolveAppIdentity } from "../lib/auth/identity-link.ts";
import { changeEmail, changePassword, type AccountAuthPort } from "../lib/auth/account.ts";
import { updateAccountProfile } from "../lib/db/account.ts";
import { accountProfileSchema, changePasswordSchema } from "../lib/validation/account.ts";
import { signInSchema, signUpSchema } from "../lib/validation/auth.ts";
import { PASSWORD_MIN_LENGTH } from "../lib/password-policy.ts";
import { enforceProductionAuthSettings } from "../lib/auth/production-guard.ts";
import {
  DEFAULT_ROLE_GRANTS,
  PERMISSIONS,
  can,
  canInContext,
  type Permission,
} from "../lib/auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../lib/auth/relations.ts";
import {
  approveAccountClaim,
  pendingClaimsForCenter,
  rejectAccountClaim,
} from "../lib/db/account-claims.ts";
import {
  countOtherCenterRelations,
  createPerson,
  describeMatch,
  resolveContact,
} from "../lib/db/identity.ts";
import { revenueTotalsRollup } from "../lib/db/organizations.ts";
import {
  acceptFamilyCode,
  activeChildLinks,
  hashFamilyCode,
  issueBranchCode,
  revokeFamilyLink,
} from "../lib/db/parents.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { reserveOrEnroll, SELF_SERVICE_CAPS } from "../lib/db/reservations.ts";
import { addTeacherMembership } from "../lib/db/teacher-membership.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import { checkRateLimit, checkRateLimits, pruneRateLimitBuckets, RATE_LIMITS } from "../lib/rate-limit.ts";
import { safeNextPath } from "../lib/routes.ts";
import { MAX_PHOTO_BYTES, centerLogoSrc, sniffImageType } from "../lib/storage-paths.ts";
import { createCenterSchema } from "../lib/validation/admin.ts";
import { seedPasswordProblems } from "../prisma/seed-data/auth.ts";
import { productionTargetReason } from "../prisma/seed-data/production-refs.ts";
import { auditRls, rlsProblems } from "./lib/rls-audit.ts";
import { loadAuditFeed, loadUnpaidCheckIns } from "../lib/db/audit-feed.ts";
import { AuditPayloadError, FORBIDDEN_AUDIT_KEYS, forbiddenAuditKey, writeAuditRow } from "../lib/db/audit-row.ts";
import { revenueTotals } from "../lib/db/analytics.ts";
import { resolveSessionRequest } from "../lib/db/approvals.ts";
import { changeAttendanceStatus, createAttendance, recheckInAttendee, SessionClosedError } from "../lib/db/attendance.ts";
import { classMoneyError } from "../lib/db/class-sessions.ts";
import { createPaymentMethod, listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { recordPayment, sessionReceiptLines, sessionReceiptTotals, voidPayment } from "../lib/db/payments.ts";
import { skipSessionRating, submitSessionRating } from "../lib/db/ratings.ts";
import { refundPayment } from "../lib/db/refunds.ts";
import { closeSessionIfDayOver, lockAttendeeRow, WRITE_TRANSACTION_OPTIONS } from "../lib/db/session-lifecycle.ts";
import { cancelSession, rescheduleSession, updateSessionShareOverride } from "../lib/db/sessions.ts";
import {
  approveSettlement,
  cancelSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
} from "../lib/db/settlements.ts";
import { expenseDateError } from "../lib/db/visibility.ts";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres, splitShare } from "../lib/money.ts";
import { addDays, dateKey, dayMarker, todayInTimezone, zonedDateTimeToUtc } from "../lib/scheduling.ts";
import { expenseCreateSchema } from "../lib/validation/analytics.ts";
import { classGroupSchema, classGroupUpdateSchema, holidaySchema } from "../lib/validation/classes.ts";
import { newOneOffSessionSchema, rescheduleSessionSchema, setAttendanceSchema } from "../lib/validation/sessions.ts";
import { createPeriodSettlementSchema } from "../lib/validation/settlements.ts";
import { sessionRequestSchema } from "../lib/validation/teacher.ts";
import { centerGradeById } from "../lib/db/catalog.ts";
import { DEFAULT_CARD_BACKGROUND } from "../lib/card-layout.ts";
import { mapWithConcurrency } from "../lib/concurrency.ts";
import { resolveCardLayout } from "../lib/id-card.ts";
import { likeSearchToken } from "../lib/like.ts";
import { studentSearchWhere } from "../lib/db/students.ts";
import { writeRefusal } from "./lib/env.ts";
import { boundSearchArgs, parseActionArgs, SEARCH_QUERY_MAX, searchArgs } from "../lib/validation/action-args.ts";

const prisma = await gatePrisma();
const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PREFIX = "seccheck-";
const EMAIL = (tag: string) => `${PREFIX}${tag}@kayedu.test`;

let failures = 0;
const createdUserIds = new Set<string>();
const rateLimitKeys = new Set<string>();

type Step = [label: string, passed: boolean];

/** One line per finding: PASS, or FAIL with the sub-steps that failed. */
async function assertSec(id: string, title: string, run: () => Promise<Step[]> | Step[]) {
  let steps: Step[];
  try {
    steps = await run();
  } catch (error) {
    steps = [[`threw: ${error instanceof Error ? error.message : String(error)}`, false]];
  }
  const failed = steps.filter(([, passed]) => !passed).map(([label]) => label);
  if (failed.length === 0) {
    console.log(`  PASS  ${id} — ${title}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${id} — ${title}\n        ✗ ${failed.join("\n        ✗ ")}`);
  }
}

// ── Static helpers ─────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The body of `export async function <name>(` up to the next top-level export. */
function exportedBody(path: string, name: string): string {
  const source = read(path);
  const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

function exportedFunctions(path: string): { name: string; body: string }[] {
  const source = read(path);
  const result: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const next = source.indexOf("\nexport ", match.index + 10);
    result.push({ name: match[1], body: source.slice(match.index, next < 0 ? undefined : next) });
  }
  return result;
}

/**
 * The limiter counts in fixed windows; a burst that straddles a window edge
 * legitimately gets two budgets. Start each burst well inside one window.
 */
async function awayFromWindowEdge(windowMs: number, neededMs = 20_000): Promise<void> {
  const into = Date.now() % windowMs;
  if (into > windowMs - neededMs) await new Promise((r) => setTimeout(r, windowMs - into + 250));
}

// ── Fixtures ───────────────────────────────────────────────────────────────

async function cleanup() {
  const centers = await prisma.center.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true, organizationId: true },
  });
  const centerIds = centers.map((center) => center.id);
  if (centerIds.length > 0) {
    await deleteAuditRows(prisma, { centerId: { in: centerIds } });
    await prisma.center.deleteMany({ where: { id: { in: centerIds } } });
  }
  const orgIds = [...new Set(centers.map((center) => center.organizationId))];
  await prisma.organization.deleteMany({
    where: { OR: [{ id: { in: orgIds } }, { name: { startsWith: PREFIX } }], centers: { none: {} } },
  });
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { startsWith: PREFIX } }, { id: { in: [...createdUserIds] } }] },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length > 0) {
    await deleteAuditRows(prisma, { actorUserId: { in: userIds } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (rateLimitKeys.size > 0) {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: [...rateLimitKeys] } } });
  }
}

/** A fresh client address for one family-code accept; both of its limiter keys are cleaned up (F3). */
function familyJoinIp(userId: string): string {
  const ip = `${PREFIX}${randomUUID()}`;
  rateLimitKeys.add(`familyJoinPerIp:${ip}`);
  rateLimitKeys.add(`familyJoinPerUser:${userId}`);
  return ip;
}

async function makeCenter(tag: string, organizationId?: string, lifecycleState: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const center = await prisma.center.create({
    data: {
      slug: `${PREFIX}${tag}`,
      name: `SecCheck ${tag}`,
      lifecycleState,
      ...(organizationId
        ? { organizationId }
        : { organization: { create: { name: `${PREFIX}org-${tag}` } } }),
    },
  });
  await provisionCenterBaseline(prisma, center.id);
  return center;
}

async function makeUser(tag: string, data: { authId?: string | null; phone?: string | null } = {}) {
  return prisma.user.create({
    data: { email: EMAIL(tag), firstName: "Sec", lastName: tag, locale: "en", ...data },
  });
}

async function freePhone(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const phone = `+2015${String(randomInt(0, 99_999_999)).padStart(8, "0")}`; // the stored E.164 form (U4)
    const [users, profiles, memberships] = await Promise.all([
      prisma.user.count({ where: { OR: [{ phone }, { altPhone: phone }] } }),
      prisma.studentProfile.count({
        where: { OR: [{ phone }, { parentPhone: phone }, { parentAltPhone: phone }] },
      }),
      prisma.membership.count({ where: { OR: [{ phone }, { altPhone: phone }] } }),
    ]);
    if (users + profiles + memberships === 0) return phone;
  }
  throw new Error("no free phone found");
}

let codeCounter = 0;
async function makeStudent(
  centerId: string,
  user: { id: string },
  extra: { parentPhone?: string | null; phone?: string | null; email?: string | null } = {},
) {
  codeCounter += 1;
  return prisma.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode: `SC${codeCounter}${randomInt(100, 999)}`,
      firstName: "Student",
      lastName: String(codeCounter),
      ...extra,
    }),
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  await cleanup();
  console.log("check:security — SEC-2a (identity & access, data exposure, platform)\n");

  const orgCenter = await makeCenter("a1");
  const siblingCenter = await makeCenter("a2", orgCenter.organizationId);
  const otherCenter = await makeCenter("b");
  const manager = await makeUser("manager");
  await prisma.membership.create({
    data: { centerId: orgCenter.id, userId: manager.id, role: "MANAGER", joinedAt: new Date() },
  });

  // ── AuthN & accounts ────────────────────────────────────────────────────

  await assertSec("SEC-01", "a sign-up never takes over a staff-created person (auto-confirm simulated ON)", async () => {
    const victimEmail = EMAIL("victim");
    const victim = await createPerson(
      { firstName: "Victim", lastName: "Child", email: victimEmail, phone: null, altPhone: null, locale: "ar" },
      prisma,
    );
    await makeStudent(orgCenter.id, victim, { email: victimEmail });
    const attackerAuthId = randomUUID();
    // Auto-confirm ON: Supabase stamps email_confirmed_at on every sign-up.
    const autoConfirmed = {
      id: attackerAuthId,
      email: victimEmail.toUpperCase(),
      email_confirmed_at: new Date().toISOString(),
      user_metadata: { first_name: "Attacker", last_name: "X" },
    };
    const devEnv = { REQUIRE_EMAIL_CONFIRMATION: "false" };
    const first = await resolveAppIdentity(prisma, autoConfirmed, devEnv);
    const victimAfter = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    const attackerUser = await prisma.user.findUnique({ where: { authId: attackerAuthId } });

    const unconfirmed = await resolveAppIdentity(
      prisma,
      { id: randomUUID(), email: victimEmail, email_confirmed_at: null },
      { REQUIRE_EMAIL_CONFIRMATION: "true" },
    );
    let productionRefused = false;
    try {
      await resolveAppIdentity(prisma, autoConfirmed, { VERCEL_ENV: "production" });
    } catch (error) {
      productionRefused = error instanceof AuthMisconfiguredError;
    }
    const prodEnv = { VERCEL_ENV: "production", REQUIRE_EMAIL_CONFIRMATION: "true" };

    const claimId = first.kind === "claimPending" ? first.claimId : "";
    const unrelatedSees = (await pendingClaimsForCenter(prisma, otherCenter.id)).some((c) => c.id === claimId);
    const unrelatedApprove = await approveAccountClaim(prisma, {
      claimId,
      centerId: otherCenter.id,
      actorUserId: manager.id,
    });
    const ownSees = (await pendingClaimsForCenter(prisma, orgCenter.id)).some((c) => c.id === claimId);
    const approved = await approveAccountClaim(prisma, { claimId, centerId: orgCenter.id, actorUserId: manager.id });
    const afterApproval = await resolveAppIdentity(prisma, autoConfirmed, devEnv);

    // Reject path: the claimant becomes a new person of their own.
    const other = await createPerson(
      { firstName: "Other", lastName: "Kid", email: EMAIL("victim2"), phone: null, altPhone: null, locale: "ar" },
      prisma,
    );
    // Rejection detaches its email, so cleanup must know it by id.
    createdUserIds.add(other.id);
    await makeStudent(orgCenter.id, other);
    const parentAuth = { id: randomUUID(), email: EMAIL("victim2"), email_confirmed_at: new Date().toISOString() };
    const parentClaim = await resolveAppIdentity(prisma, parentAuth, devEnv);
    const rejected =
      parentClaim.kind === "claimPending"
        ? await rejectAccountClaim(prisma, { claimId: parentClaim.claimId, centerId: orgCenter.id, actorUserId: manager.id })
        : null;
    const parentAfter = await resolveAppIdentity(prisma, parentAuth, devEnv);
    if (parentAfter.kind === "user") createdUserIds.add(parentAfter.user.id);

    const invite = exportedBody("app/[locale]/(auth)/actions.ts", "acceptInvitationAction");
    const inviteCreate = read("app/[locale]/(center)/settings/staff/actions.ts");
    return [
      ["sign-up with a staff-created person's email opens a PENDING claim", first.kind === "claimPending"],
      ["the person's record stays unlinked (authId null)", victimAfter.authId === null],
      ["the login gets no app user at all while the claim waits", attackerUser === null],
      ["REQUIRE_EMAIL_CONFIRMATION=true + unconfirmed email → no user, no link", unconfirmed.kind === "unconfirmed"],
      ["production without REQUIRE_EMAIL_CONFIRMATION refuses to resolve anyone", productionRefused],
      ["production guard flags an auto-confirming project", productionAuthProblems(prodEnv, { mailer_autoconfirm: true }).length > 0],
      ["production guard passes a confirming project", productionAuthProblems(prodEnv, { mailer_autoconfirm: false }).length === 0],
      // DEPLOY-1: the demo override is off by default, never beats REQUIRE_EMAIL_CONFIRMATION=true.
      ["demo override: production without it still refuses (no override set)", productionAuthProblems({ VERCEL_ENV: "production" }, { mailer_autoconfirm: true }).length > 0],
      ["demo override: any value but \"yes\" does not lift the guard", productionAuthProblems({ VERCEL_ENV: "production", ALLOW_AUTO_CONFIRM_DEMO: "true" }, { mailer_autoconfirm: true }).length > 0],
      ["demo override: ALLOW_AUTO_CONFIRM_DEMO=yes lifts the guard only when REQUIRE_EMAIL_CONFIRMATION is not true", productionAuthProblems({ VERCEL_ENV: "production", ALLOW_AUTO_CONFIRM_DEMO: "yes" }, { mailer_autoconfirm: true }).length === 0],
      ["demo override: never applies when REQUIRE_EMAIL_CONFIRMATION=true (auto-confirm still refused)", productionAuthProblems({ ...prodEnv, ALLOW_AUTO_CONFIRM_DEMO: "yes" }, { mailer_autoconfirm: true }).length > 0],
      ["demo override: the start-up guard still throws without it", await enforceProductionAuthSettings({ VERCEL_ENV: "production" }).then(() => false, (error) => error instanceof AuthMisconfiguredError)],
      ["a centre that does not know the person never sees or approves the claim", !unrelatedSees && !unrelatedApprove.ok],
      ["the centre that knows the person sees the claim", ownSees],
      ["approval in person links exactly that login", approved.ok && afterApproval.kind === "user" && afterApproval.user.id === victim.id],
      ["approval is audited", (await prisma.auditLog.count({ where: { action: "account.claim.approve", entityId: claimId } })) === 1],
      ["rejection detaches the email; the claimant becomes a new person", Boolean(rejected?.ok) && parentAfter.kind === "user" && parentAfter.user.id !== other.id],
      ["invitations: email-bound, role from the row, single-use, expiring", /user\.email\.toLowerCase\(\) !== invitation\.email\.toLowerCase\(\)/.test(invite) && /role: invitation\.role/.test(invite) && /status: "PENDING", expiresAt: \{ gt: new Date\(\) \}/.test(invite) && /randomBytes\(32\)/.test(inviteCreate)],
      ["invitations also need a confirmed email under REQUIRE_EMAIL_CONFIRMATION", /requireEmailConfirmation\(\) && !user\.emailVerifiedAt/.test(invite)],
    ];
  });

  await assertSec("SEC-02", "an unverified phone is never an identity key (student and teacher paths)", async () => {
    const phone = await freePhone();
    // Exactly what the pre-SEC-2a sign-up stored: a login holding a typed phone.
    const attacker = await makeUser("attacker2", { authId: randomUUID(), phone });
    const student = await resolveContact(
      { centerId: otherCenter.id, actorUserId: null, adding: "student" },
      { email: null, phone },
    );
    const linkAttempt = await prisma.$transaction((tx) =>
      addTeacherMembership(
        tx,
        otherCenter.id,
        { firstName: "Ahmed", lastName: "Victim", email: null, phone, altPhone: null, locale: "en" },
        { actorUserId: null, linkUserId: attacker.id, via: "teacher.add", refusePrivileged: false },
      ),
    );
    const created = await prisma.$transaction((tx) =>
      addTeacherMembership(
        tx,
        otherCenter.id,
        { firstName: "Ahmed", lastName: "Victim", email: null, phone, altPhone: null, locale: "en" },
        { actorUserId: null, linkUserId: null, via: "teacher.add", refusePrivileged: false },
      ),
    );
    if (created.ok) createdUserIds.add(created.userId);
    const newPerson = created.ok ? await prisma.user.findUnique({ where: { id: created.userId } }) : null;
    const viaSignUp = await resolveAppIdentity(
      prisma,
      { id: randomUUID(), email: EMAIL("phone-meta"), email_confirmed_at: new Date().toISOString(), user_metadata: { phone } },
      { REQUIRE_EMAIL_CONFIRMATION: "false" },
    );
    const signUp = exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction");
    return [
      ["a phone held by a login does not match a new student", student.kind === "none"],
      ["'Use this person' by phone is refused (matchGone)", !linkAttempt.ok && linkAttempt.error === "matchGone"],
      ["the teacher is created as a new person, not the phone's holder", created.ok && created.userId !== attacker.id],
      ["the new person does not take the held phone globally (no squatting either way)", newPerson?.phone === null],
      ["sign-up metadata never puts a phone on the global User", viaSignUp.kind === "user" && viaSignUp.user.phone === null],
      ["sign-up writes no phone and answers no 'phone in use'", !/prisma\.user\.update/.test(signUp) && !/phoneInUse/.test(signUp)],
    ];
  });

  await assertSec("F2", "account settings: the current password, collisions, claims and the flag (ids-only audit)", async () => {
    const self = await makeUser("acct-self", { authId: randomUUID() });
    const second = await makeUser("acct-second", { authId: randomUUID() });
    const holder = await makeUser("acct-holder", { authId: randomUUID() });
    const staffMade = await createPerson(
      { firstName: "Branch", lastName: "Made", email: EMAIL("acct-staffmade"), phone: null, altPhone: null, locale: "ar" },
      prisma,
    );
    await makeStudent(orgCenter.id, staffMade, { email: EMAIL("acct-staffmade") });
    const membership = await prisma.membership.create({
      data: { centerId: orgCenter.id, userId: self.id, role: "TEACHER", joinedAt: new Date(), firstName: "Local", lastName: "Teacher" },
    });
    const profile = await makeStudent(otherCenter.id, self);

    // A fake Supabase: one right password; every call recorded.
    const RIGHT = "the-right-password";
    const calls: string[] = [];
    const port = (authId: string): AccountAuthPort => ({
      verifyPassword: async (_email, password) => password === RIGHT,
      setPassword: async () => {
        calls.push("setPassword");
        return { ok: true };
      },
      signOutOthers: async () => {
        calls.push("signOutOthers");
        return true;
      },
      setEmailConfirmed: async (email) => {
        calls.push("setEmailConfirmed");
        return { ok: true, identity: { id: authId, email, email_confirmed_at: new Date().toISOString() } };
      },
      requestEmailChange: async () => {
        calls.push("requestEmailChange");
        return { ok: true };
      },
    });
    const ip = `seccheck-acct-${randomUUID()}`;
    for (const key of [self.id, second.id]) rateLimitKeys.add(`accountVerifyPerUser:${key}`);
    rateLimitKeys.add(`accountVerifyPerIp:${ip}`);
    const callerFor = async (userId: string) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      return { user, authEmail: user.email, ip };
    };
    const direct = { ALLOW_UNVERIFIED_EMAIL_CHANGE: "yes", REQUIRE_EMAIL_CONFIRMATION: "false" };
    const selfPort = port(self.authId ?? "");

    await awayFromWindowEdge(RATE_LIMITS.accountVerifyPerUser.windowMs);
    // Flag off: refused before the password is even asked (no attempt counted).
    const flagOff = await changeEmail(prisma, selfPort, await callerFor(self.id), { newEmail: EMAIL("acct-new"), currentPassword: RIGHT }, {});
    // Attempts 1-2: a wrong current password refuses both changes.
    const wrongPw = await changePassword(prisma, selfPort, await callerFor(self.id), {
      currentPassword: "nope",
      newPassword: "another-password",
      signOutOthers: true,
    });
    const wrongPwEmail = await changeEmail(prisma, selfPort, await callerFor(self.id), { newEmail: EMAIL("acct-new"), currentPassword: "nope" }, direct);
    const noWriteOnWrong = !calls.includes("setPassword") && !calls.includes("setEmailConfirmed");
    // 3: another login's email. 4: a person a branch created, and no claim opens.
    const taken = await changeEmail(prisma, selfPort, await callerFor(self.id), { newEmail: holder.email ?? "", currentPassword: RIGHT }, direct);
    const claimsBefore = await prisma.accountClaim.count({ where: { targetUserId: staffMade.id } });
    const branchRecord = await changeEmail(prisma, selfPort, await callerFor(self.id), { newEmail: EMAIL("acct-staffmade"), currentPassword: RIGHT }, direct);
    const claimsAfter = await prisma.accountClaim.count({ where: { targetUserId: staffMade.id } });
    // 5: the direct change goes through the one sync, audited without the address.
    const changed = await changeEmail(prisma, selfPort, await callerFor(self.id), { newEmail: EMAIL("acct-new"), currentPassword: RIGHT }, direct);
    const selfAfter = await prisma.user.findUniqueOrThrow({ where: { id: self.id } });
    const emailAudit = await prisma.auditLog.findMany({ where: { action: "account.email.change", entityId: self.id } });
    // 6: the per-account limit (5 per window) now refuses even the right password.
    const limited = await changePassword(prisma, selfPort, await callerFor(self.id), {
      currentPassword: RIGHT,
      newPassword: "another-password",
      signOutOthers: true,
    });

    // A second account: password change + sign-out-others, and the confirmation branch.
    const secondPort = port(second.authId ?? "");
    const pwChanged = await changePassword(prisma, secondPort, await callerFor(second.id), {
      currentPassword: RIGHT,
      newPassword: "a-new-password",
      signOutOthers: true,
    });
    const pwAudit = await prisma.auditLog.findMany({ where: { action: "account.password.change", entityId: second.id } });
    const requested = await changeEmail(
      prisma,
      secondPort,
      await callerFor(second.id),
      { newEmail: EMAIL("acct-second-new"), currentPassword: RIGHT },
      { REQUIRE_EMAIL_CONFIRMATION: "true" },
    );
    const secondAfter = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });

    // Renaming the account never touches a branch record (rule 4).
    const parsed = accountProfileSchema.parse({
      firstName: "Renamed",
      lastName: "Person",
      contactPhone: "+20 101 234 5678",
      preferredLocale: "en",
      locale: "en",
    });
    await updateAccountProfile(prisma, self.id, { ...parsed, locale: parsed.preferredLocale });
    const renamed = await prisma.user.findUniqueOrThrow({ where: { id: self.id } });
    const membershipAfter = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    const profileAfter = await prisma.studentProfile.findUniqueOrThrow({ where: { id: profile.id } });

    return [
      ["flag off: the email change is refused (read-only)", !flagOff.ok && flagOff.error === "emailChangeDisabled"],
      ["a wrong current password refuses a password change", !wrongPw.ok && wrongPw.fieldErrors?.currentPassword === "wrongPassword"],
      ["a wrong current password refuses an email change", !wrongPwEmail.ok && wrongPwEmail.fieldErrors?.currentPassword === "wrongPassword"],
      ["nothing reaches Supabase after a wrong password", noWriteOnWrong],
      ["an email another account holds is refused", !taken.ok && taken.fieldErrors?.newEmail === "emailTaken"],
      ["a staff-created person's email is refused (ask that branch)", !branchRecord.ok && branchRecord.fieldErrors?.newEmail === "emailOnBranchRecord"],
      ["settings never opens an AccountClaim (D-01)", claimsBefore === claimsAfter],
      ["the direct change lands on User.email through the sync", changed.ok && selfAfter.email === EMAIL("acct-new") && selfAfter.emailVerifiedAt !== null],
      [
        "account.email.change is audited once, centre-less, with no address (D-20)",
        emailAudit.length === 1 &&
          emailAudit[0].centerId === null &&
          forbiddenAuditKey(emailAudit[0].after) === null &&
          !JSON.stringify(emailAudit[0].after).includes("@"),
      ],
      ["the current-password check is rate-limited per account", !limited.ok && limited.error === "rateLimited"],
      [
        "a password change signs other devices out and is audited ids-only",
        pwChanged.ok && calls.includes("signOutOthers") && pwAudit.length === 1 && pwAudit[0].centerId === null,
      ],
      [
        "REQUIRE_EMAIL_CONFIRMATION: a link is requested; User.email waits for the confirmed sync",
        requested.ok && requested.status === "emailChangeRequested" && calls.includes("requestEmailChange") && secondAfter.email === second.email,
      ],
      [
        "the account name changes the User only; no branch record moves",
        renamed.firstName === "Renamed" &&
          membershipAfter.firstName === "Local" &&
          profileAfter.firstName === profile.firstName &&
          profileAfter.lastName === profile.lastName,
      ],
      ["contactPhone is normalized by lib/phone.ts and User.phone is untouched", renamed.contactPhone === "+201012345678" && renamed.phone === self.phone],
    ];
  });

  await assertSec("SEC-03", "a phone match never becomes parent access — access needs a one-time code (F3, OD-6)", async () => {
    const parentPhone = await freePhone();
    const child = await makeUser("child3");
    const profile = await makeStudent(orgCenter.id, child, { parentPhone });
    const stranger = await makeUser("stranger3", { phone: parentPhone });
    const classmate = await makeUser("classmate3");
    await makeStudent(siblingCenter.id, classmate);
    const issued = await issueBranchCode(prisma, { centerId: orgCenter.id, studentProfileId: profile.id, actorUserId: manager.id });
    const code = issued.ok ? issued.code : "";
    const byClassmate = await acceptFamilyCode(prisma, { acceptorUserId: classmate.id, code, ip: familyJoinIp(classmate.id) });
    const row = issued.ok ? await prisma.familyInvitation.findUnique({ where: { id: issued.invitationId } }) : null;
    const signUp = exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction");
    return [
      ["sign-up originates nothing from a phone", !/originateParentLinks|acceptFamilyCode|familyLink|parentLink\./.test(signUp)],
      ["a stranger whose phone is the parent phone has no link and reads no child", (await prisma.familyLink.count({ where: { parentUserId: stranger.id } })) === 0 && (await activeChildLinks(prisma, stranger.id)).length === 0],
      ["a classmate (a student account) cannot accept the child's code", !byClassmate.ok && byClassmate.error === "studentAccount"],
      ["the code is stored as its sha256 only", row !== null && row.codeHash === hashFamilyCode(code) && !JSON.stringify(row).includes(code)],
      ["the staff Verify stand-in is gone", !existsSync(join(ROOT, "app/[locale]/(center)/students/[id]/verify-parent-link-button.tsx"))],
    ];
  });

  await assertSec("SEC-04", "a parent link stops on deactivation and ends only by explicit, audited revocation", async () => {
    const child = await makeUser("child4");
    const profile = await makeStudent(orgCenter.id, child, { parentPhone: await freePhone() });
    const parent = await makeUser("parent4");
    const issued = await issueBranchCode(prisma, { centerId: orgCenter.id, studentProfileId: profile.id, actorUserId: manager.id });
    const accepted = await acceptFamilyCode(prisma, { acceptorUserId: parent.id, code: issued.ok ? issued.code : "", ip: familyJoinIp(parent.id) });
    const reads = async () => (await activeChildLinks(prisma, parent.id)).flatMap((link) => link.studentUser.studentProfiles).length;
    const before = await reads();
    await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: false } });
    const whileInactive = await reads();
    await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: true, parentPhone: await freePhone() } });
    const afterPhoneChange = await reads();
    const linkId = accepted.ok ? accepted.linkId : "";
    const revoked = await revokeFamilyLink(prisma, { by: "branch", linkId, actorUserId: manager.id, centerId: orgCenter.id, studentUserId: child.id, reason: "seccheck" });
    const row = await prisma.familyLink.findUnique({ where: { id: linkId } });
    const audits = await prisma.auditLog.count({ where: { action: "family.link.revoke", entityId: linkId } });
    return [
      ["the linked parent reads before anything changes", accepted.ok && before === 1],
      ["a deactivated child disappears (D-10)", whileInactive === 0],
      ["a parent-phone change ends nothing (the phone is not the key)", afterPhoneChange === 1],
      ["staff revoke the link: REVOKED, with the reason on the record", revoked.ok && row?.status === "REVOKED" && row.revokedReason === "seccheck"],
      ["reads stop at once", (await reads()) === 0],
      ["the revocation is audited (family.link.revoke)", audits === 1],
      ["staff editing the parent phone revokes nothing", !/revoke/i.test(exportedBody("app/[locale]/(center)/students/actions.ts", "updateStudentAction"))],
    ];
  });

  // ── AuthZ ───────────────────────────────────────────────────────────────

  await assertSec("SEC-09", "a TEACHER-only member gets nothing from a centre action", async () => {
    const teacher = await makeUser("teacher9");
    await prisma.membership.create({
      data: { centerId: orgCenter.id, userId: teacher.id, role: "TEACHER", joinedAt: new Date() },
    });
    const relation = (await resolveCenterRelations(prisma, teacher.id)).find((r) => r.center.id === orgCenter.id);
    const centerRole = relation ? roleForExperience(relation, "center") : "missing";
    const grants = await loadPermissionGrants(prisma, orgCenter.id, "TEACHER");
    const deniedCtx = { experienceDenied: true, role: "TEACHER" as const, grants };

    // Static sweep: every exported centre action reaches the ctxCan choke point.
    const centerActionFiles = walk("app/[locale]/(center)").filter((path) => /actions\.ts$/.test(path));
    const unguarded: string[] = [];
    for (const file of centerActionFiles) {
      const source = read(file);
      // Local helpers that reach the guard — directly, or through another
      // guarded helper (resolved to a fixpoint).
      const functions = [...source.matchAll(/(?:async )?function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].map(
        (m) => ({ name: m[1], body: m[2] }),
      );
      const helpers = functions.filter((f) => /ctxCan\(|actionContext\(/.test(f.body)).map((f) => f.name);
      for (let changed = true; changed; ) {
        changed = false;
        for (const f of functions) {
          if (!helpers.includes(f.name) && helpers.some((helper) => f.body.includes(`${helper}(`))) {
            helpers.push(f.name);
            changed = true;
          }
        }
      }
      for (const { name, body } of exportedFunctions(file)) {
        const guarded =
          /ctxCan\(|actionContext\(/.test(body) || helpers.some((helper) => body.includes(`${helper}(`));
        if (!guarded) unguarded.push(`${file}#${name}`);
      }
    }
    const tenant = read("lib/auth/tenant.ts");
    const unblock = exportedBody("app/[locale]/(center)/teachers/actions.ts", "unblockStudentAction");
    return [
      ["roleForExperience(teacher-only, 'center') denies (null), no fall-back", centerRole === null],
      ["the matrix does grant TEACHER student.block (so the denial is the guard, not the grant)", can("TEACHER", "student.block", grants)],
      ["a denied experience grants nothing (canInContext)", !canInContext(deniedCtx, "student.block") && !canInContext(deniedCtx, "attendance.record")],
      ["ctxCan is canInContext; buildContext sets experienceDenied", /return canInContext\(ctx, permission\)/.test(tenant) && /experienceDenied = requested === null/.test(tenant)],
      [`every centre action reaches ctxCan/actionContext (${unguarded.join(", ") || "all"})`, unguarded.length === 0],
      ["the centre unblock refuses a CLASS-scope block", /block\.scope !== "TEACHER"/.test(unblock)],
    ];
  });

  await assertSec("SEC-14", "reactivating a staff membership is OWNER-only (D-09)", () => {
    const body = exportedBody("app/[locale]/(center)/settings/staff/member-actions.ts", "setMemberActiveAction");
    const allOpen = Object.fromEntries(PERMISSIONS.map((p) => [p, true]));
    return [
      ["active=true requires membership.role.assign", /if \(active && !ctxCan\(scope\.ctx, "membership\.role\.assign"\)\) return FORBIDDEN/.test(body)],
      ["a MANAGER can never hold membership.role.assign, whatever the matrix says", !can("MANAGER", "membership.role.assign", allOpen)],
      ["the staff page offers reactivation only to someone who may assign roles", /\(member\.active \|\| canAssignRole\)/.test(read("app/[locale]/(center)/settings/staff/page.tsx"))],
    ];
  });

  await assertSec("SEC-15", "the TEACHER student.block and analytics.own.view cells are enforced", () => {
    const students = read("app/[locale]/(teacher)/teacher/students/actions.ts");
    const teacherFiles = walk("app/[locale]/(teacher)").map(read).join("\n");
    const missing = DEFAULT_ROLE_GRANTS.TEACHER.filter((p) => !teacherFiles.includes(`"${p}"`));
    return [
      ["teacher block and unblock both check student.block", (students.match(/ctxCan\(ctx, "student\.block"\)/g) ?? []).length === 2],
      ["the teacher's block form shows only under student.block", /ctxCan\(ctx, "student\.block"\) \?/.test(read("app/[locale]/(teacher)/teacher/students/[id]/page.tsx"))],
      ["teacher earnings show only under analytics.own.view", /analytics\.own\.view/.test(read("app/[locale]/(teacher)/teacher/dashboard/page.tsx")) && /analytics\.own\.view/.test(read("app/[locale]/(teacher)/teacher/sessions/[id]/page.tsx"))],
      [`every TEACHER baseline permission has a call site in the teacher portal (${missing.join(", ") || "all"})`, missing.length === 0],
    ];
  });

  await assertSec("SEC-16", "suspended centres and deactivated profiles refuse the student/parent paths", async () => {
    const suspended = await makeCenter("s", undefined, "SUSPENDED");
    const teacher = await makeUser("teacher16");
    const student = await makeUser("student16");
    const now = Date.now();
    const suspendedClass = await prisma.classGroup.create({
      data: { centerId: suspended.id, teacherId: teacher.id, startDate: new Date(now - 864e5), endDate: new Date(now + 30 * 864e5) },
    });
    const openClass = await prisma.classGroup.create({
      data: { centerId: orgCenter.id, teacherId: teacher.id, startDate: new Date(now - 864e5), endDate: new Date(now + 30 * 864e5) },
    });
    const atSuspended = await prisma.$transaction((tx) =>
      reserveOrEnroll(tx, { centerId: suspended.id, classGroupId: suspendedClass.id, studentUserId: student.id }),
    );
    await makeStudent(orgCenter.id, student).then((profile) =>
      prisma.studentProfile.update({ where: { id: profile.id }, data: { active: false } }),
    );
    const whileInactive = await prisma.$transaction((tx) =>
      reserveOrEnroll(tx, { centerId: orgCenter.id, classGroupId: openClass.id, studentUserId: student.id }),
    );
    const child = await makeUser("child16");
    await makeStudent(suspended.id, child);
    const parent = await makeUser("parent16");
    // F3: a family link to the child's account; the child's only branch is SUSPENDED.
    await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: child.id, source: "LEGACY_VERIFIED" } });
    const profileAction = exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction");
    return [
      ["reserving at a SUSPENDED centre → notFound", !atSuspended.ok && atSuspended.error === "notFound"],
      ["a deactivated student cannot self-enrol", !whileInactive.ok && whileInactive.error === "studentBlocked"],
      ["a parent reads nothing at a SUSPENDED centre", (await activeChildLinks(prisma, parent.id)).every((link) => link.studentUser.studentProfiles.length === 0)],
      ["profile completion requires an active profile at an accessible centre", /active: true/.test(profileAction) && /ACCESSIBLE_LIFECYCLE_STATES/.test(profileAction)],
    ];
  });

  await assertSec("SEC-17", "student profile completion is strictly one-time (D-11)", () => {
    const body = exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction");
    return [
      ["a completed profile is refused (alreadyCompleted) before any write", /if \(profile\.profileCompletedAt\) return \{ error: "alreadyCompleted" \}/.test(body) && body.indexOf("alreadyCompleted") < body.indexOf("studentProfile.update")],
      // F3 old → new: "a parent-phone change revokes the link" → "only explicit, audited revocation ends a link".
      ["profile completion touches no family link (only explicit revocation ends one)", !/revoke|familyLink|parentLink/i.test(body)],
    ];
  });

  await assertSec("SEC-44", "teacher actions require an active TEACHER role at the active centre", () => {
    const files = walk("app/[locale]/(teacher)").filter((path) => /actions\.ts$/.test(path));
    const bad: string[] = [];
    for (const file of files) {
      for (const { name, body } of exportedFunctions(file)) {
        const tenantContext = /getTenantContext\(/.test(body);
        const guarded = /actionContext\("teacher"\)/.test(body) || /getCurrentUser\(\)/.test(body);
        if (tenantContext || !guarded) bad.push(`${file}#${name}`);
      }
    }
    const tenant = read("lib/auth/tenant.ts");
    return [
      [`every teacher action resolves through actionContext("teacher") (${bad.join(", ") || "all"})`, bad.length === 0],
      ["actionContext refuses a denied experience and a missing role", /if \(ctx\.experienceDenied \|\| !hasExperience\(ctx, experience\)\) return null/.test(tenant)],
    ];
  });

  await assertSec("SEC-45", "OWNER holds every non-platform permission without a stored grant", () => {
    const nonPlatform = PERMISSIONS.filter((p) => p !== "platform.manage");
    const denied = nonPlatform.filter((p) => !can("OWNER", p as Permission, {}));
    return [
      [`can("OWNER", …, {}) for every non-platform action (${denied.join(", ") || "all"})`, denied.length === 0],
      ["platform.manage stays platform-admin-only", !can("OWNER", "platform.manage", {})],
    ];
  });

  await assertSec("SEC-42", "invitation acceptance is race-safe; revoke is OWNER-only; a departing owner's invites die", () => {
    const accept = exportedBody("app/[locale]/(auth)/actions.ts", "acceptInvitationAction");
    const revoke = exportedBody("app/[locale]/(center)/settings/staff/actions.ts", "revokeInvitationAction");
    const members = read("app/[locale]/(center)/settings/staff/member-actions.ts");
    return [
      ["the invitation is claimed conditionally inside the transaction, before the membership", /\$transaction[\s\S]*tx\.invitation\.updateMany[\s\S]*claimed\.count !== 1[\s\S]*tx\.membership/.test(accept)],
      ["revoke requires membership.role.assign (D-22)", /ctxCan\(ctx, "membership\.role\.assign"\)/.test(revoke)],
      ["losing OWNER revokes that user's pending invitations", (members.match(/revokeInvitationsBy\(/g) ?? []).length >= 3],
    ];
  });

  // ── Tenant isolation / IDOR / privacy ───────────────────────────────────

  await assertSec("SEC-11", "contact lookups are rate-limited across instances on every path, and mask other organisations", async () => {
    // Two module instances = two serverless instances: one shared count now.
    type RateLimitModule = typeof import("../lib/rate-limit.ts");
    const path = "../lib/rate-limit.ts";
    const instanceA = (await import(`${path}?instance=a`)) as RateLimitModule;
    const instanceB = (await import(`${path}?instance=b`)) as RateLimitModule;
    const key = `${PREFIX}shared-${randomBytes(4).toString("hex")}`;
    rateLimitKeys.add(key);
    let allowed = 0;
    await awayFromWindowEdge(60_000);
    for (let i = 0; i < 25; i++) if (await instanceA.checkRateLimit(key, 20, 60_000)) allowed++;
    for (let i = 0; i < 25; i++) if (await instanceB.checkRateLimit(key, 20, 60_000)) allowed++;

    // A person known ONLY to the other organisation.
    const minorPhone = await freePhone();
    const minorEmail = EMAIL("minor11");
    const minor = await createPerson(
      { firstName: "Victim", lastName: "Minor", email: minorEmail, phone: null, altPhone: null, locale: "en" },
      prisma,
    );
    await makeStudent(otherCenter.id, minor, { phone: minorPhone });
    const byPhone = await resolveContact(
      { centerId: orgCenter.id, actorUserId: null, adding: "student" },
      { email: null, phone: minorPhone },
    );
    const byEmail = await resolveContact(
      { centerId: orgCenter.id, actorUserId: null, adding: "student" },
      { email: minorEmail, phone: null },
    );
    const described = byEmail.kind === "matched" ? await describeMatch(orgCenter.id, byEmail.match, { email: minorEmail }) : null;
    // The same person, known at a sibling branch of the viewer's own organisation.
    await makeStudent(siblingCenter.id, minor);
    const describedInOrg = byEmail.kind === "matched" ? await describeMatch(orgCenter.id, byEmail.match, { email: minorEmail }) : null;

    // The per-staff budget, on the real resolver.
    const actor = await makeUser("lookup-actor");
    rateLimitKeys.add(`identityLookupPerUser:${actor.id}`);
    rateLimitKeys.add(`identityLookupPerCenter:${siblingCenter.id}`);
    let lastKind = "";
    // 21 sequential lookups are slow over a Cairo -> Frankfurt link, so the
    // default 20 s margin let the minute window roll mid-loop (a flake).
    await awayFromWindowEdge(60_000, 45_000);
    for (let i = 0; i < 21; i++) {
      lastKind = (
        await resolveContact({ centerId: siblingCenter.id, actorUserId: actor.id, adding: "student" }, { email: null, phone: minorPhone })
      ).kind;
    }

    const resolver = exportedBody("lib/db/identity.ts", "resolveContact");
    const entryPoints: [string, string][] = [
      ["app/[locale]/(center)/students/actions.ts", "createStudentAction"],
      ["app/[locale]/(center)/students/actions.ts", "lookupPersonByPhoneAction"],
      ["app/[locale]/(center)/teachers/actions.ts", "lookupPersonByPhoneAction"],
      ["app/[locale]/(center)/sessions/actions.ts", "addNewAttendeeAction"],
      ["lib/db/teacher-membership.ts", "addTeacherMembership"],
    ];
    const unlimited = entryPoints.filter(([file, name]) => {
      const body = exportedBody(file, name);
      return !/resolveContact\(\s*\{\s*centerId/.test(body.replace(/\s+/g, " ")) || !/rateLimited/.test(body);
    });
    return [
      [`two instances share one budget (${allowed} of 50 allowed, limit 20)`, allowed === 20],
      ["a phone known only to another organisation resolves to nobody", byPhone.kind === "none"],
      ["an email known only to another organisation is described without a name", described !== null && described.name === null],
      ["the same person known inside the organisation is named", Boolean(describedInOrg?.name)],
      ["the 21st lookup by one staff member in a minute is refused", lastKind === "rateLimited"],
      ["resolveContact consults the shared limiter itself", /checkRateLimits\(/.test(resolver)],
      [`every disclosing entry point goes through it (${unlimited.map(([, n]) => n).join(", ") || "all"})`, unlimited.length === 0],
    ];
  });

  await assertSec("SEC-46", "a period settlement refuses a teacher who is not this centre's", () => {
    const body = exportedBody("app/[locale]/(center)/settlements/actions.ts", "createPeriodSettlementAction");
    return [
      ["teachers.findByUserId(teacherId) runs before createPeriodSettlement", /teachers\.findByUserId\(teacherId\)/.test(body) && body.indexOf("findByUserId") < body.indexOf("createPeriodSettlement(")],
    ];
  });

  await assertSec("SEC-47", "the student page counts other branches of the same organisation only (D-23)", async () => {
    const person = await makeUser("relations47");
    await makeStudent(orgCenter.id, person);
    await makeStudent(otherCenter.id, person);
    const unrelatedOnly = await countOtherCenterRelations(person.id, orgCenter.id);
    await makeStudent(siblingCenter.id, person);
    const withSibling = await countOtherCenterRelations(person.id, orgCenter.id);
    return [
      ["a profile at an unrelated organisation counts 0", unrelatedOnly === 0],
      ["a sibling branch counts", withSibling === 1],
    ];
  });

  await assertSec("SEC-48", "the Whole-Management roll-up reads each branch under its own window and permission", async () => {
    const page = read("app/[locale]/(center)/analytics/page.tsx");
    let threw = false;
    try {
      await revenueTotalsRollup(prisma, [orgCenter.id, siblingCenter.id], new Map([[orgCenter.id, { from: null, to: null }]]));
    } catch {
      threw = true;
    }
    return [
      ["each branch is clamped by its own settings' visibility floor", /visibilityWindowFloor\(\{ isPlatformAdmin: ctx\.isPlatformAdmin, settings \}/.test(page)],
      ["each branch must grant analytics.center.view to the viewer", /can\(role, "analytics\.center\.view", grants\)/.test(page)],
      ["the roll-up never falls back to an unbounded range for a missing branch", threw],
    ];
  });

  await assertSec("SEC-63", "lockAttendeeRow is centre-scoped in SQL", async () => {
    const teacher = await makeUser("teacher63");
    const session = await prisma.session.create({
      data: {
        centerId: orgCenter.id,
        teacherId: teacher.id,
        isManual: true,
        title: "SEC-63",
        date: new Date(Date.UTC(2030, 0, 1)),
        startTime: "10:00",
        endTime: "11:00",
      },
    });
    const student = await makeUser("student63");
    const profile = await makeStudent(orgCenter.id, student);
    const attendee = await prisma.sessionAttendee.create({
      data: { centerId: orgCenter.id, sessionId: session.id, studentProfileId: profile.id, recordedBy: manager.id },
    });
    const foreign = await prisma.$transaction((tx) => lockAttendeeRow(tx, attendee.id, otherCenter.id));
    const own = await prisma.$transaction((tx) => lockAttendeeRow(tx, attendee.id, orgCenter.id));
    return [
      ["another centre's attendee locks nothing (null)", foreign === null],
      ["the owning centre locks it", own !== null],
    ];
  });

  await assertSec("SEC-72", "approval queues load the requester's name, never a whole User row", () => {
    const scopedSource = read("lib/db/scoped.ts");
    return [
      ["no `student: true` include remains in the reservation loaders", !/student: true/.test(scopedSource)],
    ];
  });

  // ── Files & storage ─────────────────────────────────────────────────────

  await assertSec("SEC-53", "the centre logo is a private object, never a URL the server fetches (D-25)", () => {
    const parsed = createCenterSchema.safeParse({
      locale: "en",
      name: "X",
      slug: "x-logo",
      themeColor: "#2563EB",
      ownerEmail: "o@kayedu.test",
      logoUrl: "http://169.254.169.254/latest",
    });
    const storage = read("lib/db/storage.ts");
    return [
      ["the create schema carries no logo URL", parsed.success && !("logoUrl" in parsed.data)],
      ["nothing in the storage layer fetches a remote URL", !/\bfetch\(/.test(storage) && !/remoteImageAsDataUri/.test(storage)],
      ["the ID card inlines the logo from the logos bucket", /LOGOS_BUCKET, ctx\.center\.logoPath/.test(read("lib/db/id-cards.ts"))],
      ["the UI's logo src is the signing route, scoped to the centre", centerLogoSrc({ id: "c1", logoPath: "c1/logo.x.png" })?.startsWith("/api/logos/c1?") === true && centerLogoSrc({ id: "c1", logoPath: null }) === null],
      ["the route refuses a stored path outside the centre's folder", /isPathInCenter\(center\.id, center\.logoPath\)/.test(read("app/api/logos/[centerId]/route.ts"))],
    ];
  });

  await assertSec("SEC-54", "uploaded images are typed by their bytes (raster only, no SVG)", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const storage = read("lib/db/storage.ts");
    return [
      ["HTML bytes are no image", sniffImageType(html) === null],
      ["SVG is refused", sniffImageType(svg) === null],
      ["PNG / JPEG / WebP are recognised", sniffImageType(png) === "image/png" && sniffImageType(jpeg) === "image/jpeg" && sniffImageType(webp) === "image/webp"],
      ["uploads never use the client's File.type", !/file\.type/.test(storage)],
    ];
  });

  await assertSec("SEC-64", "photos are capped at about 1 MB and shrunk in the browser first (D-27)", () => [
    ["MAX_PHOTO_BYTES fits under the 1 MiB Server Action body", MAX_PHOTO_BYTES <= 1000 * 1024],
    ["the photo form shrinks before sending", /shrinkImageForUpload\(photo, MAX_PHOTO_BYTES\)/.test(read("app/[locale]/(center)/students/[id]/photo-form.tsx"))],
  ]);

  await assertSec("SEC-65", "photo changes are audited (D-28)", () => {
    const upload = exportedBody("app/[locale]/(center)/students/actions.ts", "uploadStudentPhotoAction");
    const remove = exportedBody("app/[locale]/(center)/students/actions.ts", "removeStudentPhotoAction");
    return [
      ["upload writes student.photo.update", /action: "student\.photo\.update"/.test(upload)],
      ["remove writes student.photo.remove", /action: "student\.photo\.remove"/.test(remove)],
    ];
  });

  // ── Supabase RLS & storage posture (live, read-only) ────────────────────

  const rls = await auditRls(prisma);
  const posture = rlsProblems(rls);

  await assertSec("SEC-10", "the Data API lockdown is a checked-in migration and holds live", async () => {
    const migration = read("prisma/migrations/20261017090100_sec2a_data_api_lockdown/migration.sql");
    const steps: Step[] = [
      ["the migration enables RLS on every public table", /ENABLE ROW LEVEL SECURITY/.test(migration) && /relkind IN \('r', 'p'\)/.test(migration)],
      ["it revokes schema, tables, sequences and functions from anon/authenticated", /REVOKE ALL ON SCHEMA public/.test(migration) && /REVOKE ALL ON ALL TABLES IN SCHEMA public/.test(migration) && /REVOKE ALL ON ALL SEQUENCES/.test(migration) && /REVOKE ALL ON ALL FUNCTIONS/.test(migration)],
      ["it revokes default privileges for future objects", /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES/.test(migration)],
      [`live posture is deny-all (${posture.join("; ") || "ok"})`, posture.length === 0],
    ];
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (base && anon) {
      const headers: Record<string, string> = { apikey: anon };
      if (anon.split(".").length === 3) headers.Authorization = `Bearer ${anon}`;
      const exposed: string[] = [];
      for (const table of ["User", "StudentProfile", "Payment", "AuditLog", "Membership", "ParentLink", "AccountClaim", "RateLimitBucket", "_prisma_migrations"]) {
        const response = await fetch(`${base}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, { headers }).catch(() => null);
        if (response?.status === 200) {
          const body = (await response.json().catch(() => null)) as unknown;
          if (Array.isArray(body) && body.length > 0) exposed.push(table);
        }
      }
      steps.push([`the anon key reads no table over PostgREST (${exposed.join(", ") || "none"})`, exposed.length === 0]);
    }
    return steps;
  });

  await assertSec("SEC-30", "the broken M10 backstop script is gone; check:rls replaces its grep gate", () => {
    const ci = read(".github/workflows/ci.yml");
    return [
      ["supabase/m10-rls-and-storage.sql no longer exists", !existsSync(join(ROOT, "supabase", "m10-rls-and-storage.sql"))],
      ["no gate greps that file any more", !/m10-rls-and-storage/.test(read("scripts/class-periods-check.ts"))],
      ["CI runs check:rls after migrate deploy", /npm run check:rls/.test(ci) && ci.indexOf("migrate deploy") < ci.indexOf("check:rls")],
    ];
  });

  await assertSec("SEC-31", "no RLS policy exists on public (deny-all, D-19 (a))", () => [
    [`public policies = ${rls.publicPolicies}`, rls.publicPolicies === 0],
  ]);

  await assertSec("SEC-55", "Storage is private and service-role-only", () => [
    [
      rls.buckets ? `buckets: ${rls.buckets.map((b) => `${b.id}${b.public ? "(public)" : ""}`).join(", ")}` : "no storage schema here (plain Postgres) — nothing to expose",
      rls.buckets === null || (rls.buckets.every((b) => !b.public) && rls.buckets.length >= 4),
    ],
    [`storage.objects policies = ${rls.storageObjectPolicies ?? "n/a"}`, (rls.storageObjectPolicies ?? 0) === 0],
  ]);

  await assertSec("SEC-56", "the docs describe the real RLS and storage posture", () => {
    const architecture = read("docs/02-architecture.md");
    const spec = read("docs/00-master-product-spec.md");
    return [
      ["docs/02 no longer claims storage policies with kayedu_* helpers exist", !/kayedu_member_center_ids/.test(architecture)],
      ["docs/00 no longer lists rls_auto_enable() as a live function", !/currently executable by both `anon` and `authenticated`/.test(spec)],
    ];
  });

  await assertSec("SEC-57", "the Prisma role's BYPASSRLS is reported and documented", () => [
    [`check:rls reports ${rls.currentRole} rolbypassrls=${rls.currentRoleBypassesRls}`, typeof rls.currentRoleBypassesRls === "boolean"],
    ["docs/02 states the app role bypasses RLS", /BYPASSRLS/.test(read("docs/02-architecture.md"))],
  ]);

  // ── AuthN hardening & platform ──────────────────────────────────────────

  await assertSec("SEC-27", "sign-in and sign-up are throttled per email and per IP before Supabase", async () => {
    const signIn = exportedBody("app/[locale]/(auth)/actions.ts", "signInAction");
    const signUp = exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction");
    const email = `${PREFIX}${randomBytes(4).toString("hex")}@kayedu.test`;
    rateLimitKeys.add(`signInPerEmail:${email}`);
    let allowed = 0;
    await awayFromWindowEdge(10 * 60_000);
    for (let i = 0; i < 11; i++) if (await checkRateLimits([{ name: "signInPerEmail", key: email }])) allowed++;
    return [
      ["sign-in checks both keys before signInWithPassword", /signInPerEmail/.test(signIn) && /signInPerIp/.test(signIn) && signIn.indexOf("checkRateLimits") < signIn.indexOf("signInWithPassword")],
      ["sign-up checks both keys before signUp", /signUpPerIp/.test(signUp) && /signUpPerEmail/.test(signUp) && signUp.indexOf("checkRateLimits") < signUp.indexOf("auth.signUp")],
      [`the 11th sign-in for one email in the window is refused (${allowed} allowed)`, allowed === 10],
    ];
  });

  await assertSec("SEC-40", "registration never says whether a phone or email is taken", () => {
    const signUp = exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction");
    return [
      ["no phoneInUse / emailInUse answer", !/phoneInUse|emailInUse/.test(signUp)],
      ["no session → the same 'check your email' state, whoever owns the address", /if \(!data\.session\) \{\s*return \{ status: "emailConfirmationRequired", email \};/.test(signUp)],
    ];
  });

  await assertSec("SEC-41", "sign-up metadata is validated and never overwrites a person", () => {
    const long = profileFromMetadata({ id: "x", email: "a@b.c", user_metadata: { first_name: "x".repeat(10_000), last_name: 42 } });
    return [
      ["names are capped at 60 characters", long.firstName.length <= 60 && long.lastName.length <= 60],
      ["a non-string field is ignored, never stored", long.lastName === "-"],
      ["signUpAction no longer writes the User row", !/prisma\.user\.update/.test(exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction"))],
    ];
  });

  await assertSec("SEC-43", "?next= accepts same-origin relative paths only", () => {
    const refused = ["//evil.com", "/\\evil.com", "/\\\\evil.com", "https://evil.com", "/ok\u0000", "/x\nLocation: y", "evil"];
    const accepted = ["/dashboard", "/students/123?x=1"];
    const leaks = refused.filter((value) => safeNextPath(value) !== null);
    return [
      [`refused: ${leaks.join(" | ") || "all"}`, leaks.length === 0],
      ["ordinary paths pass", accepted.every((value) => safeNextPath(value) === value)],
    ];
  });

  await assertSec("SEC-28", "security headers ship on every route (CSP report-only)", async () => {
    const config = (await import("../next.config.ts")).default;
    const routes = (await config.headers?.()) ?? [];
    const all = routes.find((route) => route.source === "/:path*")?.headers ?? [];
    const value = (key: string) => all.find((header) => header.key === key)?.value ?? "";
    return [
      ["X-Frame-Options SAMEORIGIN + CSP frame-ancestors 'self'", value("X-Frame-Options") === "SAMEORIGIN" && /frame-ancestors 'self'/.test(value("Content-Security-Policy-Report-Only"))],
      ["nosniff", value("X-Content-Type-Options") === "nosniff"],
      ["Referrer-Policy strict-origin-when-cross-origin", value("Referrer-Policy") === "strict-origin-when-cross-origin"],
      ["Permissions-Policy turns camera, microphone, geolocation off", /camera=\(\)/.test(value("Permissions-Policy")) && /microphone=\(\)/.test(value("Permissions-Policy")) && /geolocation=\(\)/.test(value("Permissions-Policy"))],
      ["HSTS", /max-age=\d+/.test(value("Strict-Transport-Security"))],
      ["CSP is report-only for now (enforcing it is backlog)", value("Content-Security-Policy-Report-Only") !== "" && value("Content-Security-Policy") === ""],
    ];
  });

  await assertSec("SEC-68", "X-Powered-By is off", async () => [
    ["poweredByHeader: false", (await import("../next.config.ts")).default.poweredByHeader === false],
  ]);

  await assertSec("SEC-69", "the Vercel region is pinned to Frankfurt in the repo", () => [
    ["vercel.json regions = [fra1]", JSON.stringify(JSON.parse(read("vercel.json")).regions) === '["fra1"]'],
  ]);

  await assertSec("SEC-33", "Supabase auth cookies are httpOnly; there is no browser client", () => {
    const env = read("lib/supabase/env.ts");
    return [
      ["both server clients pass supabaseCookieOptions()", /cookieOptions: supabaseCookieOptions\(\)/.test(read("lib/supabase/server.ts")) && /cookieOptions: supabaseCookieOptions\(\)/.test(read("lib/supabase/proxy.ts"))],
      ["the options are httpOnly and Secure in production", /httpOnly: true/.test(env) && /secure: process\.env\.NODE_ENV === "production"/.test(env)],
      ["lib/supabase/client.ts is gone", !existsSync(join(ROOT, "lib", "supabase", "client.ts"))],
    ];
  });

  await assertSec("SEC-34", "next is at or above 16.3.8", () => {
    const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "next", "package.json"), "utf8")).version as string;
    const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
    const ok = major > 16 || (major === 16 && (minor > 3 || (minor === 3 && patch >= 8)));
    return [[`installed next ${version}`, ok]];
  });

  await assertSec("SEC-35", "CLI tools are dev dependencies and CI audits production dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    return [
      ["shadcn and prisma are not production dependencies", !("shadcn" in pkg.dependencies) && !("prisma" in pkg.dependencies)],
      ["CI runs npm audit --omit=dev --audit-level=high", /npm audit --omit=dev --audit-level=high/.test(read(".github/workflows/ci.yml"))],
    ];
  });

  await assertSec("SEC-37", "no client module can import the service-role client, Prisma or the auth layer", () => {
    const serverOnly = new Set(["lib/supabase/admin.ts", "lib/db/client.ts", "lib/db/storage.ts", "lib/auth/session.ts"]);
    const files = [...walk("app"), ...walk("components"), ...walk("lib")];
    const resolveImport = (from: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith("@/")) base = spec.slice(2);
      else if (spec.startsWith(".")) base = relative(ROOT, resolve(ROOT, dirname(from), spec)).replace(/\\/g, "/");
      else return null;
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (existsSync(join(ROOT, candidate)) && statSync(join(ROOT, candidate)).isFile()) return candidate;
      }
      return null;
    };
    const importsOf = (file: string): string[] => {
      const source = read(file);
      const specs = [
        ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s*["']([^"']+)["']/gm),
        ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
        ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]);
      return specs.map((spec) => resolveImport(file, spec)).filter((path): path is string => path !== null);
    };
    const directive = (file: string, name: string) => new RegExp(`^\\s*["']${name}["']`).test(read(file));
    const leaks: string[] = [];
    for (const entry of files.filter((file) => directive(file, "use client"))) {
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        if (serverOnly.has(file)) {
          leaks.push(`${entry} → ${file}`);
          continue;
        }
        // A "use server" module is a Server Action boundary: the bundle gets
        // references, never the module's code.
        if (file !== entry && directive(file, "use server")) continue;
        queue.push(...importsOf(file));
      }
    }
    return [[`client import closures reaching server-only modules: ${leaks.length === 0 ? "none" : leaks.slice(0, 5).join("; ")}`, leaks.length === 0]];
  });

  await assertSec("SYS-STORAGE", "one storage seam: only the adapter talks to the provider, every file stays private (SYS)", () => {
    const files = [...walk("app"), ...walk("components"), ...walk("lib")];
    const callsStorageApi = files.filter((file) => /\.storage\s*\.\s*from\(/.test(read(file)));
    const importsAdmin = files.filter((file) => /from\s+["']@\/lib\/supabase\/admin["']/.test(read(file)));
    const importsAdapter = files.filter((file) => /from\s+["']@\/lib\/storage\/supabase["']/.test(read(file)));
    const facade = read("lib/db/storage.ts");
    // G2 (OD-14): the one extra importer. F2's ALLOW_UNVERIFIED_EMAIL_CHANGE path
    // sets an email through the admin API; remove it together with the flag in M20.
    const extraAdminImporter = "app/[locale]/account/actions.ts";
    const unexpectedAdminImporters = importsAdmin.filter((file) => file !== "lib/storage/supabase.ts" && file !== extraAdminImporter);
    return [
      [`only lib/storage/supabase.ts calls the Storage API (${callsStorageApi.join(", ") || "none"})`, callsStorageApi.length === 1 && callsStorageApi[0] === "lib/storage/supabase.ts"],
      [
        `only the adapter and ${extraAdminImporter} (ALLOW_UNVERIFIED_EMAIL_CHANGE path; remove together with the flag in M20) import the service-role client (${importsAdmin.join(", ") || "none"})`,
        importsAdmin.includes("lib/storage/supabase.ts") && unexpectedAdminImporters.length === 0,
      ],
      ["only lib/storage/index.ts picks the adapter", importsAdapter.length === 1 && importsAdapter[0] === "lib/storage/index.ts"],
      ["the tenant-scoped API reaches the provider only through storage()", /from "@\/lib\/storage"/.test(facade) && !/supabase/i.test(facade.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))],
      ["a browser gets a file only as a short-lived signed URL", /SIGNED_URL_TTL_SECONDS = 60 \* 10/.test(facade) && !/getPublicUrl/.test(files.map(read).join("\n"))],
    ];
  });

  await assertSec("SYS-TX", "money, seat and session-lifecycle transactions carry the write budget (SYS)", () => {
    const usesBudget = (path: string, name: string) => {
      const body = exportedBody(path, name);
      return /runInTransaction\(/.test(body) || /WRITE_TRANSACTION_OPTIONS/.test(body);
    };
    const sites: [string, string][] = [
      ["app/[locale]/(center)/expenses/actions.ts", "createExpenseAction"],
      ["app/[locale]/(center)/expenses/actions.ts", "voidExpenseAction"],
      ["app/[locale]/(center)/approvals/actions.ts", "approveReservationAction"],
      ["app/[locale]/(center)/classes/actions.ts", "enrollStudentAction"],
      ["app/[locale]/(student)/student/discover/actions.ts", "reserveClassAction"],
      ["app/[locale]/(teacher)/teacher/approvals/actions.ts", "approveOwnReservationAction"],
      ["lib/db/sessions.ts", "rescheduleSession"],
      ["lib/db/approvals.ts", "resolveSessionRequest"],
    ];
    return sites.map(([path, name]) => [`${name} (${path}) runs with WRITE_TRANSACTION_OPTIONS`, usesBudget(path, name)] as Step);
  });

  // ── Secrets & config ────────────────────────────────────────────────────

  await assertSec("SEC-38", "the seeded platform admin has its own password (D-21)", () => {
    const same = "x".repeat(16);
    return [
      ["the preflight/seed refuse SEED_ADMIN_PASSWORD == SEED_PASSWORD", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: same }).length > 0],
      ["they refuse a short admin password", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: "short" }).length > 0],
      ["two distinct ≥6-character passwords pass", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: "y".repeat(16) }).length === 0],
      ["the platform admin is created with the admin password", /admin: isPlatformAdmin/.test(read("prisma/seed.ts")) && /account\.admin \? this\.adminPassword : this\.password/.test(read("prisma/seed-data/auth.ts"))],
      [".env.example documents SEED_ADMIN_PASSWORD", /SEED_ADMIN_PASSWORD=/.test(read(".env.example"))],
    ];
  });

  await assertSec("U1", "the password policy is refused server-side on sign-up and change — never on sign-in", () => {
    const signUp = (password: string) =>
      signUpSchema.safeParse({
        signupIntent: "STUDENT",
        firstName: "A",
        lastName: "B",
        email: "u1@kayedu.test",
        password,
        confirmPassword: password,
        locale: "en",
      });
    const change = (newPassword: string) =>
      changePasswordSchema.safeParse({ currentPassword: "old", newPassword, confirmPassword: newPassword, signOutOthers: "true", locale: "en" });
    const message = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
      result.success ? "ok" : (result.error?.issues[0]?.message ?? "?");
    const good = "abcdef12";
    return [
      [`the minimum length is one constant (${PASSWORD_MIN_LENGTH})`, PASSWORD_MIN_LENGTH === 8],
      ["sign-up refuses 7 characters", message(signUp("abcde12")) === "passwordTooShort"],
      ["sign-up refuses no digit", message(signUp("abcdefgh")) === "passwordNeedsDigit"],
      ["sign-up refuses no letter", message(signUp("12345678")) === "passwordNeedsLetter"],
      ["sign-up accepts 8 characters with a letter and a digit", signUp(good).success],
      ["change password refuses 7 characters, no digit and no letter",
        message(change("abcde12")) === "passwordTooShort" &&
          message(change("abcdefgh")) === "passwordNeedsDigit" &&
          message(change("12345678")) === "passwordNeedsLetter"],
      ["change password accepts a compliant password", change(good).success],
      ["sign-in still accepts an old short password (existing accounts keep working)",
        signInSchema.safeParse({ email: "old@kayedu.test", password: "abc", locale: "en" }).success],
    ];
  });

  await assertSec("SEC-39", "no package script can run migrate dev / reset / db push", () => {
    const scripts = Object.values(JSON.parse(read("package.json")).scripts as Record<string, string>);
    const dangerous = scripts.filter((script) => /migrate dev|migrate reset|db push/.test(script));
    const refusal = read("scripts/refuse-migrate-dev.ts");
    return [
      [`dangerous scripts: ${dangerous.join(", ") || "none"}`, dangerous.length === 0],
      ["db:migrate refuses and points at migrate deploy", /migrate deploy/.test(refusal) && /process\.exit\(1\)/.test(refusal)],
    ];
  });

  await assertSec("SEC-67", "the limiter is a shared store with pruning, not a per-process Map", async () => {
    const key = `${PREFIX}prune-${randomBytes(4).toString("hex")}`;
    rateLimitKeys.add(key);
    await prisma.rateLimitBucket.create({ data: { key, windowStart: new Date(Date.now() - 3 * 864e5), count: 5 } });
    await pruneRateLimitBuckets();
    const left = await prisma.rateLimitBucket.count({ where: { key } });
    const fresh = `${PREFIX}fresh-${randomBytes(4).toString("hex")}`;
    rateLimitKeys.add(fresh);
    await awayFromWindowEdge(60_000, 5_000);
    const firstCall = await checkRateLimit(fresh, 1, 60_000);
    const secondCall = await checkRateLimit(fresh, 1, 60_000);
    return [
      ["no in-process Map in lib/rate-limit.ts", !/new Map/.test(read("lib/rate-limit.ts"))],
      ["windows older than a day are pruned", left === 0],
      ["a fixed window allows exactly the limit", firstCall && !secondCall],
    ];
  });

  await assertSec("SEC-70", "seed and wipe refuse production regardless of .env", () => [
    ["the production deployment's environment is refused", productionTargetReason({ VERCEL_ENV: "production" }) !== null && productionTargetReason({ KAYEDU_ENV: "production" }) !== null],
    ["an ordinary dev environment is not", productionTargetReason({}) === null],
    ["the seed, the wipe and the preflight all ask", /productionTargetReason\(\)/.test(read("prisma/seed.ts")) && /productionTargetReason\(\)/.test(read("scripts/wipe-dev-data.ts")) && /productionTargetReason\(\)/.test(read("prisma/seed-data/auth.ts"))],
  ]);

  await assertSec("S1", "gates and e2e write only to staging or a local database, never the dev project", () => {
    const pool = (ref: string) => `postgresql://postgres.${ref}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`;
    const dev = { DATABASE_URL: pool("devref"), DIRECT_URL: pool("devref") };
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; prisma: { seed: string } };
    return [
      ["dev's own environment is refused", writeRefusal({ ...dev }, dev) !== null],
      ["a staging run on another project is allowed (same-region pooler host)", writeRefusal({ KAYEDU_ENV: "staging", DATABASE_URL: pool("stgref"), DIRECT_URL: pool("stgref") }, dev) === null],
      ["a staging run pointed at dev is refused", writeRefusal({ KAYEDU_ENV: "staging", DATABASE_URL: pool("devref"), DIRECT_URL: pool("stgref") }, dev) !== null],
      ["a local database is allowed", writeRefusal({ DATABASE_URL: "postgresql://u:p@localhost:5433/t" }, dev) === null],
      ["the production marker is refused even on localhost", writeRefusal({ KAYEDU_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost:5433/t" }, dev) !== null],
      ["the gate client, check:all, gates:users and e2e all ask the guard", /assertSafeToWrite\(/.test(read("scripts/lib/gate-db.ts")) && /assertSafeToWrite\(/.test(read("scripts/run-gates.ts")) && /assertSafeToWrite\(/.test(read("scripts/gate-users.ts")) && /assertSafeToWrite\(/.test(read("playwright.config.ts"))],
      ["no package script loads .env on its own (one loader)", !Object.values(pkg.scripts).some((script) => /--env-file/.test(script)) && !/--env-file/.test(pkg.prisma.seed)],
      ["db:deploy:staging is migrate deploy through the staging loader", /with-env\.ts --staging --exec prisma migrate deploy$/.test(pkg.scripts["db:deploy:staging"] ?? "")],
      [".env.staging is git-ignored and its example is committed", /^\.env\.\*$/m.test(read(".gitignore")) && /^!\.env\.staging\.example$/m.test(read(".gitignore")) && existsSync(join(ROOT, ".env.staging.example"))],
    ];
  });

  // Not a finding of its own: the production guard must never fire off-production.
  await enforceProductionAuthSettings({ REQUIRE_EMAIL_CONFIRMATION: "false" });

  await sec2bMoney();
  await sec2cAssertions();
}

// ── SEC-2b: money integrity, concurrency, anti-fraud ──────────────────────
//
// Ported from the SEC-05/05-mechanism/06/06-race/07/08/12/13 repros (deleted
// once these printed NOT REPRODUCED) and from the stated gates of the
// Medium/Low findings. The concurrency assertions run REAL parallel
// transactions on two separate PrismaClients (two desks / two instances).

async function sec2bMoney() {
  console.log("\ncheck:security — SEC-2b (money integrity, concurrency, anti-fraud)\n");
  const deskA = await gatePrisma({ sweepUsers: false });
  const deskB = await gatePrisma({ sweepUsers: false });
  try {
    await sec2bAssertions(deskA, deskB);
  } finally {
    await Promise.all([deskA.$disconnect(), deskB.$disconnect()]);
  }
}

async function sec2bAssertions(deskA: PrismaClient, deskB: PrismaClient) {
  const TZ = "Africa/Cairo";
  const now = new Date();
  const today = todayInTimezone(TZ, now);
  const daysAgo = (n: number) => addDays(today, -n);
  const center = await makeCenter("m1");
  const centerId = center.id;
  const [method] = await listActivePaymentMethods(prisma, centerId);

  async function member(tag: string, role: "OWNER" | "MANAGER" | "TEACHER" | "RECEPTIONIST") {
    const user = await makeUser(tag);
    await prisma.membership.create({
      data: { centerId, userId: user.id, role, firstName: "Sec", lastName: tag, joinedAt: new Date() },
    });
    return user;
  }
  const owner = await member("m-owner", "OWNER");
  const managerA = await member("m-managerA", "MANAGER");
  const managerB = await member("m-managerB", "MANAGER");
  const teacher = await member("m-teacher", "TEACHER");

  /** A one-time session (own 20 % cut) on `date`, open all day. */
  async function session(date: Date, price = 10_000, teacherId = teacher.id) {
    return prisma.session.create({
      data: {
        centerId,
        teacherId,
        isManual: true,
        title: "SEC-2b",
        date,
        startTime: "00:00",
        endTime: "23:59",
        priceSnapshot: price,
        centerShareType: "PERCENTAGE",
        centerShareValue: 20,
      },
    });
  }
  let studentSeq = 0;
  async function student() {
    studentSeq += 1;
    return makeStudent(centerId, await makeUser(`m-student-${studentSeq}`));
  }
  /** A PRESENT roster row: the real check-in today, the scripts-only backfill in the past. */
  async function attendee(sessionId: string, past = false) {
    const profile = await student();
    return createAttendance(
      prisma,
      { centerId, sessionId, studentProfileId: profile.id, enrollmentId: null, isDropIn: true, recordedBy: managerA.id },
      past ? { historicalBackfill: true, status: "PRESENT" } : {},
    );
  }
  async function pay(attendeeId: string, past = false) {
    const result = await prisma.$transaction((tx) =>
      recordPayment(tx, centerId, attendeeId, method.id, managerA.id, past ? { historicalBackfill: true } : {}),
    );
    if (!result.ok) throw new Error(`fixture payment refused: ${result.error}`);
    return result.payment;
  }
  /** A past session with `n` paid students (closed lazily by whatever touches it next). */
  async function paidPastSession(n: number, ago: number, teacherId = teacher.id) {
    const s = await session(daysAgo(ago), 10_000, teacherId);
    const payments = [];
    for (let i = 0; i < n; i++) payments.push(await pay((await attendee(s.id, true)).id, true));
    return { session: s, payments, share: payments.reduce((sum, p) => sum + p.teacherShareSnapshot, 0) };
  }
  const owner1 = { userId: owner.id, isOwner: true };

  // ── Concurrency & integrity ───────────────────────────────────────────

  await assertSec("SEC-05", "two desks paying for one student at once record ONE payment (lock, fresh read, partial unique index)", async () => {
    const s = await session(today);
    let bad = 0;
    for (let i = 0; i < 4; i++) {
      const a = await attendee(s.id);
      const run = (client: PrismaClient) =>
        client.$transaction((tx) => recordPayment(tx, centerId, a.id, method.id, managerA.id), WRITE_TRANSACTION_OPTIONS);
      const results = await Promise.all([run(deskA), run(deskB)]);
      const active = await prisma.payment.count({ where: { sessionAttendeeId: a.id, voided: false } });
      const oneOk = results.filter((r) => r.ok).length === 1;
      const oneAlreadyPaid = results.some((r) => !r.ok && r.error === "alreadyPaid");
      if (active !== 1 || !oneOk || !oneAlreadyPaid) bad++;
    }
    const a = await attendee(s.id);
    const first = await pay(a.id);
    let databaseRefused = false;
    try {
      await prisma.payment.create({
        data: {
          centerId: first.centerId, sessionId: first.sessionId, teacherId: first.teacherId,
          sessionAttendeeId: first.sessionAttendeeId, studentProfileId: first.studentProfileId,
          amount: first.amount, paymentMethodId: first.paymentMethodId, methodLabelSnapshot: first.methodLabelSnapshot,
          priceSnapshot: first.priceSnapshot, centerShareSnapshot: first.centerShareSnapshot,
          teacherShareSnapshot: first.teacherShareSnapshot, recordedBy: first.recordedBy,
        },
      });
    } catch {
      databaseRefused = true;
    }
    const index = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Payment_one_active_per_attendee'`;
    // T5 — a refund frees the slot: refund → reset → re-check-in, then two
    // desks pay at once. Exactly one wins; the invariant (at most one payment
    // per attendee neither voided nor refunded) holds.
    let refundBad = 0;
    for (let i = 0; i < 3; i++) {
      const r = await attendee(s.id);
      const first = await pay(r.id);
      const back = await prisma.$transaction((tx) => refundPayment(tx, centerId, first.id, "cash back", managerA.id), WRITE_TRANSACTION_OPTIONS);
      const again = await recheckInAttendee(prisma, { centerId, attendeeId: r.id, recordedBy: managerA.id });
      const run = (client: PrismaClient) =>
        client.$transaction((tx) => recordPayment(tx, centerId, r.id, method.id, managerA.id), WRITE_TRANSACTION_OPTIONS);
      const results = await Promise.all([run(deskA), run(deskB)]);
      const active = await prisma.payment.count({ where: { sessionAttendeeId: r.id, voided: false, refunded: false } });
      const oneOk = results.filter((x) => x.ok).length === 1;
      const oneAlreadyPaid = results.some((x) => !x.ok && x.error === "alreadyPaid");
      if (!back.ok || !again.ok || active !== 1 || !oneOk || !oneAlreadyPaid) refundBad++;
    }
    const t5Migration = read("prisma/migrations/20261027190000_t5_void_refund_reset_attendance/migration.sql");
    const t5Predicate = t5Migration.match(/"Payment_one_active_per_attendee_t5"\s+ON "Payment"\("sessionAttendeeId"\) WHERE ([^;]+);/)?.[1];
    const conflict = read("lib/db/payments.ts").match(/ON CONFLICT \("sessionAttendeeId"\) WHERE (.+?) DO NOTHING/)?.[1];
    return [
      [`4 rounds × 2 concurrent payments: one ok + one alreadyPaid + one active row each (${bad} bad)`, bad === 0],
      ["a second active payment written around the app is refused by the database", databaseRefused],
      ["the partial unique index is WHERE voided = false", /UNIQUE/.test(index[0]?.indexdef ?? "") && /voided = false/.test(index[0]?.indexdef ?? "")],
      ["T5: the index is WHERE voided = false AND refunded = false (a refund frees the slot)", /voided = false\) AND \(refunded = false/.test(index[0]?.indexdef ?? "")],
      ["T5: recordPayment's ON CONFLICT predicate is the migration's index predicate, exactly", t5Predicate !== undefined && conflict !== undefined && t5Predicate.replace(/\s+/g, " ").trim() === conflict.replace(/\s+/g, " ").trim()],
      [`T5: refund → re-check-in → 2 concurrent payments ×3: one ok + one alreadyPaid + one active row each (${refundBad} bad)`, refundBad === 0],
      ["lockAttendeeRow re-reads the payment fact in a fresh statement after the lock", /FOR UPDATE OF a`;[\s\S]*SELECT EXISTS/.test(read("lib/db/session-lifecycle.ts"))],
    ];
  });

  await assertSec("SEC-12", "a void racing a refund (or itself) changes the payment once; never both flags", async () => {
    const s = await session(today);
    let bad = 0;
    for (let i = 0; i < 3; i++) {
      const p = await pay((await attendee(s.id)).id);
      const [refund, voided] = await Promise.all([
        deskA.$transaction((tx) => refundPayment(tx, centerId, p.id, "race", managerA.id), WRITE_TRANSACTION_OPTIONS),
        deskB.$transaction((tx) => voidPayment(tx, centerId, p.id, "race", managerB.id), WRITE_TRANSACTION_OPTIONS),
      ]);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id }, include: { refund: true } });
      const contribution = row.voided ? 0 : row.amount - (row.refund?.amount ?? 0);
      if ([refund.ok, voided.ok].filter(Boolean).length !== 1 || (row.voided && row.refunded) || contribution !== 0) bad++;
    }
    const v = await pay((await attendee(s.id)).id);
    const voids = await Promise.all([deskA, deskB].map((c) =>
      c.$transaction((tx) => voidPayment(tx, centerId, v.id, "twice", managerA.id), WRITE_TRANSACTION_OPTIONS)));
    const r = await pay((await attendee(s.id)).id);
    let refundThrew = false;
    let refunds: Awaited<ReturnType<typeof refundPayment>>[] = [];
    try {
      refunds = await Promise.all([deskA, deskB].map((c) =>
        c.$transaction((tx) => refundPayment(tx, centerId, r.id, "twice", managerA.id), WRITE_TRANSACTION_OPTIONS)));
    } catch {
      refundThrew = true;
    }
    let checkRefused = false;
    try {
      await prisma.payment.update({ where: { id: r.id }, data: { voided: true, refunded: true } });
    } catch {
      checkRefused = true;
    }
    return [
      [`refund ∥ void ×3: exactly one wins, never both flags, contribution 0 (${bad} bad)`, bad === 0],
      ["void ×2 at once: one ok, one alreadyVoided", voids.filter((x) => x.ok).length === 1 && voids.some((x) => !x.ok && x.error === "alreadyVoided")],
      ["refund ×2 at once: one ok, one alreadyRefunded, nothing thrown", !refundThrew && refunds.filter((x) => x.ok).length === 1 && refunds.some((x) => !x.ok && x.error === "alreadyRefunded")],
      ["the database refuses a payment both voided and refunded (CHECK)", checkRefused],
    ];
  });

  await assertSec("SEC-13", "concurrent enrolments never pass the room set's capacity (one locked seat claim)", async () => {
    const room = await prisma.room.create({ data: { centerId, name: `${PREFIX}room-13`, capacity: 2 } });
    const cls = await prisma.classGroup.create({
      data: {
        centerId, teacherId: teacher.id, roomId: room.id, price: 10_000, centerShareType: "PERCENTAGE", centerShareValue: 20,
        startDate: today, endDate: addDays(today, 30), acceptsNewStudents: true, requiresConfirmation: false,
      },
    });
    const users = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => makeUser(`m-enrol-${i}`)));
    const results = await Promise.all(users.map((user, i) =>
      (i % 2 === 0 ? deskA : deskB).$transaction(
        (tx) => reserveOrEnroll(tx, { centerId, classGroupId: cls.id, studentUserId: user.id }),
        WRITE_TRANSACTION_OPTIONS,
      )));
    const active = await prisma.enrollment.count({ where: { classGroupId: cls.id, status: "ACTIVE" } });
    const profiles = await prisma.studentProfile.count({ where: { centerId, userId: { in: users.map((u) => u.id) } } });
    return [
      [`6 at once into a cap-2 class: ${results.filter((r) => r.ok).length} enrolled, ${active} ACTIVE`, active === 2 && results.filter((r) => r.ok).length === 2],
      ["the other 4 are classFull", results.filter((r) => !r.ok && r.error === "classFull").length === 4],
      ["no profile was made for a student who got no seat", profiles === 2],
      ["the staff Enrol action and the approval path take the same locked claim", /claimClassSeat\(/.test(exportedBody("app/[locale]/(center)/classes/actions.ts", "enrollStudentAction")) && /claimClassSeat\(/.test(exportedBody("lib/db/reservations.ts", "confirmReservation"))],
    ];
  });

  // ── Settlements ───────────────────────────────────────────────────────

  await assertSec("SEC-06", "a payment belongs to at most one live settlement — shapes, overlaps and races included (D-05)", async () => {
    const t6 = await member("m-teacher6", "TEACHER");
    const a = await paidPastSession(3, 2, t6.id);
    const period = (client: PrismaClient, from: Date, to: Date, options: { now?: Date } = {}) =>
      client.$transaction((tx) => createPeriodSettlement(tx, centerId, t6.id, from, to, managerA.id, options), { ...WRITE_TRANSACTION_OPTIONS, timeout: 30_000 });
    const races = await Promise.all([period(deskA, daysAgo(2), daysAgo(2)), period(deskB, daysAgo(2), daysAgo(2))]);
    const live = () => prisma.settlement.findMany({ where: { centerId, teacherId: t6.id, status: { not: "CANCELLED" } } });
    const afterRace = (await live()).reduce((n, s) => n + s.totalAmount, 0);

    const b = await paidPastSession(2, 3, t6.id);
    const sessionRuns = await Promise.all([deskA, deskB].map((c) =>
      c.$transaction((tx) => createSessionSettlement(tx, centerId, b.session.id, managerA.id), WRITE_TRANSACTION_OPTIONS)));

    const c = await paidPastSession(1, 4, t6.id);
    await prisma.$transaction((tx) => createSessionSettlement(tx, centerId, c.session.id, managerA.id));
    const overC = await period(prisma, daysAgo(4), daysAgo(4));
    const ledger = a.share + b.share + c.share;
    const claimed = (await live()).reduce((n, s) => n + s.totalAmount, 0);

    // OD-8: a period settled while a session was still live leaves it out; a
    // later overlapping period picks it up once it has closed.
    const d = await paidPastSession(1, 5, t6.id);
    const whileLive = await period(prisma, daysAgo(5), daysAgo(5), { now: zonedDateTimeToUtc(dateKey(daysAgo(5)), 12 * 60, TZ) });
    const afterClose = await period(prisma, daysAgo(5), daysAgo(5));

    const target = (await live()).find((s) => s.status === "DRAFT")!;
    const approvals = await Promise.all([deskA, deskB].map((cl) =>
      cl.$transaction((tx) => approveSettlement(tx, centerId, target.id, owner1), WRITE_TRANSACTION_OPTIONS)));
    const pays = await Promise.all([deskA, deskB].map((cl) =>
      cl.$transaction((tx) => paySettlement(tx, centerId, target.id, owner1), WRITE_TRANSACTION_OPTIONS)));

    let secondClaimRefused = false;
    try {
      const claim = await prisma.settlementClaim.findFirstOrThrow({ where: { centerId, releasedAt: null } });
      await prisma.settlementClaim.create({ data: { centerId, settlementId: claim.settlementId, paymentId: claim.paymentId, teacherShare: claim.teacherShare } });
    } catch {
      secondClaimRefused = true;
    }
    return [
      [`period ×2 at once: one ok, one overlappingSettlement; claimed ${afterRace} of ${a.share}`, races.filter((r) => r.ok).length === 1 && races.some((r) => !r.ok && r.error === "overlappingSettlement") && afterRace === a.share],
      ["session ×2 at once: one ok, one sessionAlreadySettled", sessionRuns.filter((r) => r.ok).length === 1 && sessionRuns.some((r) => !r.ok && r.error === "sessionAlreadySettled")],
      [`session settlement then a period over it: the period claims nothing more (all live totals ${claimed} ≤ ledger ${ledger})`, overC.ok && overC.settlement.totalAmount === 0 && claimed <= ledger],
      ["OD-8: the payment a live-session period left out is claimed by a later overlapping period", whileLive.ok && whileLive.settlement.totalAmount === 0 && afterClose.ok && afterClose.settlement.totalAmount === d.share],
      ["approve ×2 and pay ×2 at once: each changes the settlement once", approvals.filter((r) => r.ok).length === 1 && pays.filter((r) => r.ok).length === 1],
      ["the database refuses a second live claim on one payment", secondClaimRefused],
    ];
  });

  await assertSec("SEC-23", "a period settlement is bounded, and a DRAFT can be cancelled to release its payments (D-16)", async () => {
    const t23 = await member("m-teacher23", "TEACHER");
    const p = await paidPastSession(2, 6, t23.id);
    const make = (from: Date, to: Date) =>
      prisma.$transaction((tx) => createPeriodSettlement(tx, centerId, t23.id, from, to, managerA.id), { ...WRITE_TRANSACTION_OPTIONS, timeout: 30_000 });
    const future = await make(daysAgo(10), dayMarker("9999-12-31"));
    const tooLong = await make(addDays(daysAgo(1), -400), daysAgo(1));
    const zod9999 = createPeriodSettlementSchema.safeParse({ locale: "en", teacherId: t23.id, from: "2026-10-01", to: "9999-12-31" });
    const draft = await make(daysAgo(6), daysAgo(6));
    const cancelled = draft.ok ? await prisma.$transaction((tx) => cancelSettlement(tx, centerId, draft.settlement.id, { userId: managerA.id })) : null;
    const again = await make(daysAgo(6), daysAgo(6));
    const approved = again.ok ? await prisma.$transaction((tx) => approveSettlement(tx, centerId, again.settlement.id, owner1)) : null;
    const cancelApproved = again.ok ? await prisma.$transaction((tx) => cancelSettlement(tx, centerId, again.settlement.id, { userId: managerA.id })) : null;
    return [
      ["`to` in the future (9999-12-31) is refused by direct call (futureRange)", !future.ok && future.error === "futureRange"],
      ["more than 366 days is refused (rangeTooLong)", !tooLong.ok && tooLong.error === "rangeTooLong"],
      ["the form schema refuses the 9999 range too", !zod9999.success],
      ["cancelling a DRAFT releases its claims", cancelled !== null && cancelled.ok && cancelled.releasedClaims === p.payments.length],
      ["…so a corrected settlement claims the same payments", again.ok && again.settlement.totalAmount === p.share],
      ["an APPROVED settlement is never cancelled (notDraft)", approved !== null && approved.ok && cancelApproved !== null && !cancelApproved.ok && cancelApproved.error === "notDraft"],
    ];
  });

  await assertSec("SEC-18", "a non-owner cannot approve or pay a settlement they created; an owner may, flagged (D-12)", async () => {
    const t18 = await member("m-teacher18", "TEACHER");
    await paidPastSession(1, 7, t18.id);
    const created = await prisma.$transaction((tx) => createPeriodSettlement(tx, centerId, t18.id, daysAgo(7), daysAgo(7), managerA.id));
    if (!created.ok) return [["fixture settlement", false]];
    const id = created.settlement.id;
    const selfApprove = await prisma.$transaction((tx) => approveSettlement(tx, centerId, id, { userId: managerA.id, isOwner: false }));
    const other = await prisma.$transaction((tx) => approveSettlement(tx, centerId, id, { userId: managerB.id, isOwner: false }));
    const selfPay = await prisma.$transaction((tx) => paySettlement(tx, centerId, id, { userId: managerA.id, isOwner: false }));
    const otherPay = await prisma.$transaction((tx) => paySettlement(tx, centerId, id, { userId: managerB.id, isOwner: false }));
    await paidPastSession(1, 8, t18.id);
    const ownerMade = await prisma.$transaction((tx) => createPeriodSettlement(tx, centerId, t18.id, daysAgo(8), daysAgo(8), owner.id));
    const ownerSelf = ownerMade.ok ? await prisma.$transaction((tx) => approveSettlement(tx, centerId, ownerMade.settlement.id, owner1)) : null;
    const actions = read("app/[locale]/(center)/settlements/actions.ts");
    return [
      ["the creator (MANAGER) is refused approval (ownSettlement)", !selfApprove.ok && selfApprove.error === "ownSettlement"],
      ["another manager approves (not flagged)", other.ok && !other.selfApproved],
      ["the creator is refused payment too; another manager pays", !selfPay.ok && selfPay.error === "ownSettlement" && otherPay.ok],
      ["an OWNER may approve their own settlement, and it is flagged selfApproved", ownerSelf !== null && ownerSelf.ok && ownerSelf.selfApproved],
      ["the actions pass the actor's OWNER-ness and audit selfApproved", /isOwner: ctx\.roles\.includes\("OWNER"\)/.test(actions) && (actions.match(/selfApproved: (approved|paid)\.selfApproved/g) ?? []).length === 2],
    ];
  });

  // ── Fraud visibility ──────────────────────────────────────────────────

  await assertSec("SEC-07", "voids and unpaid check-ins are visible: an audit screen and the receipt (D-06)", async () => {
    const s = await session(today);
    const paid = await pay((await attendee(s.id)).id);
    await attendee(s.id); // present, never paid
    await prisma.$transaction(async (tx) => {
      const voided = await voidPayment(tx, centerId, paid.id, "Wrong student", managerA.id);
      if (!voided.ok) throw new Error(voided.error);
      await writeAuditRow(tx, {
        centerId, actorUserId: managerA.id, action: "payment.void", entityType: "Payment", entityId: paid.id,
        before: { amount: paid.amount, voided: false }, after: { voided: true, sessionId: s.id },
      });
    });
    const totals = await sessionReceiptTotals(prisma, centerId, s.id);
    const lines = await sessionReceiptLines(prisma, centerId, s.id);
    const feed = await loadAuditFeed(prisma, centerId, "voids", { take: 50, skip: 0 });
    const unpaid = await loadUnpaidCheckIns(prisma, centerId, daysAgo(30), { take: 50, skip: 0 });
    const page = read("app/[locale]/(center)/audit/page.tsx");
    const receipt = read("app/[locale]/(center)/sessions/[id]/session-receipt.tsx");
    const entry = feed.entries.find((e) => e.entityId === paid.id);
    return [
      // T5 (old → new, by instruction): the live void resets the voided
      // student to Not arrived, so one present-but-unpaid student remains.
      ["the receipt counts the void and the unpaid check-in", totals.voidedCount === 1 && totals.voidedAmount === paid.amount && totals.unpaidCount === 1 && totals.notArrivedCount === 1],
      ["the receipt lists the void with its actor and reason", lines.voids.length === 1 && lines.voids[0].reason === "Wrong student" && lines.voids[0].voidedByName !== null],
      ["the receipt lists the present-but-unpaid student", lines.unpaid.length === 1],
      ["SessionReceipt renders the voided and unpaid sections", /voidsTitle/.test(receipt) && /unpaidTitle/.test(receipt) && /voidedLine/.test(receipt)],
      ["the audit feed shows the void with its amount, student and reason", entry !== undefined && entry.amount === paid.amount && entry.reason === "Wrong student" && entry.subjectName !== null],
      ["the unpaid list is filterable and centre-scoped", unpaid.rows.some((row) => row.sessionId === s.id)],
      ["/audit is gated on audit.view and reads the feed", /requirePermission\(ctx, "audit\.view"\)/.test(page) && /loadAuditFeed\(/.test(page) && /loadUnpaidCheckIns\(/.test(page)],
      ["the unpaid list is clamped to the visibility window; the trail is not", /loadUnpaidCheckIns\(prisma, ctx\.center\.id, visibilityWindowFloor\(ctx\)/.test(page) && !/loadAuditFeed\([^)]*visibility/.test(page)],
    ];
  });

  await assertSec("SEC-19", "the session receipt subtracts refunds and shows them", async () => {
    const s = await session(today);
    const kept = await pay((await attendee(s.id)).id);
    const back = await pay((await attendee(s.id)).id);
    const refunded = await prisma.$transaction((tx) => refundPayment(tx, centerId, back.id, "cash back", managerA.id));
    const totals = await sessionReceiptTotals(prisma, centerId, s.id);
    const lines = await sessionReceiptLines(prisma, centerId, s.id);
    return [
      ["collected = paid − refunded, and both shares net of the reversal", refunded.ok && totals.collected === kept.amount && totals.teacherShare === kept.teacherShareSnapshot && totals.centerShare === kept.centerShareSnapshot],
      ["the refund is counted and listed with its reason", totals.refundedCount === 1 && totals.refundedAmount === back.amount && lines.refunds.length === 1 && lines.refunds[0].reason === "cash back"],
      ["SessionReceipt renders the refunds line and section", /refundedLine/.test(read("app/[locale]/(center)/sessions/[id]/session-receipt.tsx")) && /refundsTitle/.test(read("app/[locale]/(center)/sessions/[id]/session-receipt.tsx"))],
    ];
  });

  await assertSec("SEC-08", "a paid session cannot be cancelled or rescheduled; a cancelled one closes at day end and refuses money (D-07)", async () => {
    const s = await session(today);
    const p = await pay((await attendee(s.id)).id);
    const cancel = await cancelSession(prisma, centerId, s.id);
    const tomorrow = await session(addDays(today, 1));
    const tp = await pay((await attendee(tomorrow.id, true)).id, true);
    const move = await rescheduleSession(prisma, centerId, tomorrow.id, { date: addDays(today, 2), startTime: "10:00", endTime: "11:00" }, "WARN", "en", { confirmConflicts: true });
    // Refunded money is back with the student, so it no longer blocks.
    await prisma.$transaction((tx) => refundPayment(tx, centerId, p.id, "teacher left early", managerA.id));
    const cancelAfterRefund = await cancelSession(prisma, centerId, s.id);
    const closedNextDay = await closeSessionIfDayOver(prisma, centerId, s.id, addDays(now, 1));
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    // T5: the live refund reset its drop-in to Not arrived (an ABSENT row that
    // is no absence); "no absences" = none materialized for enrolled students.
    const absences = await prisma.sessionAttendee.count({ where: { sessionId: s.id, attendanceStatus: "ABSENT", isDropIn: false } });
    // A legacy cancelled session still holding a payment: no void/refund path stays open.
    const legacy = await session(today);
    const lp = await pay((await attendee(legacy.id)).id);
    await prisma.session.update({ where: { id: legacy.id }, data: { status: "CANCELLED" } });
    const voidLegacy = await prisma.$transaction((tx) => voidPayment(tx, centerId, lp.id, "late", managerA.id));
    const refundLegacy = await prisma.$transaction((tx) => refundPayment(tx, centerId, lp.id, "late", managerA.id));
    // The old repro: a past payment voided months later with the real clock.
    const old = await paidPastSession(1, 20);
    const voidOld = await prisma.$transaction((tx) => voidPayment(tx, centerId, old.payments[0].id, "months later", managerA.id));
    return [
      ["cancelling a session with an active payment is refused (hasPayments)", !cancel.ok && cancel.error === "hasPayments"],
      ["rescheduling one is refused too", !move.ok && move.error === "hasPayments" && Boolean(tp)],
      ["once the payment is refunded the cancel goes through", cancelAfterRefund.ok],
      ["the cancelled session closes at the end of its day — status kept, no absences", closedNextDay && row.closedAt !== null && row.status === "CANCELLED" && absences === 0],
      ["a cancelled session refuses void and refund", !voidLegacy.ok && voidLegacy.error === "sessionCancelled" && !refundLegacy.ok && refundLegacy.error === "sessionCancelled"],
      ["a payment on an ended day cannot be voided later (sessionClosed)", !voidOld.ok && voidOld.error === "sessionClosed"],
    ];
  });

  await assertSec("SEC-20", "switching a paid student to Absent needs a reason (D-13)", async () => {
    const s = await session(today);
    const a = await attendee(s.id);
    const p = await pay(a.id);
    const without = await changeAttendanceStatus(prisma, { centerId, attendeeId: a.id, status: "ABSENT", changedBy: managerA.id, mayVoidPayment: true });
    const still = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    const withReason = await changeAttendanceStatus(prisma, { centerId, attendeeId: a.id, status: "ABSENT", changedBy: managerA.id, reason: "Left early", mayVoidPayment: true });
    const b = await attendee(s.id);
    const unpaidChange = await changeAttendanceStatus(prisma, { centerId, attendeeId: b.id, status: "LATE", changedBy: managerA.id, mayVoidPayment: false });
    const zodNoReason = setAttendanceSchema.safeParse({ locale: "en", sessionId: s.id, studentProfileId: "x", status: "ABSENT", confirmVoid: "true" });
    const zodReason = setAttendanceSchema.safeParse({ locale: "en", sessionId: s.id, studentProfileId: "x", status: "ABSENT", confirmVoid: "true", reason: "Left early" });
    const action = exportedBody("app/[locale]/(center)/sessions/actions.ts", "setAttendanceAction");
    return [
      ["without a reason it is refused (reasonRequired) and the payment stands", !without.ok && without.error === "reasonRequired" && !still.voided],
      ["with a reason it voids, and the reason is on the payment and the change row", withReason.ok && withReason.voidedPayment?.voidReason === "Left early" && withReason.change?.reason === "Left early"],
      ["a change that voids nothing keeps the reason optional", unpaidChange.ok],
      ["the zod schema refuses a confirmed void without a reason", !zodNoReason.success && zodReason.success],
      ["the Server Action refuses it too", /reasonRequired/.test(action)],
    ];
  });

  await assertSec("SEC-21", "a timezone edit never reopens or moves a session already created (D-14)", async () => {
    await prisma.centerSettings.update({ where: { centerId }, data: { timezone: TZ } });
    const day = dayMarker("2026-10-13");
    const s = await session(day);
    const frozen = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    await prisma.session.update({ where: { id: s.id }, data: { timezone: "Etc/GMT+12" } });
    const afterEdit = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    // 01:00 Cairo on 14 Oct is still 13 Oct at UTC−12: the old live read let
    // a manager reopen the 13th by switching the centre to that zone.
    await prisma.centerSettings.update({ where: { centerId }, data: { timezone: "Etc/GMT+12" } });
    const at = zonedDateTimeToUtc("2026-10-14", 60, TZ);
    let refused: string | null = null;
    try {
      await createAttendance(prisma, { centerId, sessionId: s.id, studentProfileId: (await student()).id, enrollmentId: null, isDropIn: true, recordedBy: managerA.id }, { now: at });
    } catch (error) {
      refused = error instanceof SessionClosedError ? error.reason : String(error);
    }
    const created = await session(today);
    const createdRow = await prisma.session.findUniqueOrThrow({ where: { id: created.id } });
    await prisma.centerSettings.update({ where: { centerId }, data: { timezone: TZ } });
    return [
      ["a new session freezes the centre's timezone", frozen.timezone === TZ],
      ["a session's timezone never changes afterwards (trigger)", afterEdit.timezone === TZ],
      ["switching the centre to a zone where that day is 'today' does not reopen it", refused === "sessionClosed"],
      ["a session created after the edit takes the new zone", createdRow.timezone === "Etc/GMT+12"],
      ["the write guard reads the session's own timezone first", /COALESCE\(s\."timezone", cs\."timezone"\)/.test(read("lib/db/session-lifecycle.ts"))],
    ];
  });

  await assertSec("SEC-22", "a FIXED centre cut above the price is refused, at configuration and when a price is lowered (D-15)", async () => {
    const base = { locale: "en", teacherId: "t", roomId: "r", startDate: "2026-10-09", endDate: "2027-04-01", lateThresholdMinutes: "10" };
    const issue = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
      result.success ? null : result.error!.issues.map((i) => `${i.path.join(".")}:${i.message}`).join(",");
    const classAbove = issue(classGroupSchema.safeParse({ ...base, price: "100", centerShareType: "FIXED", shareValue: "500" }));
    const lowered = issue(classGroupUpdateSchema.safeParse({ ...base, id: "c", price: "10", centerShareType: "FIXED", shareValue: "15" }));
    const oneOff = issue(newOneOffSessionSchema.safeParse({
      locale: "en", mode: "oneOff", title: "x", teacherId: "t", roomId: "r", date: dateKey(addDays(today, 3)), startTime: "10:00", endTime: "11:00",
      price: "100", centerShareType: "FIXED", shareValue: "500",
    }));
    const s = await session(today, 10_000);
    const override = await updateSessionShareOverride(prisma, centerId, s.id, { centerShareType: "FIXED", centerShareValue: 20_000 });
    return [
      ["a class at 100 EGP with FIXED 500 EGP is refused (fixedAbovePrice)", classAbove === "shareValue:fixedAbovePrice"],
      ["lowering a class's price below its FIXED cut is refused", lowered === "shareValue:fixedAbovePrice"],
      ["the same for a one-time session", oneOff === "shareValue:fixedAbovePrice"],
      ["a session's cut override above its price is refused by direct call", !override.ok && override.error === "fixedAbovePrice"],
      ["the data layer refuses it on class create and edit", classMoneyError({ price: 10_000, centerShareType: "FIXED", centerShareValue: 50_000 }) === "fixedAbovePrice" && /classMoneyError\(input\)/.test(exportedBody("lib/db/class-sessions.ts", "updateClassWithSessions")) && /classMoneyError\(input\)/.test(exportedBody("lib/db/class-sessions.ts", "createClassWithSessions"))],
      ["splitShare still clamps (the backstop for older rows)", splitShare(10_000, "FIXED", 50_000).teacherShare === 0],
    ];
  });

  await assertSec("SEC-24", "money sums are 64-bit and a price is capped (D-17)", async () => {
    const s = await session(daysAgo(9), 10_000);
    for (let i = 0; i < 3; i++) {
      const a = await attendee(s.id, true);
      const profileId = a.studentProfileId!;
      await prisma.payment.create({
        data: {
          centerId, sessionId: s.id, teacherId: teacher.id, sessionAttendeeId: a.id, studentProfileId: profileId,
          amount: 1_000_000_000, paymentMethodId: method.id, methodLabelSnapshot: method.name, priceSnapshot: 1_000_000_000,
          centerShareSnapshot: 0, teacherShareSnapshot: 1_000_000_000, recordedBy: managerA.id,
        },
      });
    }
    let threw = false;
    let revenue = 0;
    let receipt = 0;
    let settle: Awaited<ReturnType<typeof createSessionSettlement>> | null = null;
    try {
      revenue = (await revenueTotals(prisma, centerId, { from: daysAgo(9), to: daysAgo(9) })).collected;
      receipt = (await sessionReceiptTotals(prisma, centerId, s.id)).collected;
      settle = await prisma.$transaction((tx) => createSessionSettlement(tx, centerId, s.id, managerA.id));
    } catch {
      threw = true;
    }
    return [
      ["three 10M EGP payments sum to 30M EGP in analytics and on the receipt, without throwing", !threw && revenue === 3_000_000_000 && receipt === 3_000_000_000],
      ["a settlement beyond the integer ceiling is refused, not thrown (totalTooLarge)", settle !== null && !settle.ok && settle.error === "totalTooLarge"],
      [`a price is capped at ${MAX_PRICE_PIASTRES / 100} EGP`, parseEgpToPiastres("100001", MAX_PRICE_PIASTRES) === null && parseEgpToPiastres("100000", MAX_PRICE_PIASTRES) === MAX_PRICE_PIASTRES],
      ["no Prisma _sum over a money column remains in the app", !walk("app").concat(walk("lib")).some((f) => /_sum: \{[^}]*(amount|Share|totalAmount)/.test(read(f)))],
    ];
  });

  await assertSec("SEC-29", "audit rows carry ids and amounts only — no names, contacts or free text (D-20; retention stays OPEN)", async () => {
    let refused = false;
    try {
      await prisma.$transaction((tx) => writeAuditRow(tx, { centerId, actorUserId: managerA.id, action: "payment.void", entityType: "Payment", entityId: "x", after: { reason: "free text" } }));
    } catch (error) {
      refused = error instanceof AuditPayloadError;
    }
    const written = await prisma.auditLog.count({ where: { centerId, entityId: "x" } });
    const writers = walk("app").concat(walk("lib")).filter((f) => f !== "lib/db/audit-row.ts" && /\.auditLog\.create(Many)?\(/.test(read(f)));
    const literalHits: string[] = [];
    for (const file of walk("app").concat(walk("lib"), walk("prisma"))) {
      const source = read(file);
      const re = /(writeAuditLog|writeAuditRow|auditRowData|\baudit)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < source.length; i++) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")" && --depth === 0) break;
        }
        const body = source.slice(m.index, i + 1);
        if (/action: "platform\.catalog\./.test(body)) continue;
        for (const key of FORBIDDEN_AUDIT_KEYS) {
          if (new RegExp(`[\\s{,]${key}\\s*[:,}]`).test(body)) literalHits.push(`${file}:${key}`);
        }
      }
    }
    return [
      ["a payload with a free-text key is refused before anything is written", refused && written === 0],
      ["forbiddenAuditKey finds a name at any depth", forbiddenAuditKey({ a: [{ b: { firstName: "x" } }] }) === "firstName" && forbiddenAuditKey({ amount: 1, voided: true }) === null],
      [`every audit write goes through lib/db/audit-row.ts (${writers.join(", ") || "none other"})`, writers.length === 0],
      [`no audit payload in the source names a forbidden key (${literalHits.slice(0, 4).join(", ") || "none"})`, literalHits.length === 0],
    ];
  });

  await assertSec("SEC-50", "dates are strict calendar days everywhere they are typed", async () => {
    const bad = ["March 5 2026", "2026-02-30", "2026-01-01T10:00"];
    const refusedBy = (parse: (date: string) => boolean) => bad.every((date) => !parse(date));
    const s = await session(addDays(today, 5));
    const badRequest = await prisma.changeRequest.create({
      data: { centerId, type: "NEW_SESSION", requestedBy: teacher.id, status: "PENDING", payload: { classGroupId: "missing", date: "2026-02-30", startTime: "10:00", endTime: "11:00", note: null } },
    });
    const resolved = await resolveSessionRequest(prisma, centerId, badRequest.id, "APPROVED", managerA.id, "WARN", "en", { confirmConflicts: true });
    return [
      ["reschedule", refusedBy((date) => rescheduleSessionSchema.safeParse({ locale: "en", sessionId: s.id, date, startTime: "10:00", endTime: "11:00" }).success)],
      ["holiday", refusedBy((date) => holidaySchema.safeParse({ locale: "en", date }).success)],
      ["period settlement", refusedBy((date) => createPeriodSettlementSchema.safeParse({ locale: "en", teacherId: "t", from: date, to: date }).success)],
      ["expense", refusedBy((date) => expenseCreateSchema.safeParse({ locale: "en", amount: "10", date }).success)],
      ["a teacher's session request", refusedBy((date) => sessionRequestSchema.safeParse({ locale: "en", classGroupId: "c", date, startTime: "10:00", endTime: "11:00" }).success)],
      ["a stored request with an impossible date is refused on approval, never thrown", !resolved.ok && resolved.error === "invalidDate"],
    ];
  });

  await assertSec("SEC-51", "no backdating: reschedule and approval refuse the past; expenses are voided within the window (D-24)", async () => {
    const s = await session(addDays(today, 3));
    const back = await rescheduleSession(prisma, centerId, s.id, { date: daysAgo(1), startTime: "10:00", endTime: "11:00" }, "WARN", "en", { confirmConflicts: true });
    const cls = await prisma.classGroup.create({
      data: { centerId, teacherId: teacher.id, price: 10_000, centerShareType: "PERCENTAGE", centerShareValue: 20, startDate: daysAgo(30), endDate: addDays(today, 30) },
    });
    const request = await prisma.changeRequest.create({
      data: { centerId, type: "NEW_SESSION", requestedBy: teacher.id, status: "PENDING", payload: { classGroupId: cls.id, date: dateKey(daysAgo(1)), startTime: "10:00", endTime: "11:00", note: null } },
    });
    const approve = await resolveSessionRequest(prisma, centerId, request.id, "APPROVED", managerA.id, "WARN", "en", { confirmConflicts: true });
    const vctx = { isPlatformAdmin: false, settings: { centerDataVisibilityDays: 30, teacherDataVisibilityDays: 30, timezone: TZ } };
    const expenses = read("app/[locale]/(center)/expenses/actions.ts");
    return [
      ["rescheduling into the past is refused (pastDate)", !back.ok && back.error === "pastDate"],
      ["approving a NEW_SESSION request for yesterday is refused (pastDate)", !approve.ok && approve.error === "pastDate"],
      ["an expense may be backdated within the window, never before it or into the future", expenseDateError(vctx, daysAgo(10), now) === null && expenseDateError(vctx, daysAgo(45), now) === "beforeWindow" && expenseDateError(vctx, addDays(today, 1), now) === "futureDate"],
      ["an expense is voided with a reason, never deleted", /voidExpenseAction/.test(expenses) && !/expense\.delete|expenses\.remove|deleteExpenseAction/.test(expenses) && !/remove:/.test(read("lib/db/scoped.ts").split("expenses: {")[1]?.split("settings: {")[0] ?? "remove:")],
      ["category create/rename/toggle/delete are audited", ["expenseCategory.create", "expenseCategory.rename", "expenseCategory.activate", "expenseCategory.delete"].every((action) => expenses.includes(action))],
      ["voided expenses leave every total", /e\."voided" = false/.test(read("lib/db/analytics.ts"))],
    ];
  });

  await assertSec("SEC-58", "a free one-time session needs an explicit confirmation and is flagged (D-26)", async () => {
    const input = {
      locale: "en", mode: "oneOff", title: "Free", teacherId: "t", roomId: "r", date: dateKey(addDays(today, 3)), startTime: "10:00", endTime: "11:00",
      price: "0", centerShareType: "PERCENTAGE", shareValue: "0",
    };
    const unconfirmed = newOneOffSessionSchema.safeParse(input);
    const confirmed = newOneOffSessionSchema.safeParse({ ...input, confirmZeroPrice: "on" });
    const s = await session(today, 0);
    const totals = await sessionReceiptTotals(prisma, centerId, s.id);
    return [
      ["price 0 without the tick is refused (zeroPriceNeedsConfirmation)", !unconfirmed.success && unconfirmed.error.issues.some((i) => i.message === "zeroPriceNeedsConfirmation")],
      ["with the tick it is allowed", confirmed.success && confirmed.data.price === 0],
      ["its receipt is flagged as free", totals.zeroPriced],
      ["the session page badges it", /priceSnapshot === 0 \? <Badge/.test(read("app/[locale]/(center)/sessions/[id]/page.tsx"))],
    ];
  });

  await assertSec("SEC-59", "a rating needs real attendance inside the 7-day window", async () => {
    const studentUser = await makeUser("m-rater");
    const profile = await makeStudent(centerId, studentUser);
    const row = (sessionId: string, status: "PRESENT" | "ABSENT") =>
      prisma.sessionAttendee.create({ data: { centerId, sessionId, studentProfileId: profile.id, attendanceStatus: status, recordedBy: managerA.id } });
    const absent = await session(daysAgo(2));
    await row(absent.id, "ABSENT");
    const old = await session(daysAgo(9));
    await row(old.id, "PRESENT");
    const recent = await session(daysAgo(1));
    await row(recent.id, "PRESENT");
    const never = await session(daysAgo(1));
    const rateAbsent = await submitSessionRating(prisma, { studentUserId: studentUser.id, sessionId: absent.id, score: 1 });
    const rateOld = await submitSessionRating(prisma, { studentUserId: studentUser.id, sessionId: old.id, score: 1 });
    const rateRecent = await submitSessionRating(prisma, { studentUserId: studentUser.id, sessionId: recent.id, score: 4 });
    await skipSessionRating(prisma, { studentUserId: studentUser.id, sessionId: never.id });
    const skips = await prisma.sessionRatingSkip.count({ where: { studentUserId: studentUser.id, sessionId: never.id } });
    return [
      ["rating an ABSENT session is refused (notAttended)", !rateAbsent.ok && rateAbsent.error === "notAttended"],
      ["rating a 9-day-old session is refused (notAttended)", !rateOld.ok && rateOld.error === "notAttended"],
      ["rating an attended session from yesterday works", rateRecent.ok],
      ["skipping a session the student never attended writes nothing", skips === 0],
    ];
  });

  await assertSec("SEC-60", "the audit log is append-only and money audit rows commit with the money", async () => {
    const row = await writeAuditRow(prisma, { centerId, actorUserId: managerA.id, action: "seccheck.append", entityType: "Center", entityId: centerId });
    let updateRefused = false;
    try {
      await prisma.auditLog.update({ where: { id: row.id }, data: { action: "tampered" } });
    } catch {
      updateRefused = true;
    }
    let deleteRefused = false;
    try {
      await prisma.auditLog.delete({ where: { id: row.id } });
    } catch {
      deleteRefused = true;
    }
    const s = await session(today);
    const a = await attendee(s.id);
    let rolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        const paid = await recordPayment(tx, centerId, a.id, method.id, managerA.id);
        if (!paid.ok) throw new Error(paid.error);
        await writeAuditRow(tx, { centerId, actorUserId: managerA.id, action: "payment.record", entityType: "Payment", entityId: paid.payment.id, after: { note: "forced audit failure" } });
      });
    } catch {
      rolledBack = (await prisma.payment.count({ where: { sessionAttendeeId: a.id } })) === 0;
    }
    const sessions = read("app/[locale]/(center)/sessions/actions.ts");
    const reception = read("app/[locale]/(center)/reception/actions.ts");
    const settlements = read("app/[locale]/(center)/settlements/actions.ts");
    const inTx = (body: string) => /writeAuditLog\(\s*\{[\s\S]*?\},\s*tx,\s*\)|writePaymentRecordAudit\(tx,/.test(body);
    return [
      ["UPDATE of an audit row is refused", updateRefused],
      ["DELETE of an audit row is refused outside a maintenance transaction", deleteRefused],
      ["an audit failure rolls the payment back with it", rolledBack],
      ["record/void/refund write their audit row on the money transaction", ["recordPaymentAction", "voidPaymentAction", "refundPaymentAction"].every((name) => inTx(exportedBody("app/[locale]/(center)/sessions/actions.ts", name))) && /writePaymentRecordAudit\(tx,/.test(sessions)],
      ["the reception check-in payment too", /writePaymentRecordAudit\(tx,/.test(reception)],
      ["every settlement transition too", ["createSessionSettlementAction", "createPeriodSettlementAction", "approveSettlementAction", "paySettlementAction", "cancelSettlementAction"].every((name) => inTx(exportedBody("app/[locale]/(center)/settlements/actions.ts", name))) && settlements.length > 0],
    ];
  });

  await assertSec("SEC-74", "EGP amounts parse strictly; the settings audit row is complete", () => [
    ["`1e3`, `0x10`, `0.001`, `-5` and `12,5` are refused", ["1e3", "0x10", "0.001", "-5", "12,5"].every((value) => parseEgpToPiastres(value) === null)],
    ["`120`, `12.5` and Arabic-Indic `١٢٠` parse exactly", parseEgpToPiastres("120") === 12_000 && parseEgpToPiastres("12.5") === 1_250 && parseEgpToPiastres(String.fromCodePoint(0x0661, 0x0662, 0x0660)) === 12_000],
    ["the client previews use the same parser", ["components/center/class-fields.tsx", "app/[locale]/(center)/sessions/new-session-dialog.tsx", "app/[locale]/(center)/settings/general-form.tsx"].every((file) => /parseEgpToPiastres\(/.test(read(file)) && !/Math\.round\([^)]*\* 100\)/.test(read(file)))],
    ["the general-settings audit row includes teacherEditDeadlineHours", /teacherEditDeadlineHours: before\.teacherEditDeadlineHours/.test(read("app/[locale]/(center)/settings/actions.ts"))],
  ]);
}


// ── SEC-2c: validation, injection, availability, D-18 limits ──────────────

async function sec2cAssertions() {
  console.log("\ncheck:security — SEC-2c (validation, injection, availability, abuse limits)\n");
  const TZ = "Africa/Cairo";
  const today = todayInTimezone(TZ);
  const center = await makeCenter("c1");
  const teacher = await makeUser("c-teacher");
  createdUserIds.add(teacher.id);
  await prisma.membership.create({ data: { centerId: center.id, userId: teacher.id, role: "TEACHER", joinedAt: new Date() } });

  await assertSec("SEC-25", "the teach-here request and the Approvals queues are bounded", () => {
    const action = exportedBody("app/[locale]/(teacher)/teacher/centers/actions.ts", "requestToTeachAction");
    const page = read("app/[locale]/(center)/approvals/page.tsx");
    const scopedSource = read("lib/db/scoped.ts");
    // G2 (OD-14): F7 moved every Approvals count into lib/db/approval-counts.ts.
    const countsSource = read("lib/db/approval-counts.ts");
    const pendingBody = countsSource.slice(countsSource.indexOf("export async function pendingApprovalCounts("), countsSource.indexOf("export type PendingTeacherApprovalCounts"));
    const bookingCountStart = scopedSource.indexOf("countPending: async (options");
    const bookingCountBody = scopedSource.slice(bookingCountStart, scopedSource.indexOf("listConfirmedForSession", bookingCountStart));
    const changeRequestLists = page.match(/changeRequests\.list\(/g) ?? [];
    return [
      ["a requester who already teaches somewhere is refused on the server (alreadyTeaching)", /roles\.includes\("TEACHER"\)/.test(action) && /alreadyTeaching/.test(action)],
      ["per-account and per-IP limits in the shared store", /teachRequestPerUser/.test(action) && /teachRequestPerIp/.test(action) && "teachRequestPerUser" in RATE_LIMITS && "teachRequestPerIp" in RATE_LIMITS],
      ["one PENDING request per (requester, centre), serialized per pair (alreadyRequested)", /pg_advisory_xact_lock/.test(action) && /status: "PENDING"/.test(action) && /alreadyRequested/.test(action)],
      [
        "each Approvals list read is capped at one page (the two change-request lists, the enrolment list; bookings are sliced to a page)",
        /const page = \{ take: APPROVALS_PAGE_SIZE \}/.test(page) &&
          /const oldestFirst = \{ \.\.\.page, order: "asc"/.test(page) &&
          changeRequestLists.length === 2 &&
          (page.match(/changeRequests\.list\([^)]*oldestFirst\)/g) ?? []).length === 2 &&
          /reservations\.listPending\(page\)/.test(page) &&
          /allBookings\.slice\(0, APPROVALS_PAGE_SIZE\)/.test(page) &&
          /options\?\.take \? \{ take: options\.take \}/.test(scopedSource),
      ],
      [
        "the counts are grouped counts in pendingApprovalCounts, one read each, and no list is loaded to count",
        /countPendingByType\(\)/.test(pendingBody) &&
          /reservations\.countPending\(\)/.test(pendingBody) &&
          /sessionBookings\.countPending\(/.test(pendingBody) &&
          !/\.list\(|\.listPending\(|findMany\(/.test(pendingBody) &&
          /prisma\.changeRequest\.groupBy\(/.test(scopedSource) &&
          /getPendingApprovalCounts\(ctx\)/.test(page),
      ],
      [
        "the booking count's lean read keeps its explicit take cap",
        bookingCountStart > 0 && /prisma\.sessionBooking\.findMany\(/.test(bookingCountBody) && /take: 500/.test(bookingCountBody),
      ],
    ];
  });

  // SEC-26 fixtures: 32 classes (31 need confirmation, 1 is instant).
  const subject = await prisma.catalogSubject.create({ data: { nameAr: `${PREFIX}subject`, nameEn: `${PREFIX}subject` } });
  try {
    const classIds = Array.from({ length: 32 }, () => randomUUID());
    await prisma.classGroup.createMany({
      data: classIds.map((id, index) => ({
        id,
        centerId: center.id,
        teacherId: teacher.id,
        subjectId: subject.id,
        startDate: addDays(today, -30),
        endDate: addDays(today, 300),
        price: 10_000,
        requiresConfirmation: index < 31,
      })),
    });
    const student = await makeUser("c-student");
    createdUserIds.add(student.id);
    const reserve = (db: PrismaClient, classGroupId: string) =>
      db.$transaction((tx) => reserveOrEnroll(tx, { centerId: center.id, classGroupId, studentUserId: student.id }), WRITE_TRANSACTION_OPTIONS);

    await assertSec("SEC-26", "per-account caps on open reservations and self-enrolments (D-18), race-safe", async () => {
      // 28 open requests; a 29th alone; then two at once — exactly one fits under 30.
      await prisma.reservation.createMany({
        data: classIds.slice(0, 28).map((classGroupId) => ({ centerId: center.id, classGroupId, studentId: student.id, status: "PENDING" as const })),
      });
      const deskA = await gatePrisma({ sweepUsers: false });
      const deskB = await gatePrisma({ sweepUsers: false });
      let raced: Awaited<ReturnType<typeof reserveOrEnroll>>[];
      try {
        raced = [await reserve(prisma, classIds[28])];
        raced.push(...(await Promise.all([reserve(deskA, classIds[29]), reserve(deskB, classIds[30])])));
      } finally {
        await Promise.all([deskA.$disconnect(), deskB.$disconnect()]);
      }
      const open = await prisma.reservation.count({ where: { studentId: student.id, status: "PENDING" } });
      const okCount = raced.filter((result) => result.ok).length;
      const refused = raced.filter((result) => !result.ok && result.error === "reservationLimit").length;

      // 30 active enrolments, then an instant-enrol class: refused.
      const profile = await makeStudent(center.id, student);
      await prisma.enrollment.createMany({
        data: classIds.slice(0, 30).map((classGroupId) => ({ centerId: center.id, classGroupId, studentProfileId: profile.id, status: "ACTIVE" as const })),
      });
      const instant = await reserve(prisma, classIds[31]);
      const seats = await prisma.enrollment.count({ where: { classGroupId: classIds[31] } });
      const action = exportedBody("app/[locale]/(student)/student/discover/actions.ts", "reserveClassAction");
      return [
        [`the 29th alone, then two in parallel at 29 open: two ok, one reservationLimit (got ok=${okCount} refused=${refused})`, okCount === 2 && refused === 1],
        [`never more than ${SELF_SERVICE_CAPS.openReservations} open (got ${open})`, open === SELF_SERVICE_CAPS.openReservations],
        ["the 31st active self-enrolment is refused (enrollmentLimit), no seat taken", !instant.ok && instant.error === "enrollmentLimit" && seats === 0],
        ["the action is limited per account and per IP", /selfServicePerUser/.test(action) && /selfServicePerIp/.test(action)],
      ];
    });
  } finally {
    await prisma.classGroup.deleteMany({ where: { centerId: center.id } }).catch(() => undefined);
    await prisma.catalogSubject.deleteMany({ where: { id: subject.id } }).catch(() => undefined);
  }

  await assertSec("SEC-32", "Discover loads at most five centres at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const order = await mapWithConcurrency(Array.from({ length: 50 }, (_, index) => index), 5, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolveTick) => setTimeout(resolveTick, 2));
      inFlight -= 1;
      return index;
    });
    const page = read("app/[locale]/(student)/student/discover/page.tsx");
    return [
      [`50 centres, limit 5: peak ${peak} in flight`, peak <= 5 && peak > 1],
      ["results stay in input order", order.every((value, index) => value === index)],
      ["the Discover page fans out through it, never Promise.all over every centre", /mapWithConcurrency\(\s*centers,\s*DISCOVER_CENTER_CONCURRENCY/.test(page) && !/Promise\.all\(\s*centers\.map/.test(page)],
    ];
  });

  await assertSec("SEC-49", "profile completion takes only a grade the centre offers", async () => {
    const unselected = await prisma.catalogGrade.create({ data: { nameAr: `${PREFIX}grade`, nameEn: `${PREFIX}grade` } });
    try {
      const action = exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction");
      // G2 (OD-14): F2 moved the layout's body, and the grade picker, into student-shell.tsx.
      const layout = read("app/[locale]/(student)/student-shell.tsx");
      return [
        ["an unselected catalog grade does not resolve at this centre", (await centerGradeById(prisma, center.id, unselected.id)) === null],
        ["the action resolves through centerGradeById, never a raw catalog row", /centerGradeById\(prisma, centerId, gradeId\)/.test(action) && !/catalogGrade\.find/.test(action)],
        ["the form offers this centre's grades only", /centerGrades\(prisma, incomplete\.center\.id\)/.test(layout) && !/listCatalogGrades/.test(layout)],
      ];
    } finally {
      await prisma.catalogGrade.delete({ where: { id: unselected.id } });
    }
  });

  await assertSec("SEC-52", "raw-argument actions parse their arguments before any query", () => {
    const rawActions: [string, string][] = [
      ["app/[locale]/(center)/classes/actions.ts", "searchEnrollCandidatesAction"],
      ["app/[locale]/(center)/reception/actions.ts", "searchStudentsForReceptionAction"],
      ["app/[locale]/(center)/reception/actions.ts", "resolveReceptionInputAction"],
      ["app/[locale]/(center)/reception/actions.ts", "resolveReceptionStudentAction"],
      ["app/[locale]/(center)/sessions/actions.ts", "searchAddAttendeeCandidatesAction"],
      ["app/[locale]/(center)/students/actions.ts", "searchStudentsTypeAheadAction"],
      ["app/[locale]/(center)/students/actions.ts", "lookupPersonByPhoneAction"],
      ["app/[locale]/(center)/teachers/actions.ts", "searchTeachersTypeAheadAction"],
      ["app/[locale]/(center)/teachers/actions.ts", "searchBlockCandidatesAction"],
      ["app/[locale]/(center)/teachers/actions.ts", "lookupPersonByPhoneAction"],
      ["app/[locale]/(teacher)/teacher/sessions/actions.ts", "searchOwnSessionStudentsTypeAheadAction"],
      ["app/[locale]/(teacher)/teacher/students/actions.ts", "searchTaughtStudentsTypeAheadAction"],
    ];
    const unparsed = rawActions.filter(([file, name]) => {
      const body = exportedBody(file, name);
      const parseAt = body.indexOf("parseActionArgs(");
      const firstQuery = body.search(/\.search\(|findFirst\(|findDetailById\(|findById\(|listForClass\(|resolveContact\(|sessionModeScope\(/);
      return parseAt < 0 || (firstQuery >= 0 && firstQuery < parseAt);
    });
    const typeAheadBodies = ["app/[locale]/(teacher)/teacher/sessions/actions.ts", "app/[locale]/(teacher)/teacher/students/actions.ts"].map(
      (file) => exportedFunctions(file).find((fn) => /TypeAheadAction$/.test(fn.name))?.body ?? "",
    );
    return [
      ["an object as the query is refused", parseActionArgs(searchArgs, [{ not: "" }]) === null],
      ["an object as a bound id is refused", parseActionArgs(boundSearchArgs, [{ not: "" }, "ab"]) === null],
      [`a ${SEARCH_QUERY_MAX + 1}-character query is refused, never truncated into the database`, parseActionArgs(searchArgs, ["x".repeat(SEARCH_QUERY_MAX + 1)]) === null && parseActionArgs(searchArgs, ["x".repeat(10_000)]) === null],
      ["an ordinary query parses (trimmed)", JSON.stringify(parseActionArgs(searchArgs, ["  mona  "])) === JSON.stringify(["mona"])],
      [`all ${rawActions.length} raw-argument actions parse first${unparsed.length ? ` (not: ${unparsed.map(([, name]) => name).join(", ")})` : ""}`, unparsed.length === 0],
      ["the teacher type-aheads filter relationally, with no roster preload per keystroke", typeAheadBodies.every((body) => /taughtByTeacherWhere\(/.test(body) && !/teacherStudentProfileIds\(/.test(body))],
    ];
  });

  await assertSec("SEC-61", "LIKE pattern characters never act as wildcards in search or duplicate checks", async () => {
    await makeStudent(center.id, teacher, { email: null });
    const searchHits = async (query: string) =>
      prisma.studentProfile.count({ where: { centerId: center.id, ...studentSearchWhere(query) } });
    const everyone = await prisma.studentProfile.count({ where: { centerId: center.id } });
    const cash1 = await createPaymentMethod(prisma, center.id, "Cash1");
    const cashUnderscore = await createPaymentMethod(prisma, center.id, "Cash_");
    const cashAgain = await createPaymentMethod(prisma, center.id, "  CASH_ ");
    const sources = ["lib/db/students.ts", "lib/db/teacher-portal.ts", "lib/db/payment-methods.ts", "lib/db/terms.ts", "app/[locale]/(center)/expenses/actions.ts", "app/[locale]/(center)/settings/actions.ts"];
    const insensitiveEquals = sources.filter((file) => /equals: \w+, mode: "insensitive"/.test(read(file)));
    return [
      [`a search for "%" or "_" matches nobody (it used to match all ${everyone})`, everyone > 0 && (await searchHits("%")) === 0 && (await searchHits("_")) === 0 && (await searchHits("% _")) === 0 && studentSearchWhere("") === undefined],
      ["the search tokens drop the pattern characters", likeSearchToken("50%_off\\") === "50off"],
      ["`Cash_` can be created when only `Cash1` exists", cash1.ok && cashUnderscore.ok],
      ["a real duplicate is still refused — case and spaces ignored", !cashAgain.ok && cashAgain.error === "duplicateName"],
      [`no duplicate check uses an insensitive equals (an ILIKE)${insensitiveEquals.length ? ` (still: ${insensitiveEquals.join(", ")})` : ""}`, insensitiveEquals.length === 0],
    ];
  });

  await assertSec("SEC-71", "the card background is normalised like the accent", () => [
    ["a stored non-colour string falls back to the default", resolveCardLayout({ background: "url(javascript:alert(1))" }).background === DEFAULT_CARD_BACKGROUND],
    ["a hex colour is kept (normalised)", resolveCardLayout({ background: "#ABCDEF" }).background === "#abcdef"],
    ["the built-in surface is kept", resolveCardLayout({ background: DEFAULT_CARD_BACKGROUND }).background === DEFAULT_CARD_BACKGROUND],
  ]);

  await assertSec("SEC-75", "production Prisma errors carry no call-site arguments (logging half)", () => [
    ["errorFormat is minimal in production", /NODE_ENV === "production" \? \{ errorFormat: "minimal"/.test(read("lib/db/client.ts"))],
  ]);

  await assertSec("SEC-2c gates", "every DB gate runs on the gate client; fixtures do not rot", () => {
    const gateFiles = walk("scripts").filter((file) => /^scripts\/[a-z-]+-check\.ts$/.test(file));
    const bare = gateFiles.filter((file) => /^const prisma = new PrismaClient\(/m.test(read(file)));
    const people = read("scripts/people-check.ts");
    const approvals = read("scripts/approvals-check.ts");
    const ci = read(".github/workflows/ci.yml");
    const gateDb = read("scripts/lib/gate-db.ts");
    return [
      [`no gate builds a bare client${bare.length ? ` (${bare.join(", ")})` : ""}`, gateFiles.length > 20 && bare.length === 0],
      ["check:people matches through the real resolveContact and describeMatch (no private copy)", /from "\.\.\/lib\/db\/identity\.ts"/.test(people) && /resolveContact\(/.test(people) && /describeMatch\(/.test(people) && !/async function findMatch\(/.test(people)],
      ["check:approvals computes its request date from today", /todayInTimezone\(/.test(approvals) && !/sessionRequestDate = "\d{4}-/.test(approvals)],
      ["CI records and verifies the User row count around the gates", /gates:users -- record/.test(ci) && /gates:users -- verify/.test(ci)],
      ["the gate client sets lock_timeout and statement_timeout on every transaction", gateDb.includes("set_config('lock_timeout'") && gateDb.includes("set_config('statement_timeout'")],
    ];
  });
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
    if (failures > 0) {
      console.error(`\n${failures} security assertion(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll security assertions passed.");
  });
