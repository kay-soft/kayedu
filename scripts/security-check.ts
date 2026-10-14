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
 * Findings still open (SEC-2a leaves them, with reasons, in docs/07) and the
 * money/concurrency/fraud findings (SEC-2b) have no assertion here yet.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

import { AuthMisconfiguredError, productionAuthProblems } from "../lib/auth/auth-config.ts";
import { profileFromMetadata, resolveAppIdentity } from "../lib/auth/identity-link.ts";
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
  originateParentLinks,
  revokeStaleParentLinks,
  verifiedChildLinks,
  verifyParentLinkPlaceholder,
} from "../lib/db/parents.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { reserveOrEnroll } from "../lib/db/reservations.ts";
import { lockAttendeeRow } from "../lib/db/session-lifecycle.ts";
import { addTeacherMembership } from "../lib/db/teacher-membership.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import { checkRateLimit, checkRateLimits, pruneRateLimitBuckets } from "../lib/rate-limit.ts";
import { safeNextPath } from "../lib/routes.ts";
import { MAX_PHOTO_BYTES, centerLogoSrc, sniffImageType } from "../lib/storage-paths.ts";
import { createCenterSchema } from "../lib/validation/admin.ts";
import { seedPasswordProblems } from "../prisma/seed-data/auth.ts";
import { productionTargetReason } from "../prisma/seed-data/production-refs.ts";
import { auditRls, rlsProblems } from "./lib/rls-audit.ts";

const prisma = new PrismaClient();
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
    await prisma.auditLog.deleteMany({ where: { centerId: { in: centerIds } } });
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
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (rateLimitKeys.size > 0) {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: [...rateLimitKeys] } } });
  }
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
    const phone = `015${String(randomInt(0, 99_999_999)).padStart(8, "0")}`;
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

  await assertSec("SEC-03", "a phone match never becomes parent access by one staff click (D-03 (d))", async () => {
    const parentPhone = await freePhone();
    const child = await makeUser("child3");
    const profile = await makeStudent(orgCenter.id, child, { parentPhone });
    const stranger = await makeUser("stranger3");
    const origin = await originateParentLinks(prisma, { parentUserId: stranger.id, phone: parentPhone });
    const link = await prisma.parentLink.findFirst({ where: { parentUserId: stranger.id, studentProfileId: profile.id } });
    const verify = await verifyParentLinkPlaceholder(prisma, {
      parentLinkId: link?.id ?? "",
      centerId: orgCenter.id,
      verifiedByUserId: manager.id,
    });
    const after = await prisma.parentLink.findUnique({ where: { id: link?.id ?? "" } });
    return [
      ["origination still writes only a PENDING link", origin.ok && !origin.refused && origin.createdLinkIds.length === 1],
      ["the staff Verify stand-in refuses", !verify.ok && verify.error === "verificationUnavailable"],
      ["the link stays PENDING", after?.status === "PENDING"],
      ["the stranger reads no child", (await verifiedChildLinks(prisma, stranger.id)).length === 0],
      ["the Verify button is disabled in the UI", /SubmitButton variant="outline" disabled/.test(read("app/[locale]/(center)/students/[id]/verify-parent-link-button.tsx"))],
    ];
  });

  await assertSec("SEC-04", "a verified parent link stops on deactivation and is revoked when the phone changes", async () => {
    const oldPhone = await freePhone();
    const newPhone = await freePhone();
    const child = await makeUser("child4");
    const profile = await makeStudent(orgCenter.id, child, { parentPhone: oldPhone });
    const parent = await makeUser("parent4");
    const link = await prisma.parentLink.create({
      data: {
        parentUserId: parent.id,
        studentProfileId: profile.id,
        centerId: orgCenter.id,
        matchedPhone: oldPhone,
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
    const before = (await verifiedChildLinks(prisma, parent.id)).length;
    await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: false } });
    const whileInactive = (await verifiedChildLinks(prisma, parent.id)).length;
    await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: true, parentPhone: newPhone } });
    const beforeRevoke = (await verifiedChildLinks(prisma, parent.id)).length;
    const revoked = await revokeStaleParentLinks(prisma, {
      centerId: orgCenter.id,
      studentProfileId: profile.id,
      actorUserId: manager.id,
    });
    const row = await prisma.parentLink.findUniqueOrThrow({ where: { id: link.id } });
    const audits = await prisma.auditLog.count({ where: { action: "parentLink.revoke", entityId: link.id } });
    return [
      ["the verified link reads before anything changes", before === 1],
      ["a deactivated child disappears (D-10)", whileInactive === 0],
      ["a changed parent phone reads as nothing even before revocation", beforeRevoke === 0],
      ["the stale link is revoked", revoked === 1 && row.status === "REVOKED" && row.revokedAt !== null],
      ["the revocation is audited (parentLink.revoke)", audits === 1],
      ["staff editing the parent phone triggers the revocation", /revokeStaleParentLinks\(/.test(exportedBody("app/[locale]/(center)/students/actions.ts", "updateStudentAction"))],
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
    const phone = await freePhone();
    const child = await makeUser("child16");
    const childProfile = await makeStudent(suspended.id, child, { parentPhone: phone });
    const parent = await makeUser("parent16");
    await prisma.parentLink.create({
      data: { parentUserId: parent.id, studentProfileId: childProfile.id, centerId: suspended.id, matchedPhone: phone, status: "VERIFIED", verifiedAt: new Date() },
    });
    const profileAction = exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction");
    return [
      ["reserving at a SUSPENDED centre → notFound", !atSuspended.ok && atSuspended.error === "notFound"],
      ["a deactivated student cannot self-enrol", !whileInactive.ok && whileInactive.error === "studentBlocked"],
      ["a parent reads nothing at a SUSPENDED centre", (await verifiedChildLinks(prisma, parent.id)).length === 0],
      ["profile completion requires an active profile at an accessible centre", /active: true/.test(profileAction) && /ACCESSIBLE_LIFECYCLE_STATES/.test(profileAction)],
    ];
  });

  await assertSec("SEC-17", "student profile completion is strictly one-time (D-11)", () => {
    const body = exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction");
    return [
      ["a completed profile is refused (alreadyCompleted) before any write", /if \(profile\.profileCompletedAt\) return \{ error: "alreadyCompleted" \}/.test(body) && body.indexOf("alreadyCompleted") < body.indexOf("studentProfile.update")],
      ["a parent-phone change there still revokes stale links", /revokeStaleParentLinks\(/.test(body)],
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
    await awayFromWindowEdge(60_000);
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

  // ── Secrets & config ────────────────────────────────────────────────────

  await assertSec("SEC-38", "the seeded platform admin has its own password (D-21)", () => {
    const same = "x".repeat(16);
    return [
      ["the preflight/seed refuse SEED_ADMIN_PASSWORD == SEED_PASSWORD", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: same }).length > 0],
      ["they refuse a short admin password", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: "short" }).length > 0],
      ["two distinct ≥12-character passwords pass", seedPasswordProblems({ SEED_PASSWORD: same, SEED_ADMIN_PASSWORD: "y".repeat(16) }).length === 0],
      ["the platform admin is created with the admin password", /admin: isPlatformAdmin/.test(read("prisma/seed.ts")) && /account\.admin \? this\.adminPassword : this\.password/.test(read("prisma/seed-data/auth.ts"))],
      [".env.example documents SEED_ADMIN_PASSWORD", /SEED_ADMIN_PASSWORD=/.test(read(".env.example"))],
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

  // Not a finding of its own: the production guard must never fire off-production.
  await enforceProductionAuthSettings({ REQUIRE_EMAIL_CONFIRMATION: "false" });
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
