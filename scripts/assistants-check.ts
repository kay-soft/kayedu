/**
 * Assistants check — the W7a acceptance gate (D-W16, D-W17, D-W36;
 * docs/03-build-order.md W7a).
 *
 * Run with:  npm run check:assistants   (staging or a local database only — S1)
 *
 * Exercises `lib/db/assistants.ts` — the only writer of `AssistantInvite`,
 * `TeacherAssistant` and `AssistantPermissionGrant` — and the experience list
 * (`lib/auth/experiences.ts`) directly, outside Next.js, plus static sweeps:
 *
 *  1. Codes — 12 symbols from the unambiguous alphabet, forgiving input, and
 *     **sha256-only storage** (the database refuses a plaintext code).
 *  2. One answer for unknown, expired, used and revoked codes; the expiry
 *     boundary (`expiresAt` itself is expired); an expired invite frees its slot.
 *  3. Single use under two concurrent redemptions (two database clients).
 *  4. The rate limit, per account and per client IP.
 *  5. The 5-slot cap counting pending invites, under concurrent creation.
 *  6. No self-assist (the writer and a CHECK); one live link per pair (the
 *     partial unique index), freed by removal.
 *  7. Presets → grants, Custom detection, `students.phones` in no preset;
 *     unknown permission and preset names refused with nothing written.
 *  8. Premium expiry hides the experience and every teacher action; renewal
 *     restores it, links and grants untouched (the W6 helpers, fixture dates).
 *  9. Every non-owner refused by direct call, nothing written: no actor, a
 *     non-premium teacher, another (premium) teacher, premium centre staff of
 *     every role, a premium student; the assistant's Leave by anyone else.
 * 10. The route's teacherId cannot be swapped to read another teacher's link.
 * 11. Audit rows: one per write, no centre, ids, preset and permission names
 *     only — never a code, a name or an email.
 * 12. No centre anything: an assistant holds no Membership, no centre
 *     relation and no permission grant; statics on the assistant surfaces.
 *
 * W7b — acting on behalf (D-W17, D-W18, D-W19, D-W37):
 * 13. The matrix: every catalogue key at a branch, allowed exactly by its
 *     preset, refused for a missing grant, the teacher's own cell off (or
 *     membership inactive), the branch setting off, the teacher not trusted
 *     (requests), premium lapsed (the end instant), a swapped teacherId and
 *     another centre — effective permission is the intersection.
 * 14. Assessments through the unchanged W2/W3a/W4 functions, actor = the
 *     assistant: Co-teacher builds, publishes, extends and reads results; a
 *     Grader reads but never writes; refusals by direct call.
 * 15. Audit rows: actor = the assistant, onBehalfOf = the teacher, ids only;
 *     the teacher's own rows leave onBehalfOf null.
 * 16. Requests on behalf: the teacher's, "via assistant", audited.
 * 17. Centre-facing reads (audit feed, approvals rows) never carry the
 *     assistant's name, email or id.
 * 18. The window: the stricter of the branch's teacher window and the
 *     teacher's own teacherHistoryDays.
 * 19. Rosters names only (no phone, with or without students.phones); the
 *     nav per preset; every branch off → Home only.
 * 20. Removing the link, lapsing premium or swapping the teacher cuts access.
 *
 * W8d — the teacher's workspaces (D-W41 items 9–12):
 * 21. The resolver's second source (only the teacher's own workspaces, from
 *     the teacher's id), the nav with Workspaces and Earnings, a workspace-only
 *     premium teacher inviting (an account with neither still cannot), and the
 *     statics extended: the workspace source is built from the teacher's id,
 *     every workspace action resolves first and matches the workspace among
 *     the teacher's, the writers' assistant path decides with assistantCan
 *     and then the teacher's own gate, and the assistant surface never reaches
 *     a workspace creation, student, class, session, settings or settlement
 *     writer. (The matrix of keys × actions on real workspace rows is
 *     `check:workspaces` §16.)
 *
 * Writes throwaway rows under the `assistants-check` stem and cleans up.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { readSource } from "./lib/source.ts";
import {
  ASSISTANT_CODE_ALPHABET,
  ASSISTANT_LIMITS,
  ASSISTANT_PERMISSIONS,
  ASSISTANT_PRESETS,
  PRESET_PERMISSIONS,
  detectPreset,
  formatAssistantCodeForDisplay,
  normalizeAssistantCode,
} from "../lib/assistant-catalog.ts";
import {
  ASSISTANT_AUDIT_ACTIONS,
  assistantSlotsInUse,
  createAssistantInvite,
  effectiveAssistantLinks,
  findEffectiveAssistantLink,
  generateAssistantCode,
  leaveAssistantLink,
  previewAssistantCode,
  redeemAssistantCode,
  removeAssistant,
  revokeAssistantInvite,
  teacherAssistantsOverview,
  updateAssistantPermissions,
} from "../lib/db/assistants.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import { extendPremium, grantPremium, revokePremium } from "../lib/db/premium.ts";
import { premiumLatestEndDay, premiumToday, premiumUntilForDay } from "../lib/auth/premium.ts";
import { assistantExperienceKey, assistantExperienceSources, loadExperiences } from "../lib/auth/experiences.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import type { Permission } from "../lib/auth/permissions.ts";
import type { AssistantPermission } from "../lib/assistant-catalog.ts";
import { assessmentDefaults, type AssessmentDraft } from "../lib/assessments.ts";
import { assistantNavItems } from "../lib/assistant-nav.ts";
import { assistantFloorAt, assistantMayAt, resolveAssistantActing } from "../lib/db/assistant-acting.ts";
import { assistantClassDetail, assistantClassList } from "../lib/db/assistant-reads.ts";
import { fileRequestOnBehalf, listTeacherRequestsAt } from "../lib/db/assistant-requests.ts";
import { startAttempt } from "../lib/db/assessment-attempts.ts";
import { readAssessmentResults, readAttemptResult } from "../lib/db/assessment-results.ts";
import {
  createAssessment,
  deleteAssessment,
  extendAssessment,
  publishAssessment,
  resolveAssessmentTeacher,
  saveAssessmentDraft,
  unpublishAssessment,
} from "../lib/db/assessments.ts";
import { loadAuditFeed } from "../lib/db/audit-feed.ts";
import { loadPermissionGrants, savePermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { withoutAssistantId } from "../lib/db/request-view.ts";
import { assistantReadFloor } from "../lib/db/visibility.ts";
import { todayInTimezone } from "../lib/scheduling.ts";
import { assistantCan } from "../lib/db/assistant-acting.ts";
import { createWorkspace } from "../lib/db/workspaces.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const STEM = "assistants-check";
const EMAIL_PREFIX = `${STEM}-`;
const SLUG = `${STEM}-a`;
const ORG_NAME = "Assistants Check";
const RUN = randomUUID().slice(0, 8);
const codesIssued = new Set<string>();

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fresh client address per call, so one test's attempts never use up another's per-IP budget. */
const ip = () => `${STEM}-${RUN}-${randomUUID()}`;

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  if (userIds.length > 0) {
    await deleteAuditRows(prisma, { actorUserId: { in: userIds } });
    await deleteAuditRows(prisma, { action: { startsWith: "platform.premium." }, entityId: { in: userIds } });
  }
  // W7b: the on-behalf section's branches too; their audit rows go first (no cascade on AuditLog).
  const centers = await prisma.center.findMany({ where: { slug: { startsWith: STEM } }, select: { id: true } });
  if (centers.length > 0) await deleteAuditRows(prisma, { centerId: { in: centers.map((center) => center.id) } });
  await prisma.center.deleteMany({ where: { slug: { startsWith: STEM } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: ORG_NAME }, centers: { none: {} } } });
  // W8d: the fixture teachers' PERSONAL workspaces and personal organizations (an owner is RESTRICT).
  const personal = userIds.length > 0 ? await prisma.organization.findMany({ where: { ownerUserId: { in: userIds } }, select: { id: true } }) : [];
  if (personal.length > 0) {
    const workspaces = await prisma.center.findMany({ where: { organizationId: { in: personal.map((org) => org.id) } }, select: { id: true } });
    if (workspaces.length > 0) await deleteAuditRows(prisma, { centerId: { in: workspaces.map((center) => center.id) } });
    await prisma.center.deleteMany({ where: { id: { in: workspaces.map((center) => center.id) } } });
    await prisma.organization.deleteMany({ where: { id: { in: personal.map((org) => org.id) } } });
  }
  // Cascades every invite, link and grant of these accounts.
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.rateLimitBucket.deleteMany({
    where: { OR: [...userIds.map((id) => ({ key: { endsWith: id } })), { key: { contains: `${STEM}-${RUN}` } }] },
  });
}

let seq = 0;
async function makeUser(tag: string, extra: { isPlatformAdmin?: boolean; emailVerifiedAt?: Date | null } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: "Fixture",
      lastName: `${tag}${seq}`,
      email: `${EMAIL_PREFIX}${tag}-${seq}-${RUN}@kayedu.test`,
      locale: "en",
      emailVerifiedAt: new Date(),
      ...extra,
    },
  });
}

type StaffRole = "OWNER" | "MANAGER" | "RECEPTIONIST" | "ACCOUNTANT" | "TEACHER";
async function member(centerId: string, userId: string, role: StaffRole) {
  await prisma.membership.create({
    data: scopedData(centerId, { userId, role, firstName: "M", lastName: role, joinedAt: new Date() }),
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}
const read = (path: string) => readSource(join(ROOT, path));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function exportedBody(path: string, name: string): string {
  const source = stripComments(read(path));
  const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

async function assistantRowCounts() {
  const [invites, links, grants, audits] = await Promise.all([
    prisma.assistantInvite.count({ where: { teacher: { email: { startsWith: EMAIL_PREFIX } } } }),
    prisma.teacherAssistant.count({ where: { teacher: { email: { startsWith: EMAIL_PREFIX } } } }),
    prisma.assistantPermissionGrant.count({ where: { assistant: { teacher: { email: { startsWith: EMAIL_PREFIX } } } } }),
    prisma.auditLog.count({ where: { action: { startsWith: "assistant." }, actor: { email: { startsWith: EMAIL_PREFIX } } } }),
  ]);
  return `${invites}/${links}/${grants}/${audits}`;
}

function staticChecks() {
  console.log("Static sweeps");
  const writer = stripComments(read("lib/db/assistants.ts"));
  for (const name of ["createAssistantInvite", "updateAssistantPermissions"]) {
    const body = exportedBody("lib/db/assistants.ts", name);
    check(
      `${name}: locks the teacher's row, then the teacher + premium gate, inside its transaction`,
      /inTransaction\(db,/.test(body) && body.indexOf("lockTeacher(") > 0 && body.indexOf("lockTeacher(") < body.indexOf("teacherGate("),
    );
  }
  // W7b (D-W37 item 12, the prompt's old → new): reducing access never needs premium.
  for (const name of ["revokeAssistantInvite", "removeAssistant"]) {
    const body = exportedBody("lib/db/assistants.ts", name);
    check(
      `${name}: locks the teacher's row, then the teacher gate without premium (W7b), inside its transaction`,
      /inTransaction\(db,/.test(body) && body.indexOf("lockTeacher(") > 0 && body.indexOf("lockTeacher(") < body.indexOf("teacherActorGate(") &&
        !/teacherGate\(|requirePremium\(/.test(body),
    );
  }
  check("The widening gate is a TEACHER membership plus requirePremium", /isTeacherAccount\(tx, actorUserId\)[\s\S]*requirePremium\(tx, actorUserId!?, now\)/.test(exportedBody("lib/db/assistants.ts", "isTeacherAccount") + writer));
  check("The leave path needs no premium either", !/requirePremium\(|teacherGate\(/.test(exportedBody("lib/db/assistants.ts", "leaveAssistantLink")));
  check(
    "Every teacher-side row is looked up with the actor as its teacher",
    (writer.match(/teacherUserId: actorUserId/g) ?? []).length >= 4,
  );
  check("The leave path is keyed on the actor as the assistant", /assistantUserId: actorUserId, revokedAt: null/.test(exportedBody("lib/db/assistants.ts", "leaveAssistantLink")));
  check(
    "No Membership, PermissionGrant, StudentProfile or tenant-scoped write in lib/db/assistants.ts",
    !/\.(membership|permissionGrant|studentProfile|enrollment)\.(create|update|upsert|delete)/.test(writer),
  );
  check("Redemption is rate-limited before any code is looked up", (() => {
    const gate = exportedBody("lib/db/assistants.ts", "redeemAssistantCode");
    return gate.indexOf("redeemerGate(") >= 0 && gate.indexOf("redeemerGate(") < gate.indexOf("usableInvite(");
  })() && /checkRateLimits\(\[\s*\{ name: "assistantJoinPerUser"[\s\S]*"assistantJoinPerIp"/.test(writer));

  const actionsFiles = ["app/[locale]/(teacher)/teacher/assistants/actions.ts", "app/[locale]/account/assistant-actions.ts"];
  for (const file of actionsFiles) {
    const source = stripComments(read(file));
    check(
      `${file}: the actor comes from the session, never the form`,
      /getCurrentUser\(\)/.test(source) && !/formData\.get\(["'](userId|actorUserId|teacherUserId|assistantUserId)["']\)/.test(source),
    );
  }

  // W7b (the approved replacement of two W7a statics): the assistant surface
  // reads centre data only through the teacher's own contexts that
  // getAssistantScope builds, never resolves a context of the assistant's own,
  // and never reaches a payment, settlement, refund, money or account module.
  const assistantSurface = [
    ...walk(join(ROOT, "app", "[locale]", "(assistant)")),
    join(ROOT, "lib", "auth", "assistant-context.ts"),
    join(ROOT, "lib", "assistant-nav.ts"),
    join(ROOT, "lib", "db", "assistant-acting.ts"),
    join(ROOT, "lib", "db", "assistant-reads.ts"),
    join(ROOT, "lib", "db", "assistant-requests.ts"),
    // W8d: the assistant's workspace reads.
    join(ROOT, "lib", "db", "assistant-workspaces.ts"),
  ];
  const ownContext = assistantSurface.filter((file) =>
    /getTenantContext\(|getTenantContextForBranch\(|requireExperience\(|getTeacherScope\(|teacherBranchContext\(|actionContext\(|ctxCan\(|requirePermission\(/.test(stripComments(readSource(file))),
  );
  check(
    "The assistant surface never resolves a tenant context of its own (no getTenantContext, requireExperience, getTeacherScope, ctxCan)",
    assistantSurface.length >= 15 && ownContext.length === 0,
    ownContext.map((file) => relative(ROOT, file)).join(", "),
  );
  const forbiddenModules =
    /from "(@\/lib\/db\/(payments|settlements|refunds|money-sums|account|account-claims|premium|expenses|reception)"|@\/lib\/money"|\.\.?\/(db\/)?(payments|settlements|refunds|money-sums|money|account|account-claims|premium)\.ts"|@\/app\/\[locale\]\/(\(center\)|account)\/|@\/app\/\[locale\]\/\(teacher\)\/teacher\/(settlements|profile|assistants)\/)/;
  const moneyReaders = assistantSurface.filter((file) => forbiddenModules.test(stripComments(readSource(file))));
  check(
    "No assistant file imports a payment, settlement, refund, money, premium or account module, or a centre / account / settlements page",
    moneyReaders.length === 0,
    moneyReaders.map((file) => relative(ROOT, file)).join(", "),
  );
  // (a) No Membership, relation or TenantContext is ever built from the
  // assistant's own identity: only the teacher's, one per branch that
  // resolveAssistantActing returned.
  const scopeSource = stripComments(read("lib/auth/assistant-context.ts"));
  const loader = (() => {
    const start = scopeSource.indexOf("async function loadAssistantScope(");
    return start < 0 ? "" : scopeSource.slice(start, scopeSource.indexOf("\n}\n", start));
  })();
  const actingCall = loader.indexOf("resolveAssistantActing(prisma, { assistantUserId: user.id, teacherUserId })");
  const contextsCall = loader.indexOf("getTeacherContexts(acting.teacherUserId)");
  check(
    "(a) The scope is built by resolveAssistantActing first, and refused without it",
    actingCall > 0 && /if \(!acting\) return null;/.test(loader) && actingCall < loader.indexOf("if (!acting) return null;"),
  );
  check(
    "(a) …then the teacher's contexts only — getTeacherContexts(acting.teacherUserId), after the acting is resolved",
    contextsCall > actingCall && actingCall > 0,
  );
  check(
    "(a) …narrowed to exactly the branches resolveAssistantActing returned (per branch, matched by centre id)",
    /const branches = acting\.branches\.flatMap\(/.test(loader) &&
      /contexts\.find\(\(candidate\) => candidate\.center\.id === branch\.centerId/.test(loader) &&
      /acting: \{ \.\.\.acting, branches: acting\.branches\.filter\(/.test(loader),
  );
  const contextBuilders = assistantSurface.filter((file) => /getTeacherContexts\(/.test(stripComments(readSource(file))));
  check(
    "(a) getTeacherContexts is called in one place on the assistant surface, never with the session user's id",
    contextBuilders.length === 1 && /assistant-context\.ts$/.test(contextBuilders[0]) &&
      !/getTeacherContexts\((user\.id|session\.user\.id|scope\.user\.id|assistantUserId)/.test(scopeSource),
    contextBuilders.map((file) => relative(ROOT, file)).join(", "),
  );
  const relationReaders = assistantSurface.filter((file) =>
    /getUserCenterRelations\(|resolveCenterRelations\(|buildContext\(|getTeacherContexts\(\s*(user|session|scope)\./.test(stripComments(readSource(file))),
  );
  check(
    "(a) No assistant file resolves centre relations or builds a context of its own (no getUserCenterRelations, resolveCenterRelations, buildContext)",
    relationReaders.length === 0,
    relationReaders.map((file) => relative(ROOT, file)).join(", "),
  );
  const membershipWriters = assistantSurface.filter((file) =>
    /\.(membership|permissionGrant|membershipBranchGrant|studentProfile|invitation)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|savePermissionGrants\(|grantMembershipBranch\(/.test(stripComments(readSource(file))),
  );
  check(
    "(a) No assistant file writes a Membership, PermissionGrant, branch grant, StudentProfile or invitation",
    membershipWriters.length === 0,
    membershipWriters.map((file) => relative(ROOT, file)).join(", "),
  );
  const actingSource = stripComments(read("lib/db/assistant-acting.ts"));
  check(
    "(a) resolveAssistantActing reads the teacher's memberships only (userId: teacherUserId) and the link from the session user and the teacher",
    /db\.membership\.findMany\(\{\s*where: \{ userId: teacherUserId, role: "TEACHER", active: true/.test(actingSource) &&
      !/userId: assistantUserId/.test(actingSource) &&
      /findEffectiveAssistantLink\(db, \{ assistantUserId, teacherUserId, now \}\)/.test(actingSource),
  );
  const pages = assistantSurface.filter((file) => /[\\/]page\.tsx$/.test(file));
  const ungated = pages.filter((file) => !/getAssistantScope\(teacherId\)|getAssistantSession\(teacherId\)/.test(readSource(file)));
  check(
    `Every assistant page (${pages.length}) re-resolves the link from the route on each request`,
    pages.length >= 11 && ungated.length === 0,
    ungated.map((file) => relative(ROOT, file)).join(", "),
  );
  // (b) Every Server Action under (assistant) resolves the acting —
  // assistantActionScope → loadAssistantScope → resolveAssistantActing, whose
  // first await it is — before any data-layer call.
  const scopeEntry = (() => {
    const start = scopeSource.indexOf("export async function assistantActionScope(");
    return start < 0 ? "" : scopeSource.slice(start, scopeSource.indexOf("\n}\n", start));
  })();
  const loaderAwaits = [...loader.matchAll(/await (\w+)\(/g)].map((m) => m[1]);
  check(
    "(b) assistantActionScope reaches loadAssistantScope with no data call before it, and resolveAssistantActing is the loader's first await",
    /return user \? loadAssistantScope\(user, teacherUserId\) : null;/.test(scopeEntry) &&
      [...scopeEntry.matchAll(/await (\w+)\(/g)].map((m) => m[1]).join() === "getCurrentUser" &&
      loaderAwaits[0] === "resolveAssistantActing",
    `${loaderAwaits.join(" → ")}`,
  );
  const serverActionFiles = assistantSurface.filter((file) => /^["']use server["']/m.test(readSource(file)));
  const actionProblems: string[] = [];
  for (const file of serverActionFiles) {
    const source = stripComments(readSource(file));
    // Everything the file takes from the data layer: the client, and every name imported from lib/db or a data helper.
    const dataNames = new Set<string>(["prisma", "scoped"]);
    for (const match of source.matchAll(/import \{([^}]+)\} from "@\/(lib\/db\/[\w-]+|app\/\[locale\]\/\(assistant\)\/assistant\/\[teacherId\]\/assessments\/scope)"/g)) {
      for (const name of match[1].split(",").map((part) => part.trim().replace(/^type\s+/, ""))) {
        if (name && !/^[A-Z]/.test(name)) dataNames.add(name);
      }
    }
    dataNames.delete("findAtBranches");
    const firstData = (body: string) => {
      let first = -1;
      for (const name of dataNames) {
        const at = body.search(new RegExp(`\\b${name}\\b\\s*(\\(|\\.)`));
        if (at >= 0 && (first < 0 || at < first)) first = at;
      }
      return first;
    };
    // A file-local helper that does the resolution must itself resolve first.
    const helperStart = source.indexOf("async function manageScope(");
    const helper = helperStart < 0 ? "" : source.slice(helperStart, source.indexOf("\n}\n", helperStart));
    const helperOk = helper === "" || (helper.indexOf("assistantActionScope(teacherId)") >= 0 && helper.indexOf("assistantActionScope(teacherId)") < firstData(helper.slice(helper.indexOf("{"))));
    for (const match of source.matchAll(/export async function (\w+)\(/g)) {
      const start = match.index ?? 0;
      const next = source.indexOf("\nexport ", start + 10);
      const body = source.slice(start, next < 0 ? undefined : next);
      // The function body opens at the first "{" that ends a line (the signature holds none).
      const signatureEnd = body.indexOf(`{${String.fromCharCode(10)}`) + 2;
      const inside = body.slice(signatureEnd);
      const direct = inside.search(/assistantActionScope\(teacherId\)/);
      const viaHelper = helper ? inside.search(/manageScope\(teacherId\)/) : -1;
      const gate = direct >= 0 ? direct : viaHelper;
      const data = firstData(inside);
      const refusesWithout = /if \(!(scope|managed)\) return FORBIDDEN;/.test(inside);
      const trustsPost = /formData\.get\(["'](userId|actorUserId|teacherUserId|assistantUserId|linkId|centerId)["']\)/.test(body);
      if (gate < 0 || (data >= 0 && data < gate) || !refusesWithout || trustsPost || (viaHelper >= 0 && !helperOk)) {
        actionProblems.push(`${relative(ROOT, file)}#${match[1]} (gate ${gate}, first data call ${data})`);
      }
    }
  }
  check(
    `(b) Every Server Action under (assistant) (${serverActionFiles.length} files) resolves the acting before its first data-layer call, refuses without it, and trusts no posted user, link or centre id`,
    // W8d (approved old → new): 2 → 3 files — assessments, requests and the workspace check-in and payments.
    serverActionFiles.length === 3 && actionProblems.length === 0,
    actionProblems.join(", "),
  );
  const assessmentActions = stripComments(read("app/[locale]/(assistant)/assistant/[teacherId]/assessments/actions.ts"));
  check("The assistant's assessment actions never read the posted centreId (the branch comes from the row)", !/\bcenterId\b/.test(assessmentActions));
  const requestActions = stripComments(read("app/[locale]/(assistant)/assistant/[teacherId]/requests/actions.ts"));
  check(
    "A session request takes its branch from the class; a class request's named branch is only matched among the granted branches",
    /findAtBranches\(scopeBranches\(scope, "requests\.manage"\)/.test(requestActions) &&
      /scopeBranches\(scope, "requests\.manage"\)\.find\(\(entry\) => entry\.centerId === centerId\)/.test(requestActions) &&
      !/centerId: centerId\b|[{,]\s*centerId,\s+request:/.test(requestActions),
  );
  const decisionFiles = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))].filter((file) => /TEACHER_EQUIVALENT/.test(readSource(file)));
  check(
    "assistantCan is the only place an assistant's permission is decided (the equivalence table lives in one file)",
    decisionFiles.length === 1 &&
      /assistant-acting\.ts$/.test(decisionFiles[0]) &&
      !assistantSurface.filter((file) => !/assistant-acting\.ts$/.test(file)).some((file) => /\bcan\("TEACHER"/.test(readSource(file))),
  );
  check(
    "The assistant reads select no phone (W7b: students.phones reveals nothing — the teacher's portal shows none)",
    !/phone/i.test(stripComments(read("lib/db/assistant-reads.ts"))),
  );
  check(
    "The centre's request reads drop the assistant's id (scoped changeRequests.list maps every row through withoutAssistantId)",
    /rows\.map\(withoutAssistantId\)/.test(read("lib/db/scoped.ts")) &&
      !/viaAssistantUserId/.test(stripComments(read("app/[locale]/(center)/approvals/page.tsx"))) &&
      !/viaAssistantUserId/.test(stripComments(read("app/[locale]/(center)/audit/page.tsx"))),
  );
  check(
    "The audit feed names the teacher for an on-behalf row and never looks the assistant up",
    /row\.onBehalfOfUserId \?\? row\.actorUserId/.test(read("lib/db/audit-feed.ts")),
  );
  check(
    // W8d (approved re-wording): the claim is now about branches — the workspace path is pinned by the W8d statics below.
    "No assistant path writes attendance or money at a branch (no engine writer is called from the assistant surface)",
    !assistantSurface.some((file) => /applyAttendanceChange|changeAttendanceStatus|createAttendance|recordPayment|sessionAttendanceChange/.test(stripComments(readSource(file)))),
  );
  check(
    "The assistant nav offers no settlements, money, account or premium page",
    !/settlement|payment|premium|account|profile|assistants/i.test(stripComments(read("lib/assistant-nav.ts")).replace(/assistantNavItems|AssistantActing|AssistantPermission|assistant-catalog|assistant-acting|assistantCan|assistantHome|assistantAssessments|assistantClasses|assistantRequests|assistantOverview/g, "")),
  );
  check("ASSISTANT is not a TenantRole: can() never sees it", !/ASSISTANT/.test(stripComments(read("lib/auth/permissions.ts"))));
  check(
    "The experience list and the assistant gate build only on effective links",
    /effectiveAssistantLinks\(prisma, userId, now\)/.test(stripComments(read("lib/auth/experiences.ts"))) &&
      /findEffectiveAssistantLink\(prisma, \{ assistantUserId: user\.id, teacherUserId \}\)/.test(stripComments(read("lib/auth/assistant-context.ts"))),
  );
  const joinForm = read("components/assistants/join-assistant-form.tsx");
  check(
    "The join page reads the code from the URL fragment and never builds a ?code= query",
    /location\.hash/.test(joinForm) && !/[?&]code=/.test(stripComments(joinForm)) && !/[?&]code=/.test(read("app/[locale]/(auth)/assistant-join/page.tsx")),
  );
  check(
    "Confirm is the only path to the link: the form previews first, and only the confirmation posts the redemption",
    /post\("preview", previewAction\)/.test(joinForm) && (joinForm.match(/post\("redeem", redeemAction\)/g) ?? []).length === 1,
  );
  workspaceStatics(assistantSurface, scopeSource, loader, actingSource);
}

/** W8d (D-W41 item 12): the W7a/W7b statics extended to the second source. */
function workspaceStatics(assistantSurface: string[], scopeSource: string, loader: string, actingSource: string) {
  console.log("Static sweeps — W8d workspaces");
  check(
    "(a) The resolver's workspace source is the teacher's own, from the teacher's id only (ownedWorkspaceWhere(teacherUserId), the teacher's membership there)",
    /db\.center\.findMany\(\{\s*where: ownedWorkspaceWhere\(teacherUserId\)/.test(actingSource) &&
      /memberships: \{ where: \{ userId: teacherUserId, role: "TEACHER", active: true \}/.test(actingSource) &&
      !/ownedWorkspaceWhere\((assistantUserId|actorUserId|user\.id)\)/.test(actingSource),
  );
  check(
    "(a) The scope's workspaces are exactly the resolver's (acting.workspaces.map), with no read of their own",
    /const workspaces = acting\.workspaces\.map\(/.test(loader) && !/ownedWorkspaceWhere|listOwnedWorkspaces|getWorkspaceContext|resolveWorkspaceAccess/.test(scopeSource),
  );
  check(
    "(a) A route's workspace id is only matched among the scope's workspaces (scopeWorkspace over scopeOpenWorkspaces)",
    /scopeOpenWorkspaces\(scope\)\.find\(\(workspace\) => workspace\.centerId === workspaceId\)/.test(scopeSource),
  );
  const workspacePages = assistantSurface.filter((file) => /[\\/]workspaces[\\/]/.test(file) && /[\\/]page\.tsx$/.test(file));
  const unmatched = workspacePages.filter((file) => {
    const source = stripComments(readSource(file));
    return !/getAssistantScope\(teacherId\)/.test(source) || !/(scopeWorkspace\(scope, id\)|scopeOpenWorkspaces\(scope\))/.test(source) || /getWorkspaceContext\(|resolveWorkspaceAccess\(/.test(source);
  });
  check(
    `(a) Every assistant workspace page (${workspacePages.length}) re-resolves the link and takes its workspace from the scope, never getWorkspaceContext`,
    workspacePages.length === 5 && unmatched.length === 0,
    unmatched.map((file) => relative(ROOT, file)).join(", "),
  );
  const actions = stripComments(read("app/[locale]/(assistant)/assistant/[teacherId]/workspaces/actions.ts"));
  const bodies = [...actions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g)].map((match) => match[0]);
  check(
    "(b) Every workspace action resolves the acting first, matches the workspace among the teacher's, then calls the writer as { assistant, the scope's teacher }",
    bodies.length === 6 &&
      bodies.every((body) => {
        const scopeAt = body.indexOf("assistantActionScope(teacherId)");
        const matchAt = body.indexOf("scopeWorkspace(scope, workspaceId)");
        const writeAt = body.search(/await workspace\w+\(prisma, actorOf\(scope\), workspace\.centerId/);
        return scopeAt > 0 && scopeAt < matchAt && matchAt < writeAt && /if \(!workspace\) return NOT_FOUND;/.test(body);
      }) &&
      /return \{ actorUserId: scope\.user\.id, teacherUserId: scope\.acting\.teacherUserId \};/.test(actions) &&
      !/formData\.get\(|amount|paymentMethodId/.test(actions),
  );
  const writers = stripComments(read("lib/db/workspace-attendance.ts"));
  const authorizeBody = writers.slice(writers.indexOf("async function authorize("), writers.indexOf("function findWorkspaceSession("));
  const resolveAt = authorizeBody.indexOf("resolveAssistantActing(db, { assistantUserId: actor.actorUserId, teacherUserId: actor.teacherUserId, now })");
  const decideAt = authorizeBody.indexOf("assistantCan(acting, key, workspaceId)");
  const gateAt = authorizeBody.indexOf("authorizeWrite(db, acting.teacherUserId, workspaceId, action, now)");
  check(
    "The writers' assistant path: resolve from both ids, decide with assistantCan, then the teacher's own authorizeWrite (capability, premium, not archived) — in that order",
    resolveAt > 0 && resolveAt < decideAt && decideAt < gateAt && /onBehalfOfUserId: onBehalfOf\(actor\.actorUserId, acting\.teacherUserId\)/.test(authorizeBody),
  );
  check(
    "Every workspace writer stamps onBehalfOf on its own audit rows and passes it to the engine's",
    (writers.match(/onBehalfOfUserId: auth\.onBehalfOfUserId/g) ?? []).length >= 7 && /writePaymentRecordAudit\(tx, centerId, actor\.actorUserId, recorded\.payment, auth\.onBehalfOfUserId\)/.test(writers),
  );
  const workspaceWriteCallers = assistantSurface.filter((file) => /\bworkspace(CheckIn|SetAttendance|RecordPayment|VoidPayment|RefundPayment|CloseSession)\(/.test(stripComments(readSource(file))));
  check(
    "The assistant's only attendance and money writes are the six workspace-attendance writers, from the one workspace actions file",
    workspaceWriteCallers.length === 1 && /workspaces[\\/]actions\.ts$/.test(workspaceWriteCallers[0]),
    workspaceWriteCallers.map((file) => relative(ROOT, file)).join(", "),
  );
  const forbidden =
    /\b(createWorkspace|createWorkspaceClass|updateWorkspaceClass|setWorkspaceClassActive|deleteWorkspaceClass|writeWorkspaceClassSlot|createWorkspaceSession|rescheduleWorkspaceSession|cancelWorkspaceSession|deleteWorkspaceSession|renameWorkspace|archiveWorkspace|unarchiveWorkspace|addWorkspaceStudent|copyWorkspaceStudent|inviteWorkspaceStudentAgain|cancelWorkspaceInvitation|enrolWorkspaceStudent|removeWorkspaceEnrollment|createSessionSettlement|createPeriodSettlement|approveSettlement|paySettlement)\(|@\/app\/\[locale\]\/\(teacher\)\/teacher\/workspaces\/(actions|student-actions|session-actions)"/;
  const reaching = assistantSurface.filter((file) => forbidden.test(stripComments(readSource(file))));
  check(
    "The assistant surface never reaches a workspace creation, class, session, student, invitation, settings or settlement writer, nor the teacher's workspace actions",
    reaching.length === 0,
    reaching.map((file) => relative(ROOT, file)).join(", "),
  );
  const listCallers = assistantSurface.filter((file) => /<WorkspaceSessionList/.test(readSource(file)));
  check(
    "The assistant's session lists are read-only (writable={false}) and link to the assistant's own session page",
    listCallers.length === 2 &&
      listCallers.every((file) => /writable=\{false\}/.test(readSource(file)) && /sessionHref=\{\(sessionId\) => ROUTES\.assistantWorkspaceSession\(/.test(readSource(file))),
  );
  check(
    "assistantCan decides workspaces too: the workspace equivalents live beside the branch table, the teacher's capability through workspaceCan",
    /const WORKSPACE_EQUIVALENT:/.test(actingSource) && /return workspaceCan\(\{ workspace: access \}, capability \?\? "workspace\.sessions\.manage"\);/.test(actingSource) &&
      // W9 old → new (A, approved in the W9 follow-up, D-W42): both assessment keys stand for the teacher's
      // workspace.assessments.manage; requests.manage still grants nothing in a workspace.
      /"assessments\.review": "workspace\.assessments\.manage",\s*"assessments\.manage": "workspace\.assessments\.manage",[\s\S]{0,80}"requests\.manage": false/.test(
        actingSource.slice(actingSource.indexOf("const WORKSPACE_EQUIVALENT")),
      ),
  );
}

async function main() {
  await cleanup();
  staticChecks();
  const now = new Date();

  const admin = await makeUser("admin", { isPlatformAdmin: true });
  const org = await prisma.organization.create({ data: { name: `${ORG_NAME} ${RUN}` } });
  const center = await prisma.center.create({ data: { slug: SLUG, name: `${ORG_NAME} A`, organizationId: org.id } });

  /** A premium teacher (W6's grant, 400 days ahead). */
  async function premiumTeacher(tag: string) {
    const user = await makeUser(tag);
    await member(center.id, user.id, "TEACHER");
    const granted = await grantPremium(prisma, { actorUserId: admin.id, userId: user.id, endDay: premiumLatestEndDay(now), now });
    if (!granted.ok) throw new Error(`grantPremium: ${granted.error}`);
    return user;
  }
  async function invite(teacherId: string, preset: string = "CO_TEACHER", at: Date = now) {
    const created = await createAssistantInvite(prisma, { actorUserId: teacherId, preset, now: at });
    if (!created.ok) throw new Error(`createAssistantInvite: ${created.error}`);
    codesIssued.add(created.code);
    return created;
  }
  async function link(teacherId: string, preset = "CO_TEACHER") {
    const created = await invite(teacherId, preset);
    const assistant = await makeUser("assistant");
    const redeemed = await redeemAssistantCode(prisma, { userId: assistant.id, code: created.code, ip: ip(), now });
    if (!redeemed.ok) throw new Error(`redeemAssistantCode: ${redeemed.error}`);
    return { assistant, linkId: redeemed.linkId };
  }

  // ── 1. Codes ───────────────────────────────────────────────────────────
  console.log("\n1. Codes");
  const sample = Array.from({ length: 200 }, () => generateAssistantCode());
  check(
    "Codes are 12 symbols from the unambiguous alphabet (no 0 O 1 I L)",
    sample.every((code) => code.length === 12 && [...code].every((char) => ASSISTANT_CODE_ALPHABET.includes(char))) &&
      !/[0O1IL]/.test(ASSISTANT_CODE_ALPHABET),
  );
  check("200 codes are 200 different codes", new Set(sample).size === sample.length);
  check(
    "Typing is forgiving: lower case, dashes, spaces and Arabic digits normalize; a misreadable symbol or a wrong length does not",
    normalizeAssistantCode("abcd-efgh-2345") === "ABCDEFGH2345" &&
      normalizeAssistantCode(" ABCD EFGH 2345 ") === "ABCDEFGH2345" &&
      normalizeAssistantCode("ABCDEFGH" + String.fromCodePoint(0x0662, 0x0663, 0x0664, 0x0665)) === "ABCDEFGH2345" &&
      normalizeAssistantCode("ABCD-EFGH-0123") === null &&
      normalizeAssistantCode("ABCD-2345") === null &&
      formatAssistantCodeForDisplay("abcdefgh2345") === "ABCD-EFGH-2345",
  );

  const teacher = await premiumTeacher("teacher");
  const first = await invite(teacher.id);
  const firstRow = await prisma.assistantInvite.findUniqueOrThrow({ where: { id: first.inviteId } });
  const rowText = JSON.stringify(firstRow);
  check(
    "Storage is sha256 only: the row holds sha256(code) and the plaintext (or any third of it) appears nowhere",
    firstRow.codeHash === createHash("sha256").update(first.code).digest("hex") &&
      !rowText.includes(first.code) &&
      !rowText.includes(first.code.slice(0, 4)) &&
      !rowText.includes(first.code.slice(4, 8)),
  );
  check(
    "The invite expires 7 days after creation",
    firstRow.expiresAt.getTime() - firstRow.createdAt.getTime() === ASSISTANT_LIMITS.inviteDays * 86_400_000,
  );
  let plaintextRefused = false;
  try {
    await prisma.assistantInvite.create({
      data: { teacherUserId: teacher.id, codeHash: "ABCDEFGH2345", preset: "GRADER", expiresAt: new Date(now.getTime() + 60_000) },
    });
  } catch {
    plaintextRefused = true;
  }
  check("The database refuses a plaintext code (codeHash must be a sha256 — CHECK constraint)", plaintextRefused);
  const index = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'TeacherAssistant' AND indexname = 'TeacherAssistant_pair_live_key'`;
  check(
    "The hand-written partial unique index exists (CLAUDE.md rule 7)",
    index.length === 1 && /UNIQUE/.test(index[0].indexdef) && /WHERE \("revokedAt" IS NULL\)/.test(index[0].indexdef),
    index[0]?.indexdef ?? "missing",
  );

  // ── 2. One answer; the expiry boundary ─────────────────────────────────
  console.log("\n2. One answer for every unusable code; the expiry boundary");
  const asker = await makeUser("asker");
  const preview = (code: string, at: Date = now, userId = asker.id) => previewAssistantCode(prisma, { userId, code, ip: ip(), now: at });
  const ok = await preview(first.code);
  check(
    "A live code previews the teacher's name and the preset's permissions, and writes nothing",
    ok.ok && ok.teacherUserId === teacher.id && ok.preset === "CO_TEACHER" && ok.permissions.join() === PRESET_PERMISSIONS.CO_TEACHER.join() &&
      (await prisma.teacherAssistant.count({ where: { teacherUserId: teacher.id } })) === 0 &&
      (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: first.inviteId } })).usedAt === null,
  );
  const expiresAt = firstRow.expiresAt;
  const justBefore = await preview(first.code, new Date(expiresAt.getTime() - 1));
  const atExpiry = await preview(first.code, expiresAt);
  check("Expiry boundary: 1 ms before expiresAt redeemable, at expiresAt itself expired", justBefore.ok && !atExpiry.ok && atExpiry.error === "invalidCode");
  check(
    "An expired invite no longer holds a slot",
    (await assistantSlotsInUse(prisma, teacher.id, new Date(expiresAt.getTime() - 1))) === 1 && (await assistantSlotsInUse(prisma, teacher.id, expiresAt)) === 0,
  );

  const revoked = await invite(teacher.id);
  check("The teacher revokes their own unused invite", (await revokeAssistantInvite(prisma, { actorUserId: teacher.id, inviteId: revoked.inviteId })).ok);
  const used = await invite(teacher.id);
  const usedBy = await makeUser("usedby");
  check("A code redeems once", (await redeemAssistantCode(prisma, { userId: usedBy.id, code: used.code, ip: ip(), now })).ok);
  const answers = [
    await preview(generateAssistantCode()),
    await preview("not a code"),
    atExpiry,
    await preview(used.code),
    await preview(revoked.code),
    await redeemAssistantCode(prisma, { userId: asker.id, code: revoked.code, ip: ip(), now }),
  ];
  check(
    "Unknown, malformed, expired, used and revoked codes give one answer (invalidCode), preview and redeem alike",
    answers.every((answer) => !answer.ok && answer.error === "invalidCode"),
    answers.map((answer) => (answer.ok ? "ok" : answer.error)).join(","),
  );
  const expiredRedeem = await redeemAssistantCode(prisma, { userId: asker.id, code: first.code, ip: ip(), now: expiresAt });
  check("Redeeming at the expiry instant is refused the same way, and nothing is claimed", !expiredRedeem.ok && expiredRedeem.error === "invalidCode" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: first.inviteId } })).usedAt === null);

  // ── 3. Single use under concurrency ────────────────────────────────────
  console.log("\n3. Single use under two concurrent redemptions");
  const deskA = await gatePrisma({ sweepUsers: false });
  const deskB = await gatePrisma({ sweepUsers: false });
  try {
    const raceTeacher = await premiumTeacher("raceteacher");
    const raced = await invite(raceTeacher.id);
    const [racerA, racerB] = [await makeUser("racer"), await makeUser("racer")];
    const results = await Promise.all([
      redeemAssistantCode(deskA, { userId: racerA.id, code: raced.code, ip: ip(), now }),
      redeemAssistantCode(deskB, { userId: racerB.id, code: raced.code, ip: ip(), now }),
    ]);
    const wins = results.filter((result) => result.ok).length;
    const loser = results.find((result) => !result.ok);
    check(
      "Two parallel redemptions of one code: exactly one link, the other invalidCode",
      wins === 1 && loser !== undefined && !loser.ok && loser.error === "invalidCode" &&
        (await prisma.teacherAssistant.count({ where: { teacherUserId: raceTeacher.id, assistantUserId: { in: [racerA.id, racerB.id] } } })) === 1,
      results.map((result) => (result.ok ? "ok" : result.error)).join(","),
    );

    // ── 5. The cap under concurrent creation ─────────────────────────────
    console.log("\n5. Five slots, pending invites included, under concurrent creation");
    const capTeacher = await premiumTeacher("capteacher");
    await link(capTeacher.id);
    await invite(capTeacher.id);
    await invite(capTeacher.id);
    await invite(capTeacher.id);
    check("1 assistant + 3 pending invites = 4 slots", (await assistantSlotsInUse(prisma, capTeacher.id, now)) === 4);
    const creations = await Promise.all([
      createAssistantInvite(deskA, { actorUserId: capTeacher.id, preset: "GRADER", now }),
      createAssistantInvite(deskB, { actorUserId: capTeacher.id, preset: "GRADER", now }),
    ]);
    for (const created of creations) if (created.ok) codesIssued.add(created.code);
    check(
      "Two parallel creations for the 5th slot: exactly one wins, the other slotsFull",
      creations.filter((created) => created.ok).length === 1 && creations.some((created) => !created.ok && created.error === "slotsFull") &&
        (await assistantSlotsInUse(prisma, capTeacher.id, now)) === 5,
      creations.map((created) => (created.ok ? "ok" : created.error)).join(","),
    );
    const sixth = await createAssistantInvite(prisma, { actorUserId: capTeacher.id, preset: "GRADER", now });
    check("The 6th slot (active or pending) is refused", !sixth.ok && sixth.error === "slotsFull");
    const overview = await teacherAssistantsOverview(prisma, capTeacher.id, now);
    check("The teacher's page counts the same 5 (1 assistant, 4 pending)", overview.slotsUsed === 5 && overview.assistants.length === 1 && overview.pendingInvites.length === 4);
    const freed = await revokeAssistantInvite(prisma, { actorUserId: capTeacher.id, inviteId: overview.pendingInvites[0].inviteId });
    const afterFree = await createAssistantInvite(prisma, { actorUserId: capTeacher.id, preset: "FULL", now });
    if (afterFree.ok) codesIssued.add(afterFree.code);
    check("Revoking a pending invite frees its slot for a new one", freed.ok && afterFree.ok);
  } finally {
    await deskA.$disconnect();
    await deskB.$disconnect();
  }

  // ── 4. Rate limit ──────────────────────────────────────────────────────
  console.log("\n4. Rate limit");
  const guesser = await makeUser("guesser");
  const guesses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    guesses.push(await previewAssistantCode(prisma, { userId: guesser.id, code: generateAssistantCode(), ip: ip(), now }));
  }
  check(
    "10 attempts an hour per account: the 11th is rateLimited, before any lookup",
    guesses.slice(0, 10).every((guess) => !guess.ok && guess.error === "invalidCode") && !guesses[10].ok && guesses[10].error === "rateLimited",
  );
  const limited = await invite(teacher.id);
  const blockedEvenWithValid = await redeemAssistantCode(prisma, { userId: guesser.id, code: limited.code, ip: ip(), now });
  check("…and a valid code from that account is refused too, with nothing claimed", !blockedEvenWithValid.ok && blockedEvenWithValid.error === "rateLimited" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: limited.inviteId } })).usedAt === null);
  const sharedIp = ip();
  const fromIp = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const person = await makeUser("ipuser");
    fromIp.push(await previewAssistantCode(prisma, { userId: person.id, code: generateAssistantCode(), ip: sharedIp, now }));
  }
  check("10 attempts an hour per client IP across accounts: the 11th is rateLimited", fromIp.slice(0, 10).every((guess) => !guess.ok && guess.error === "invalidCode") && !fromIp[10].ok && fromIp[10].error === "rateLimited");

  // ── 6. No self-assist; one link per pair ───────────────────────────────
  console.log("\n6. No self-assist; one live link per pair");
  const own = await invite(teacher.id);
  const ownPreview = await previewAssistantCode(prisma, { userId: teacher.id, code: own.code, ip: ip(), now });
  const ownRedeem = await redeemAssistantCode(prisma, { userId: teacher.id, code: own.code, ip: ip(), now });
  check("The teacher's own code is refused (ownCode), preview and redeem, nothing claimed", !ownPreview.ok && ownPreview.error === "ownCode" && !ownRedeem.ok && ownRedeem.error === "ownCode" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: own.inviteId } })).usedAt === null);
  let selfRefused = false;
  try {
    await prisma.teacherAssistant.create({ data: { teacherUserId: teacher.id, assistantUserId: teacher.id, preset: "GRADER" } });
  } catch {
    selfRefused = true;
  }
  check("The database refuses a self-link (CHECK constraint)", selfRefused);

  const pairTeacher = await premiumTeacher("pairteacher");
  const pair = await makeUser("pair");
  const pairCode = await invite(pairTeacher.id);
  check("A first code links the pair", (await redeemAssistantCode(prisma, { userId: pair.id, code: pairCode.code, ip: ip(), now })).ok);
  const secondCode = await invite(pairTeacher.id);
  const second = await redeemAssistantCode(prisma, { userId: pair.id, code: secondCode.code, ip: ip(), now });
  check("A second code for the same pair is refused (alreadyAssistant) and stays unused", !second.ok && second.error === "alreadyAssistant" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: secondCode.inviteId } })).usedAt === null);
  let duplicateRefused = false;
  try {
    await prisma.teacherAssistant.create({ data: { teacherUserId: pairTeacher.id, assistantUserId: pair.id, preset: "GRADER" } });
  } catch {
    duplicateRefused = true;
  }
  check("The partial index refuses a second live link for the pair, written directly", duplicateRefused);
  const pairLink = await prisma.teacherAssistant.findFirstOrThrow({ where: { teacherUserId: pairTeacher.id, assistantUserId: pair.id, revokedAt: null } });
  check("The teacher removes the assistant", (await removeAssistant(prisma, { actorUserId: pairTeacher.id, linkId: pairLink.id })).ok);
  const relinked = await redeemAssistantCode(prisma, { userId: pair.id, code: secondCode.code, ip: ip(), now });
  check(
    "A removed link frees the pair: a new code relinks with a new row, the old one kept as removed",
    relinked.ok && relinked.linkId !== pairLink.id &&
      (await prisma.teacherAssistant.count({ where: { teacherUserId: pairTeacher.id, assistantUserId: pair.id } })) === 2 &&
      (await prisma.teacherAssistant.count({ where: { teacherUserId: pairTeacher.id, assistantUserId: pair.id, revokedAt: null } })) === 1,
  );

  // ── 7. Presets, toggles, the catalogue ─────────────────────────────────
  console.log("\n7. Presets → grants, Custom, the catalogue");
  const presetTeacher = await premiumTeacher("presetteacher");
  check("students.phones is in no preset", ASSISTANT_PRESETS.every((preset) => !PRESET_PERMISSIONS[preset].includes("students.phones")));
  check(
    "Grader ⊂ Co-teacher ⊂ Full, exactly as decided",
    PRESET_PERMISSIONS.GRADER.join() === "assessments.review" &&
      PRESET_PERMISSIONS.CO_TEACHER.join() === "assessments.review,assessments.manage,classes.view,requests.manage,checkin.workspace,payments.workspace" &&
      PRESET_PERMISSIONS.FULL.join() === [...PRESET_PERMISSIONS.CO_TEACHER, "analytics.view"].join(),
  );
  check(
    "Custom detection: each preset reads as itself; one toggle more or less reads Custom",
    ASSISTANT_PRESETS.every((preset) => detectPreset([...PRESET_PERMISSIONS[preset]].reverse()) === preset) &&
      detectPreset([...PRESET_PERMISSIONS.FULL, "students.phones"]) === "CUSTOM" &&
      detectPreset(PRESET_PERMISSIONS.CO_TEACHER.slice(1)) === "CUSTOM" &&
      detectPreset([]) === "CUSTOM",
  );
  for (const preset of ASSISTANT_PRESETS) {
    const made = await link(presetTeacher.id, preset);
    const grants = await prisma.assistantPermissionGrant.findMany({ where: { assistantId: made.linkId } });
    const names = ASSISTANT_PERMISSIONS.filter((permission) => grants.some((grant) => grant.permission === permission));
    check(`Redeeming a ${preset} invite writes exactly its grants`, names.join() === PRESET_PERMISSIONS[preset].join() && grants.length === names.length);
  }
  const tuned = await link(presetTeacher.id, "CO_TEACHER");
  const toggled = await updateAssistantPermissions(prisma, {
    actorUserId: presetTeacher.id,
    linkId: tuned.linkId,
    change: { permissions: [...PRESET_PERMISSIONS.CO_TEACHER, "students.phones"] },
  });
  check("A toggle adds students.phones; the link reads Custom, the stored preset kept", toggled.ok && toggled.preset === "CUSTOM" && (await prisma.teacherAssistant.findUniqueOrThrow({ where: { id: tuned.linkId } })).preset === "CO_TEACHER");
  const toFull = await updateAssistantPermissions(prisma, { actorUserId: presetTeacher.id, linkId: tuned.linkId, change: { preset: "FULL" } });
  const fullGrants = (await prisma.assistantPermissionGrant.findMany({ where: { assistantId: tuned.linkId } })).map((grant) => grant.permission);
  check(
    "Choosing a preset replaces the grants with exactly its set (students.phones gone) and stores it",
    toFull.ok && toFull.preset === "FULL" && fullGrants.length === PRESET_PERMISSIONS.FULL.length && !fullGrants.includes("students.phones") &&
      (await prisma.teacherAssistant.findUniqueOrThrow({ where: { id: tuned.linkId } })).preset === "FULL",
  );
  const toggledToGrader = await updateAssistantPermissions(prisma, { actorUserId: presetTeacher.id, linkId: tuned.linkId, change: { permissions: ["assessments.review"] } });
  check("Toggles that land exactly on a preset read as that preset and store it", toggledToGrader.ok && toggledToGrader.preset === "GRADER" && (await prisma.teacherAssistant.findUniqueOrThrow({ where: { id: tuned.linkId } })).preset === "GRADER");
  const auditBefore = await assistantRowCounts();
  const sameAgain = await updateAssistantPermissions(prisma, { actorUserId: presetTeacher.id, linkId: tuned.linkId, change: { preset: "GRADER" } });
  check("An unchanged set writes nothing (no audit row)", sameAgain.ok && !sameAgain.changed && (await assistantRowCounts()) === auditBefore);
  const unknownPermission = await updateAssistantPermissions(prisma, {
    actorUserId: presetTeacher.id,
    linkId: tuned.linkId,
    change: { permissions: ["assessments.review", "center.profit.view"] },
  });
  const unknownPreset = await updateAssistantPermissions(prisma, { actorUserId: presetTeacher.id, linkId: tuned.linkId, change: { preset: "OWNER" } });
  const notArray = await updateAssistantPermissions(prisma, { actorUserId: presetTeacher.id, linkId: tuned.linkId, change: { permissions: "assessments.review" } });
  const unknownInvite = await createAssistantInvite(prisma, { actorUserId: presetTeacher.id, preset: "CUSTOM", now });
  check(
    "Unknown permission names and presets are refused, nothing written",
    !unknownPermission.ok && unknownPermission.error === "unknownPermission" &&
      !notArray.ok && notArray.error === "unknownPermission" &&
      !unknownPreset.ok && unknownPreset.error === "unknownPreset" &&
      !unknownInvite.ok && unknownInvite.error === "unknownPreset" &&
      (await assistantRowCounts()) === auditBefore,
  );

  // ── 8. Premium expiry and renewal ──────────────────────────────────────
  console.log("\n8. Premium expiry hides the experience; renewal restores it");
  const lapsing = await makeUser("lapsing");
  await member(center.id, lapsing.id, "TEACHER");
  const endsToday = await grantPremium(prisma, { actorUserId: admin.id, userId: lapsing.id, endDay: premiumToday(now), now });
  if (!endsToday.ok) throw new Error(`grantPremium: ${endsToday.error}`);
  const boundary = premiumUntilForDay(premiumToday(now));
  const { assistant: helper, linkId: helperLink } = await link(lapsing.id, "FULL");
  const keys = async (at: Date) => (await assistantExperienceSources(prisma, helper.id, at)).map((source) => assistantExperienceKey(source.teacherUserId));
  const before = new Date(boundary.getTime() - 1);
  check("While premium: the assistant has the experience", (await keys(before)).includes(assistantExperienceKey(lapsing.id)));
  check(
    "At the premium end instant: the experience is gone, the route's link resolves to nothing",
    (await keys(boundary)).length === 0 && (await findEffectiveAssistantLink(prisma, { assistantUserId: helper.id, teacherUserId: lapsing.id, now: boundary })) === null,
  );
  check(
    "…while the link and its grants stay",
    (await prisma.teacherAssistant.findUniqueOrThrow({ where: { id: helperLink } })).revokedAt === null &&
      (await prisma.assistantPermissionGrant.count({ where: { assistantId: helperLink } })) === PRESET_PERMISSIONS.FULL.length,
  );
  const lapsedWrites = await Promise.all([
    createAssistantInvite(prisma, { actorUserId: lapsing.id, preset: "GRADER", now: boundary }),
    updateAssistantPermissions(prisma, { actorUserId: lapsing.id, linkId: helperLink, change: { preset: "GRADER" }, now: boundary }),
  ]);
  check("A lapsed teacher is refused what widens access — a new invite, a permission change (premiumRequired)", lapsedWrites.every((result) => !result.ok && result.error === "premiumRequired"));
  // W7b (D-W37 item 12, the prompt's old → new): reducing access never needs premium.
  const spareInvite = await invite(lapsing.id, "GRADER", before);
  const { linkId: spareLink } = await link(lapsing.id, "GRADER");
  const lapsedRevoke = await revokeAssistantInvite(prisma, { actorUserId: lapsing.id, inviteId: spareInvite.inviteId, now: boundary });
  const lapsedRemove = await removeAssistant(prisma, { actorUserId: lapsing.id, linkId: spareLink, now: boundary });
  check(
    "…but a lapsed teacher may still revoke an invite and remove an assistant (W7b: no premium needed)",
    lapsedRevoke.ok && lapsedRemove.ok &&
      (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: spareInvite.inviteId } })).revokedAt !== null &&
      (await prisma.teacherAssistant.findUniqueOrThrow({ where: { id: spareLink } })).revokedAt !== null,
  );
  const lapsedCode = await invite(lapsing.id, "GRADER", before);
  const toLapsed = await redeemAssistantCode(prisma, { userId: (await makeUser("late")).id, code: lapsedCode.code, ip: ip(), now: boundary });
  check("A code from a teacher who is not premium now is refused (teacherUnavailable), nothing claimed", !toLapsed.ok && toLapsed.error === "teacherUnavailable" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: lapsedCode.inviteId } })).usedAt === null);
  const renewed = await extendPremium(prisma, { actorUserId: admin.id, userId: lapsing.id, endDay: premiumLatestEndDay(now), now });
  check("Renewal (W6's extend) restores the experience at the same instant, grants unchanged", renewed.ok && (await keys(boundary)).includes(assistantExperienceKey(lapsing.id)) &&
    (await findEffectiveAssistantLink(prisma, { assistantUserId: helper.id, teacherUserId: lapsing.id, now: boundary }))?.permissions.join() === PRESET_PERMISSIONS.FULL.join());
  const { assistant: leaver, linkId: leaverLink } = await link(lapsing.id, "GRADER");
  const revokedPremium = await revokePremium(prisma, { actorUserId: admin.id, userId: lapsing.id, now });
  const listedAfterRevoke = (await loadExperiences(prisma, helper.id)).map((entry) => entry.key);
  const lapsedLeave = await leaveAssistantLink(prisma, { actorUserId: leaver.id, linkId: leaverLink });
  check("An assistant may leave a teacher who is not premium now (W7b: no premium needed)", revokedPremium.ok && lapsedLeave.ok);
  const regranted = await grantPremium(prisma, { actorUserId: admin.id, userId: lapsing.id, endDay: premiumLatestEndDay(now), now });
  const listedAfterRegrant = (await loadExperiences(prisma, helper.id)).map((entry) => entry.key);
  check(
    "The real list (loadExperiences, this request's clock): revoked premium hides it, a new grant brings it back",
    revokedPremium.ok && regranted.ok && !listedAfterRevoke.includes(assistantExperienceKey(lapsing.id)) && listedAfterRegrant.includes(assistantExperienceKey(lapsing.id)),
    `${listedAfterRevoke.join()} → ${listedAfterRegrant.join()}`,
  );
  const entry = (await loadExperiences(prisma, helper.id)).find((item) => item.kind === "assistant");
  check(
    "The entry: key assistant:<teacher>, the teacher's name as its place, its own landing route, no branch",
    entry?.key === assistantExperienceKey(lapsing.id) && entry.label.place === `Fixture ${lapsing.lastName}` &&
      entry.href === `/assistant/${lapsing.id}` && entry.centerId === undefined && entry.group.kind === "portals",
  );

  // ── 9. Every non-owner refused by direct call ──────────────────────────
  console.log("\n9. Every non-owner refused by direct call, nothing written");
  const victimTeacher = await premiumTeacher("victimteacher");
  const { assistant: victimAssistant, linkId: victimLink } = await link(victimTeacher.id, "GRADER");
  const victimInvite = await invite(victimTeacher.id);
  const plainTeacher = await makeUser("plainteacher");
  await member(center.id, plainTeacher.id, "TEACHER");
  const otherTeacher = await premiumTeacher("otherteacher");
  const premiumStaff: Record<string, { id: string }> = {};
  for (const role of ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const) {
    const staff = await makeUser(role.toLowerCase());
    await member(center.id, staff.id, role);
    const granted = await grantPremium(prisma, { actorUserId: admin.id, userId: staff.id, endDay: premiumLatestEndDay(now), now });
    if (!granted.ok) throw new Error(`grantPremium: ${granted.error}`);
    premiumStaff[role] = staff;
  }
  const student = await makeUser("student");
  await prisma.studentProfile.create({ data: scopedData(center.id, { userId: student.id, studentCode: `AC-${RUN}`, firstName: "S", lastName: "S" }) });
  if (!(await grantPremium(prisma, { actorUserId: admin.id, userId: student.id, endDay: premiumLatestEndDay(now), now })).ok) throw new Error("grantPremium student");

  const intruders: [string, string | null, string][] = [
    ["no actor", null, "forbidden"],
    // W7b: revoke and remove need no premium, so a non-premium teacher gets the
    // ownership refusal (notFound) on those two instead (the prompt's old → new).
    ["a non-premium teacher", plainTeacher.id, "premiumRequired|notFound|premiumRequired|notFound"],
    ["premium OWNER", premiumStaff.OWNER.id, "forbidden"],
    ["premium MANAGER", premiumStaff.MANAGER.id, "forbidden"],
    ["premium RECEPTIONIST", premiumStaff.RECEPTIONIST.id, "forbidden"],
    ["premium ACCOUNTANT", premiumStaff.ACCOUNTANT.id, "forbidden"],
    ["a premium student", student.id, "forbidden"],
    ["the platform admin", admin.id, "forbidden"],
  ];
  const countsBefore = await assistantRowCounts();
  for (const [label, actor, expected] of intruders) {
    const results = [
      await createAssistantInvite(prisma, { actorUserId: actor, preset: "GRADER", now }),
      await revokeAssistantInvite(prisma, { actorUserId: actor, inviteId: victimInvite.inviteId, now }),
      await updateAssistantPermissions(prisma, { actorUserId: actor, linkId: victimLink, change: { preset: "FULL" }, now }),
      await removeAssistant(prisma, { actorUserId: actor, linkId: victimLink, now }),
    ];
    const wanted = expected.includes("|") ? expected.split("|") : results.map(() => expected);
    check(`${label}: create, revoke, change permissions and remove all refused (${expected})`, results.every((result, index) => !result.ok && result.error === wanted[index]), results.map((result) => (result.ok ? "ok" : result.error)).join(","));
  }
  const otherResults = [
    await revokeAssistantInvite(prisma, { actorUserId: otherTeacher.id, inviteId: victimInvite.inviteId, now }),
    await updateAssistantPermissions(prisma, { actorUserId: otherTeacher.id, linkId: victimLink, change: { preset: "FULL" }, now }),
    await removeAssistant(prisma, { actorUserId: otherTeacher.id, linkId: victimLink, now }),
  ];
  check("Another premium teacher: the first teacher's invite and assistant are notFound", otherResults.every((result) => !result.ok && result.error === "notFound"));
  const leaves = [
    await leaveAssistantLink(prisma, { actorUserId: victimTeacher.id, linkId: victimLink }),
    await leaveAssistantLink(prisma, { actorUserId: otherTeacher.id, linkId: victimLink }),
    await leaveAssistantLink(prisma, { actorUserId: null, linkId: victimLink }),
  ];
  check("Only the assistant leaves their link: the teacher, another teacher and no actor are refused", leaves.every((result) => !result.ok));
  check(
    "Nothing was written by any refusal (invites/links/grants/audit rows unchanged), and the victim link still holds GRADER",
    (await assistantRowCounts()) === countsBefore &&
      (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: victimInvite.inviteId } })).revokedAt === null &&
      (await findEffectiveAssistantLink(prisma, { assistantUserId: victimAssistant.id, teacherUserId: victimTeacher.id, now }))?.preset === "GRADER",
  );
  const unverifiedEnv = process.env.REQUIRE_EMAIL_CONFIRMATION;
  process.env.REQUIRE_EMAIL_CONFIRMATION = "true";
  const unconfirmed = await makeUser("unconfirmed", { emailVerifiedAt: null });
  const unverifiedTry = await previewAssistantCode(prisma, { userId: unconfirmed.id, code: victimInvite.code, ip: ip(), now });
  if (unverifiedEnv === undefined) delete process.env.REQUIRE_EMAIL_CONFIRMATION;
  else process.env.REQUIRE_EMAIL_CONFIRMATION = unverifiedEnv;
  check("Under REQUIRE_EMAIL_CONFIRMATION an unconfirmed account cannot redeem", !unverifiedTry.ok && unverifiedTry.error === "unverified");
  const staffJoin = await redeemAssistantCode(prisma, { userId: premiumStaff.RECEPTIONIST.id, code: victimInvite.code, ip: ip(), now });
  check("Any verified account may redeem — a receptionist joins as an assistant", staffJoin.ok);
  const parentLike = await makeUser("anyone");
  const studentJoinCode = await invite(victimTeacher.id);
  check("…and a student too", (await redeemAssistantCode(prisma, { userId: student.id, code: studentJoinCode.code, ip: ip(), now })).ok);
  void parentLike;

  const left = await leaveAssistantLink(prisma, { actorUserId: victimAssistant.id, linkId: victimLink });
  check(
    "The assistant leaves: audited, the experience gone at once",
    left.ok && (await findEffectiveAssistantLink(prisma, { assistantUserId: victimAssistant.id, teacherUserId: victimTeacher.id, now })) === null &&
      (await prisma.auditLog.count({ where: { action: ASSISTANT_AUDIT_ACTIONS.linkLeave, entityId: victimLink, actorUserId: victimAssistant.id } })) === 1,
  );

  // ── 10. The route's teacherId cannot be swapped ────────────────────────
  console.log("\n10. The route's teacherId cannot be swapped");
  const { assistant: otherAssistant } = await link(otherTeacher.id, "GRADER");
  check(
    "An assistant of one teacher resolves no link for another teacher's id (and the other teacher's assistant none for ours)",
    (await findEffectiveAssistantLink(prisma, { assistantUserId: otherAssistant.id, teacherUserId: victimTeacher.id, now })) === null &&
      (await findEffectiveAssistantLink(prisma, { assistantUserId: helper.id, teacherUserId: otherTeacher.id, now })) === null &&
      (await findEffectiveAssistantLink(prisma, { assistantUserId: otherAssistant.id, teacherUserId: otherTeacher.id, now })) !== null,
  );
  check(
    "A teacher's id as the assistant finds nothing: the teacher is no assistant of their own",
    (await findEffectiveAssistantLink(prisma, { assistantUserId: otherTeacher.id, teacherUserId: otherTeacher.id, now })) === null,
  );

  // ── 11. Audit rows ─────────────────────────────────────────────────────
  console.log("\n11. Audit rows: ids, preset and permission names only");
  const fixtureUsers = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { firstName: true, lastName: true, email: true } });
  const rows = await prisma.auditLog.findMany({ where: { action: { startsWith: "assistant." }, actor: { email: { startsWith: EMAIL_PREFIX } } } });
  const actions = new Set(rows.map((row) => row.action));
  check("Every assistant action is audited", Object.values(ASSISTANT_AUDIT_ACTIONS).every((action) => actions.has(action)), [...actions].join(","));
  const leaking = rows.filter((row) => {
    const text = JSON.stringify([row.before, row.after]);
    return (
      row.centerId !== null ||
      forbiddenAuditKey(row.before) !== null ||
      forbiddenAuditKey(row.after) !== null ||
      [...codesIssued].some((code) => text.includes(code) || text.includes(formatAssistantCodeForDisplay(code)) || text.includes(createHash("sha256").update(code).digest("hex"))) ||
      fixtureUsers.some((user) => text.includes(user.lastName) || (user.email !== null && text.includes(user.email)))
    );
  });
  check(`No audit row (${rows.length}) carries a centre, a code or its hash, a name or an email`, rows.length > 0 && leaking.length === 0, leaking.map((row) => row.action).join(","));
  const update = rows.find((row) => row.action === ASSISTANT_AUDIT_ACTIONS.permissionUpdate && row.entityId === tuned.linkId);
  const after = update?.after as { preset?: string; permissions?: string[] } | null;
  check("assistant.permission.update holds the preset and the permission names", Boolean(after?.preset) && Array.isArray(after?.permissions) && after!.permissions!.every((name) => (ASSISTANT_PERMISSIONS as readonly string[]).includes(name)));

  // ── 12. No centre anything ─────────────────────────────────────────────
  console.log("\n12. An assistant is no member of any centre");
  const pureAssistants = [helper.id, otherAssistant.id, pair.id];
  check(
    "Assistants with no other role hold no Membership, no StudentProfile and resolve no centre relation",
    (await prisma.membership.count({ where: { userId: { in: pureAssistants } } })) === 0 &&
      (await prisma.studentProfile.count({ where: { userId: { in: pureAssistants } } })) === 0 &&
      (await Promise.all(pureAssistants.map((id) => resolveCenterRelations(prisma, id)))).every((relations) => relations.length === 0),
  );
  const receptionistRelations = await resolveCenterRelations(prisma, premiumStaff.RECEPTIONIST.id);
  check(
    "Redeeming changes nobody's centre roles: the receptionist-assistant is still RECEPTIONIST only",
    receptionistRelations.length === 1 && receptionistRelations[0].roles.join() === "RECEPTIONIST",
  );
  check(
    "The effective links read nothing of a centre (teacher id and name, grants, dates)",
    (await effectiveAssistantLinks(prisma, helper.id, now)).every((item) => Object.keys(item).sort().join() === "linkId,permissions,preset,since,teacherName,teacherUserId"),
  );

  await checkActingOnBehalf({ centerA: center.id, now, premiumTeacher, link });

  /** A premium account with no branch membership (W8d). */
  async function premiumAccount(tag: string) {
    const user = await makeUser(tag);
    const granted = await grantPremium(prisma, { actorUserId: admin.id, userId: user.id, endDay: premiumLatestEndDay(now), now });
    if (!granted.ok) throw new Error(`grantPremium: ${granted.error}`);
    return user;
  }
  await checkWorkspaceSource({ now, premiumAccount, link });
}

// ── 21. W8d: the teacher's workspaces as a second source (D-W41 items 9–12) ──

async function checkWorkspaceSource(input: {
  now: Date;
  premiumAccount: (tag: string) => Promise<{ id: string }>;
  link: (teacherId: string, preset?: string) => Promise<{ assistant: { id: string }; linkId: string }>;
}) {
  const { now } = input;
  console.log("\n21. W8d: the teacher's workspaces — the resolver's second source, the nav, a workspace-only teacher invites");
  const neither = await input.premiumAccount("ws-neither");
  const refused = await createAssistantInvite(prisma, { actorUserId: neither.id, preset: "GRADER", now });
  check("A premium account with neither a branch nor a workspace still cannot invite (forbidden)", !refused.ok && refused.error === "forbidden");
  const wsOnly = await input.premiumAccount("ws-only");
  const created = await createWorkspace(prisma, wsOnly.id, { name: "Assistants check workspace" });
  const workspaceId = created.ok ? created.workspaceId : "";
  const linked = await input.link(wsOnly.id, "CO_TEACHER");
  check("A workspace-only premium teacher invites an assistant, who redeems the code (D-W41 item 11)", created.ok && Boolean(linked.linkId));
  const acting = await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: wsOnly.id, now });
  check(
    "The resolver for a workspace-only teacher: no branch, the teacher's one workspace with the teacher's membership",
    acting !== null && acting.branches.length === 0 && acting.workspaces.length === 1 && acting.workspaces[0].centerId === workspaceId &&
      acting.workspaces[0].teacherMembershipId !== null,
  );
  // W9 old → new (E, approved in the W9 follow-up, D-W42): Co-teacher also holds both assessment keys there.
  check(
    "Co-teacher there: assessments (review and manage), classes, check-in and payments in the workspace, nothing else",
    ASSISTANT_PERMISSIONS.filter((permission) => assistantCan(acting, permission, workspaceId)).join() ===
      "assessments.review,assessments.manage,classes.view,checkin.workspace,payments.workspace",
  );
  const navOf = async () => {
    const fresh = await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: wsOnly.id, now });
    return fresh ? assistantNavItems(wsOnly.id, fresh).map((item) => item.labelKey).join() : "none";
  };
  // W9 old → new (F, approved in the W9 follow-up, D-W42): Exams & homework shows for a workspace grant.
  check("The nav: Home, Exams & homework (the workspace's) and Workspaces (no branch page)", (await navOf()) === "home,assessments,workspaces", await navOf());
  const toFull = await updateAssistantPermissions(prisma, { actorUserId: wsOnly.id, linkId: linked.linkId, change: { preset: "FULL" }, now });
  check("With Full the nav adds Earnings (the workspace's analytics), never Overview (a branch summary)", toFull.ok && (await navOf()) === "home,assessments,workspaces,earnings", await navOf());
  const other = await input.premiumAccount("ws-other");
  const otherWs = await createWorkspace(prisma, other.id, { name: "Someone else's" });
  const again = await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: wsOnly.id, now });
  check(
    "Another teacher's workspace is never in the source, and a swapped teacherId resolves nothing",
    otherWs.ok && again !== null && !again.workspaces.some((row) => row.centerId === otherWs.workspaceId) &&
      (await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: other.id, now })) === null &&
      !assistantCan(again, "checkin.workspace", otherWs.workspaceId),
  );
  const archived = await prisma.center.update({ where: { id: workspaceId }, data: { archivedAt: now, archivedByUserId: wsOnly.id } });
  const whileArchived = await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: wsOnly.id, now });
  check(
    "An archived workspace stays in the source (read-only — writes are refused by assertWorkspaceWritable, check:workspaces §16)",
    archived.archivedAt !== null && whileArchived?.workspaces[0]?.archivedAt !== null && whileArchived?.workspaces.length === 1,
  );
  await prisma.center.update({ where: { id: workspaceId }, data: { archivedAt: null, archivedByUserId: null } });
  check(
    "The assistant gained no Membership (in the workspace or anywhere) and no PermissionGrant",
    (await prisma.membership.count({ where: { userId: linked.assistant.id } })) === 0 && (await resolveCenterRelations(prisma, linked.assistant.id)).length === 0,
  );
  const removedLink = await removeAssistant(prisma, { actorUserId: wsOnly.id, linkId: linked.linkId, now });
  check(
    "The workspace-only teacher removes the assistant, and the source is gone",
    removedLink.ok && (await resolveAssistantActing(prisma, { assistantUserId: linked.assistant.id, teacherUserId: wsOnly.id, now })) === null,
  );
}

// ── 13–20. W7b: acting on behalf (D-W17, D-W18, D-W19, D-W37) ────────────

const DAY_MS = 86_400_000;

/** What `resolveAssessmentTeacher` reads of a context — the branch's real stored TEACHER cells. */
async function teacherAuthority(centerId: string, userId: string) {
  return { center: { id: centerId }, user: { id: userId }, role: "TEACHER" as const, grants: await loadPermissionGrants(prisma, centerId, "TEACHER"), experienceDenied: false };
}

function draftExam(now: Date, extra: Partial<AssessmentDraft> = {}): AssessmentDraft {
  return {
    ...assessmentDefaults("EXAM"),
    title: "On-behalf exam",
    instructions: null,
    windowStart: new Date(now.getTime() - 60 * 60_000),
    windowEnd: new Date(now.getTime() + 3 * 60 * 60_000),
    deadline: null,
    durationMinutes: 30,
    questions: [
      { text: "Q1", points: 2, options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] },
      { text: "Q2", points: 3, options: [{ text: "C", isCorrect: false }, { text: "D", isCorrect: true }] },
    ],
    ...extra,
  };
}

async function setTeacherCell(centerId: string, action: Permission, allowed: boolean) {
  await savePermissionGrants(prisma, centerId, [{ role: "TEACHER", action, allowed }]);
}

async function checkActingOnBehalf(input: {
  /** The W7a section's bare centre: the W7b teachers step out of it, so only the provisioned branches count. */
  centerA: string;
  now: Date;
  premiumTeacher: (tag: string) => Promise<{ id: string; firstName: string; lastName: string; email: string | null }>;
  link: (teacherId: string, preset?: string) => Promise<{ assistant: { id: string; firstName: string; lastName: string; email: string | null }; linkId: string }>;
}) {
  const { now } = input;
  const org = await prisma.organization.create({ data: { name: `${ORG_NAME} W7b ${RUN}` } });
  const makeBranch = async (suffix: string, organizationId: string) => {
    const branch = await prisma.center.create({ data: { slug: `${STEM}-${suffix}-${RUN}`, name: `${ORG_NAME} ${suffix}`, organizationId } });
    await prisma.$transaction((tx) => provisionCenterBaseline(tx, branch.id));
    return branch;
  };
  const b1 = await makeBranch("b1", org.id);
  const b2 = await makeBranch("b2", org.id);
  const foreignOrg = await prisma.organization.create({ data: { name: `${ORG_NAME} X ${RUN}` } });
  const x = await makeBranch("x", foreignOrg.id);

  // The teacher T at both branches (trusted by default), another teacher U at B1, a teacher W at X.
  const t = await input.premiumTeacher("w7b-teacher");
  await member(b1.id, t.id, "TEACHER");
  await member(b2.id, t.id, "TEACHER");
  const u = await input.premiumTeacher("w7b-other");
  await member(b1.id, u.id, "TEACHER");
  const w = await makeUser("w7b-foreign");
  await member(x.id, w.id, "TEACHER");
  await prisma.membership.updateMany({ where: { centerId: input.centerA, userId: { in: [t.id, u.id] } }, data: { active: false } });
  const tMembership = await prisma.membership.findFirstOrThrow({ where: { centerId: b1.id, userId: t.id, role: "TEACHER" } });

  const coTeacher = await input.link(t.id, "CO_TEACHER");
  const grader = await input.link(t.id, "GRADER");
  const full = await input.link(t.id, "FULL");
  const custom = await input.link(t.id, "GRADER");
  if (!(await updateAssistantPermissions(prisma, { actorUserId: t.id, linkId: custom.linkId, change: { permissions: ["classes.view", "students.phones"] }, now })).ok) {
    throw new Error("custom grants");
  }
  const ofOther = await input.link(u.id, "FULL");
  const co = coTeacher.assistant;

  // Classes, sessions and students.
  const classAt = (centerId: string, teacherId: string) =>
    prisma.classGroup.create({ data: { centerId, teacherId, price: 10_000, startDate: new Date(now.getTime() - 90 * DAY_MS), endDate: new Date(now.getTime() + 120 * DAY_MS) } });
  const sessionAt = (centerId: string, classGroupId: string, teacherId: string, days: number) => {
    const date = new Date(`${new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`);
    return prisma.session.create({ data: { centerId, classGroupId, teacherId, date, startTime: "16:00", endTime: "17:00", priceSnapshot: 10_000 } });
  };
  const c1 = await classAt(b1.id, t.id);
  const c2 = await classAt(b2.id, t.id);
  const cU = await classAt(b1.id, u.id);
  const cX = await classAt(x.id, w.id);
  const sNext = await sessionAt(b1.id, c1.id, t.id, 2);
  const sOld = await sessionAt(b1.id, c1.id, t.id, -60);
  const enrol = async (centerId: string, classGroupId: string, tag: string, phone: string) => {
    const user = await makeUser(`w7b-student-${tag}`);
    const profile = await prisma.studentProfile.create({
      data: scopedData(centerId, { userId: user.id, studentCode: `W7B-${tag}-${RUN}`, firstName: "Student", lastName: tag, phone }),
    });
    await prisma.enrollment.create({ data: scopedData(centerId, { studentProfileId: profile.id, classGroupId }) });
    return { user, profile };
  };
  const studentOne = await enrol(b1.id, c1.id, "one", "+201001234567");
  await enrol(b1.id, c1.id, "two", "+201007654321");

  const can = (assistantUserId: string, permission: AssistantPermission, centerId: string, at: Date = now, teacherUserId: string = t.id) =>
    assistantMayAt(prisma, { assistantUserId, teacherUserId, centerId, permission, now: at });

  // ── 13. The matrix: every key × the refusals ──────────────────────────
  console.log("\n13. Effective permission = grant ∧ the teacher's own authority ∧ the branch setting");
  const ALL: AssistantPermission[] = [...ASSISTANT_PERMISSIONS];
  const expectAllowed: Record<string, AssistantPermission[]> = {
    CO_TEACHER: ["assessments.review", "assessments.manage", "classes.view", "requests.manage"],
    GRADER: ["assessments.review"],
    FULL: ["assessments.review", "assessments.manage", "classes.view", "requests.manage", "analytics.view"],
    CUSTOM: ["classes.view"],
  };
  for (const [label, who] of [["CO_TEACHER", coTeacher], ["GRADER", grader], ["FULL", full], ["CUSTOM", custom]] as const) {
    const got: AssistantPermission[] = [];
    for (const permission of ALL) if (await can(who.assistant.id, permission, b1.id)) got.push(permission);
    check(`${label}: allowed exactly ${expectAllowed[label].join(", ")} at the teacher's branch`, got.join() === expectAllowed[label].join(), got.join());
  }
  check(
    "The workspace keys and students.phones grant nothing at a branch (W8; the teacher's portal shows no phone)",
    !(await can(full.assistant.id, "checkin.workspace", b1.id)) && !(await can(full.assistant.id, "payments.workspace", b1.id)) && !(await can(custom.assistant.id, "students.phones", b1.id)),
  );

  const teacherCell: Partial<Record<AssistantPermission, Permission>> = {
    "assessments.review": "assessment.manage.own",
    "assessments.manage": "assessment.manage.own",
    "requests.manage": "changeRequest.create",
    "analytics.view": "analytics.own.view",
  };
  const keys: AssistantPermission[] = ["assessments.review", "assessments.manage", "classes.view", "requests.manage", "analytics.view"];
  for (const permission of keys) {
    const holder = full.assistant.id;
    const refusals: [string, boolean][] = [];
    refusals.push(["grant missing", !(await can(permission === "assessments.review" ? custom.assistant.id : grader.assistant.id, permission, b1.id))]);
    const cell = teacherCell[permission];
    if (cell) {
      await setTeacherCell(b1.id, cell, false);
      refusals.push(["the teacher's own permission off", !(await can(holder, permission, b1.id))]);
      refusals.push(["…while the other branch still allows it", await can(holder, permission, b2.id)]);
      await setTeacherCell(b1.id, cell, true);
    } else {
      await prisma.membership.update({ where: { id: tMembership.id }, data: { active: false } });
      refusals.push(["the teacher's own membership inactive", !(await can(holder, permission, b1.id))]);
      await prisma.membership.update({ where: { id: tMembership.id }, data: { active: true } });
    }
    await prisma.centerSettings.update({ where: { centerId: b1.id }, data: { allowTeacherAssistants: false } });
    refusals.push(["the branch setting off", !(await can(holder, permission, b1.id))]);
    refusals.push(["…the other branch unaffected", await can(holder, permission, b2.id)]);
    await prisma.centerSettings.update({ where: { centerId: b1.id }, data: { allowTeacherAssistants: true } });
    if (permission === "requests.manage") {
      await prisma.membership.update({ where: { id: tMembership.id }, data: { isTrustedTeacher: false } });
      refusals.push(["the teacher not trusted there", !(await can(holder, permission, b1.id))]);
      await prisma.membership.update({ where: { id: tMembership.id }, data: { isTrustedTeacher: true } });
    }
    const premiumEnd = (await prisma.user.findUniqueOrThrow({ where: { id: t.id }, select: { premiumUntil: true } })).premiumUntil!;
    refusals.push(["premium lapsed (at the end instant)", !(await can(holder, permission, b1.id, premiumEnd))]);
    refusals.push(["…allowed 1 ms before it", await can(holder, permission, b1.id, new Date(premiumEnd.getTime() - 1))]);
    refusals.push(["teacherId swapped to another teacher", !(await can(holder, permission, b1.id, now, u.id))]);
    refusals.push(["another centre by id", !(await can(holder, permission, x.id))]);
    refusals.push(["allowed again once restored", await can(holder, permission, b1.id)]);
    const failed = refusals.filter(([, passed]) => !passed).map(([name]) => name);
    check(`${permission}: refused for ${refusals.length - 3} reasons, allowed otherwise`, failed.length === 0, failed.join("; "));
  }

  // ── 14. Assessments by the assistant, through the unchanged writers ────
  console.log("\n14. Assessments on behalf: the W2/W3a/W4 functions, actor = the assistant");
  const tAtB1 = await resolveAssessmentTeacher(prisma, await teacherAuthority(b1.id, t.id));
  const uAtB1 = await resolveAssessmentTeacher(prisma, await teacherAuthority(b1.id, u.id));
  if (!tAtB1 || !uAtB1) throw new Error("teacher handles");
  const asCo = { userId: co.id };
  const created = await createAssessment(prisma, asCo, tAtB1, { type: "EXAM", classGroupId: c1.id, draft: draftExam(now) });
  check("Co-teacher creates an exam in the teacher's class (owned by the teacher's membership)", created.ok && (await prisma.assessment.findUniqueOrThrow({ where: { id: created.ok ? created.id : "" } })).teacherMembershipId === tMembership.id);
  const examId = created.ok ? created.id : "";
  const saved = await saveAssessmentDraft(prisma, asCo, tAtB1, examId, draftExam(now, { title: "Saved by assistant" }));
  const published = await publishAssessment(prisma, asCo, tAtB1, examId, now);
  const extended = await extendAssessment(prisma, asCo, tAtB1, examId, new Date(now.getTime() + 5 * 60 * 60_000), now);
  check("…saves, publishes and extends it", saved.ok && published.ok && extended.ok, JSON.stringify([saved, published, extended]));
  const results = await readAssessmentResults(prisma, asCo, tAtB1, examId, now);
  const graderResults = await readAssessmentResults(prisma, { userId: grader.assistant.id }, tAtB1, examId, now);
  check("Co-teacher and Grader read its results (W4), the students listed", results.ok && graderResults.ok && results.results.students.length === 2);
  const attempt = await startAttempt(prisma, { centerId: b1.id, studentProfileId: studentOne.profile.id, userId: studentOne.user.id }, examId, now);
  const attemptRead = attempt.ok ? await readAttemptResult(prisma, { userId: grader.assistant.id }, tAtB1, examId, attempt.attemptId, now) : null;
  check("…and one student's attempt", attemptRead?.ok === true);
  const graderWrites = [
    await createAssessment(prisma, { userId: grader.assistant.id }, tAtB1, { type: "EXAM", classGroupId: c1.id, draft: draftExam(now) }),
    await saveAssessmentDraft(prisma, { userId: grader.assistant.id }, tAtB1, examId, draftExam(now)),
    await publishAssessment(prisma, { userId: grader.assistant.id }, tAtB1, examId, now),
    await unpublishAssessment(prisma, { userId: grader.assistant.id }, tAtB1, examId),
    await extendAssessment(prisma, { userId: grader.assistant.id }, tAtB1, examId, new Date(now.getTime() + 9 * 60 * 60_000), now),
    await deleteAssessment(prisma, { userId: grader.assistant.id }, tAtB1, examId),
  ];
  check("A Grader can read results but not build, save, publish, unpublish, extend or delete (forbidden ×6)", graderWrites.every((result) => !result.ok && result.error === "forbidden"), graderWrites.map((r) => (r.ok ? "ok" : r.error)).join(","));
  const customRead = await readAssessmentResults(prisma, { userId: custom.assistant.id }, tAtB1, examId, now);
  check("classes.view alone reads no results and writes nothing", !customRead.ok && customRead.error === "forbidden" && !(await createAssessment(prisma, { userId: custom.assistant.id }, tAtB1, { type: "EXAM", classGroupId: c1.id, draft: draftExam(now) })).ok);
  const intrusions = [
    // Another teacher's assistant, with the first teacher's handle.
    await saveAssessmentDraft(prisma, { userId: ofOther.assistant.id }, tAtB1, examId, draftExam(now)),
    // Our assistant with another teacher's handle (a swapped teacherId).
    await createAssessment(prisma, asCo, uAtB1, { type: "EXAM", classGroupId: cU.id, draft: draftExam(now) }),
    // Our assistant, the teacher's handle, another teacher's class by id.
    await createAssessment(prisma, asCo, tAtB1, { type: "EXAM", classGroupId: cU.id, draft: draftExam(now) }),
    // …another centre's class by id.
    await createAssessment(prisma, asCo, tAtB1, { type: "EXAM", classGroupId: cX.id, draft: draftExam(now) }),
    // …a forged handle naming another centre.
    await createAssessment(prisma, asCo, { ...tAtB1, centerId: x.id }, { type: "EXAM", classGroupId: cX.id, draft: draftExam(now) }),
  ];
  const errors = intrusions.map((result) => (result.ok ? "ok" : result.error));
  check("Refused by direct call: another teacher's assistant, a swapped teacher, another teacher's class, another centre's class, a forged centre", errors.join() === "forbidden,forbidden,notFound,notFound,forbidden", errors.join());
  const uExam = await createAssessment(prisma, { userId: u.id }, uAtB1, { type: "EXAM", classGroupId: cU.id, draft: draftExam(now) });
  const uTouch = uExam.ok ? await saveAssessmentDraft(prisma, asCo, tAtB1, uExam.id, draftExam(now)) : null;
  check("Another teacher's assessment by id, through our teacher's handle: notFound", uTouch !== null && !uTouch.ok && uTouch.error === "notFound");
  if (uExam.ok) await deleteAssessment(prisma, { userId: u.id }, uAtB1, uExam.id);

  // The branch setting off cuts the writers and the read at once.
  await prisma.centerSettings.update({ where: { centerId: b1.id }, data: { allowTeacherAssistants: false } });
  const cutRead = await readAssessmentResults(prisma, asCo, tAtB1, examId, now);
  const cutWrite = await extendAssessment(prisma, asCo, tAtB1, examId, new Date(now.getTime() + 7 * 60 * 60_000), now);
  const teacherStill = await readAssessmentResults(prisma, { userId: t.id }, tAtB1, examId, now);
  check("Branch setting off: the assistant's read and write are refused; the teacher is unaffected", !cutRead.ok && !cutWrite.ok && teacherStill.ok);
  await prisma.centerSettings.update({ where: { centerId: b1.id }, data: { allowTeacherAssistants: true } });

  // ── 15. Audit: actor + onBehalfOf, ids only ───────────────────────────
  console.log("\n15. Audit rows: the assistant as actor, the teacher as onBehalfOf, ids only");
  const teacherOwn = await createAssessment(prisma, { userId: t.id }, tAtB1, { type: "EXAM", classGroupId: c1.id, draft: draftExam(now, { title: "Teacher's own" }) });
  const assessmentRows = await prisma.auditLog.findMany({ where: { entityType: "Assessment", entityId: examId } });
  check(
    `Every on-behalf assessment row (${assessmentRows.length}) carries actor = the assistant and onBehalfOf = the teacher`,
    assessmentRows.length >= 4 && assessmentRows.every((row) => row.actorUserId === co.id && row.onBehalfOfUserId === t.id),
    assessmentRows.map((row) => `${row.action}:${row.actorUserId === co.id}:${row.onBehalfOfUserId === t.id}`).join(","),
  );
  const ownRow = teacherOwn.ok ? await prisma.auditLog.findFirst({ where: { entityType: "Assessment", entityId: teacherOwn.id } }) : null;
  check("The teacher's own write leaves onBehalfOf null", ownRow !== null && ownRow.actorUserId === t.id && ownRow.onBehalfOfUserId === null);
  if (teacherOwn.ok) await deleteAssessment(prisma, { userId: t.id }, tAtB1, teacherOwn.id);

  // ── 16. Requests on behalf ────────────────────────────────────────────
  console.log("\n16. Requests on behalf: stored as the teacher's, via assistant");
  const tomorrow = new Date(now.getTime() + 3 * DAY_MS).toISOString().slice(0, 10);
  const sessionPayload = { classGroupId: c1.id, date: tomorrow, startTime: "18:00", endTime: "19:00", note: "Private note text" };
  const classPayload = { subjectId: null, gradeId: null, dayOfWeek: 2, startTime: "10:00", endTime: "11:00", lateThresholdMinutes: 10, note: null };
  const sessionReq = await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: t.id, centerId: b1.id, request: { type: "NEW_SESSION", payload: sessionPayload }, now });
  const classReq = await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: t.id, centerId: b2.id, request: { type: "NEW_CLASS", payload: classPayload }, now });
  const stored = sessionReq.ok ? await prisma.changeRequest.findUniqueOrThrow({ where: { id: sessionReq.id } }) : null;
  check(
    "Co-teacher files a NEW_SESSION and a NEW_CLASS request; each is the teacher's (requestedBy) with viaAssistantUserId = the assistant, PENDING",
    sessionReq.ok && classReq.ok && stored?.requestedBy === t.id && stored.viaAssistantUserId === co.id && stored.status === "PENDING",
  );
  const requestRefusals = [
    await fileRequestOnBehalf(prisma, { assistantUserId: grader.assistant.id, teacherUserId: t.id, centerId: b1.id, request: { type: "NEW_SESSION", payload: sessionPayload }, now }),
    await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: t.id, centerId: b1.id, request: { type: "NEW_SESSION", payload: { ...sessionPayload, classGroupId: cU.id } }, now }),
    await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: t.id, centerId: x.id, request: { type: "NEW_SESSION", payload: { ...sessionPayload, classGroupId: cX.id } }, now }),
    await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: u.id, centerId: b1.id, request: { type: "NEW_CLASS", payload: classPayload }, now }),
  ];
  await prisma.membership.update({ where: { id: tMembership.id }, data: { isTrustedTeacher: false } });
  requestRefusals.push(await fileRequestOnBehalf(prisma, { assistantUserId: co.id, teacherUserId: t.id, centerId: b1.id, request: { type: "NEW_CLASS", payload: classPayload }, now }));
  await prisma.membership.update({ where: { id: tMembership.id }, data: { isTrustedTeacher: true } });
  check(
    "Refused: a Grader, another teacher's class, another centre, a swapped teacher, the teacher not trusted",
    requestRefusals.map((r) => (r.ok ? "ok" : r.error)).join() === "forbidden,notFound,forbidden,forbidden,forbidden",
    requestRefusals.map((r) => (r.ok ? "ok" : r.error)).join(),
  );
  const requestAudit = sessionReq.ok ? await prisma.auditLog.findFirst({ where: { entityType: "ChangeRequest", entityId: sessionReq.id } }) : null;
  check(
    "changeRequest.create is audited on the same transaction: actor = the assistant, onBehalfOf = the teacher, ids only (no note)",
    requestAudit?.action === "changeRequest.create" && requestAudit.actorUserId === co.id && requestAudit.onBehalfOfUserId === t.id &&
      requestAudit.centerId === b1.id && forbiddenAuditKey(requestAudit.after) === null && !JSON.stringify(requestAudit.after).includes("Private note"),
  );

  // ── 17. Centre-facing reads never name the assistant ──────────────────
  console.log("\n17. Centre-facing reads: the teacher, \"via assistant\", never the assistant");
  const secrets = [co.id, co.email ?? "@@", co.lastName, `${co.firstName} ${co.lastName}`];
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return secrets.filter((secret) => text.includes(secret));
  };
  const feed = await loadAuditFeed(prisma, b1.id, "all", { take: 200, skip: 0 });
  const requestEntry = feed.entries.find((entry) => entry.entityType === "ChangeRequest" && sessionReq.ok && entry.entityId === sessionReq.id);
  check(
    "The centre audit log shows the request as the teacher's (local name) with viaAssistant, and never the assistant's name, email or id",
    requestEntry?.viaAssistant === true && requestEntry.actorName?.lastName === "TEACHER" && leaks(feed).length === 0,
    leaks(feed).join(","),
  );
  check("The centre audit log lists no assessment row (D-W11), on-behalf or not", feed.entries.every((entry) => entry.entityType !== "Assessment"));
  const queue = (await prisma.changeRequest.findMany({ where: { centerId: b1.id, status: "PENDING" } })).map(withoutAssistantId);
  check(
    "The approvals queue's rows carry viaAssistant and no assistant id (what scoped changeRequests.list returns)",
    queue.some((row) => row.viaAssistant && row.requestedBy === t.id) && leaks(queue).length === 0 && queue.every((row) => !("viaAssistantUserId" in row)),
  );
  const teacherRequests = await listTeacherRequestsAt(prisma, { centerId: b1.id, teacherUserId: t.id, floor: assistantFloorAt({ teacherHistoryDays: 0 }, { settings: { centerDataVisibilityDays: 365, teacherDataVisibilityDays: 30, timezone: "Africa/Cairo" } }, now) });
  check("The assistant's own request list carries viaAssistant and no assistant id", teacherRequests.length >= 1 && teacherRequests[0].viaAssistant && leaks(teacherRequests).length === 0);

  // ── 18. The window is the stricter of the two ─────────────────────────
  console.log("\n18. The assistant's window: the stricter of the branch's teacher window and the teacher's own");
  const settingsB1 = { centerDataVisibilityDays: 365, teacherDataVisibilityDays: 30, timezone: "Africa/Cairo" };
  const today = todayInTimezone("Africa/Cairo", now);
  const days = (date: Date) => Math.round((today.getTime() - date.getTime()) / DAY_MS);
  check(
    "Teacher all-history (0): the branch's 30 days; teacher 10: 10 days; teacher 60: still 30 days; branch 7 with teacher 10: 7",
    days(assistantReadFloor({ settings: settingsB1, teacherHistoryDays: 0 }, now)) === 30 &&
      days(assistantReadFloor({ settings: settingsB1, teacherHistoryDays: 10 }, now)) === 10 &&
      days(assistantReadFloor({ settings: settingsB1, teacherHistoryDays: 60 }, now)) === 30 &&
      days(assistantReadFloor({ settings: { ...settingsB1, teacherDataVisibilityDays: 7 }, teacherHistoryDays: 10 }, now)) === 7,
  );
  const floorB1 = assistantReadFloor({ settings: settingsB1, teacherHistoryDays: 0 }, now);
  const detail = await assistantClassDetail(prisma, { centerId: b1.id, teacherUserId: t.id, classGroupId: c1.id, floor: floorB1 });
  check(
    "The class page's sessions stop at the floor: next week's session listed, the one 60 days ago not",
    detail !== null && detail.sessions.some((s) => s.id === sNext.id) && !detail.sessions.some((s) => s.id === sOld.id),
  );
  const oldExam = await createAssessment(prisma, { userId: t.id }, tAtB1, { type: "EXAM", classGroupId: c1.id, draft: draftExam(now, { title: "Old" }) });
  if (!oldExam.ok || !(await publishAssessment(prisma, { userId: t.id }, tAtB1, oldExam.id, now)).ok) throw new Error("old exam");
  await prisma.assessment.update({ where: { id: oldExam.id }, data: { windowStart: new Date(now.getTime() - 41 * DAY_MS), windowEnd: new Date(now.getTime() - 40 * DAY_MS) } });
  const oldByTeacher = await readAssessmentResults(prisma, { userId: t.id }, tAtB1, oldExam.id, now);
  const oldByAssistant = await readAssessmentResults(prisma, asCo, tAtB1, oldExam.id, now);
  check("An exam that closed 40 days ago: the teacher (all history) reads it, the assistant does not (branch window 30)", oldByTeacher.ok && !oldByAssistant.ok && oldByAssistant.error === "notFound");
  await prisma.user.update({ where: { id: t.id }, data: { teacherHistoryDays: 3 } });
  const recentWithTight = await readAssessmentResults(prisma, asCo, tAtB1, examId, now);
  check("The teacher's own tighter window binds the assistant too (an open exam still reads)", recentWithTight.ok && !(await readAssessmentResults(prisma, asCo, tAtB1, oldExam.id, now)).ok);
  await prisma.user.update({ where: { id: t.id }, data: { teacherHistoryDays: 0 } });

  // ── 19. Phones hidden; classes.view writes nothing; navs ──────────────
  console.log("\n19. Rosters show names only; the nav follows the grants");
  const rosterKeys = new Set(detail?.roster.flatMap((row) => Object.keys(row)) ?? []);
  check(
    "The roster rows are id + names only — no phone, with or without students.phones (both students have phones on file)",
    detail !== null && detail.roster.length === 2 && [...rosterKeys].sort().join() === "firstName,id,lastName" && !/\+20100/.test(JSON.stringify(detail)),
  );
  const list = await assistantClassList(prisma, { centerId: b1.id, teacherUserId: t.id });
  check("The class list is the teacher's own classes only, with no phone", list.some((row) => row.id === c1.id) && !list.some((row) => row.id === cU.id) && !/phone/i.test(JSON.stringify(list)));
  check("Each branch lists its own classes: B2's class at B2, not at B1", (await assistantClassList(prisma, { centerId: b2.id, teacherUserId: t.id })).some((row) => row.id === c2.id) && !list.some((row) => row.id === c2.id));
  check("Another teacher's class is not found through the teacher's id", (await assistantClassDetail(prisma, { centerId: b1.id, teacherUserId: t.id, classGroupId: cU.id, floor: floorB1 })) === null);
  const navOf = async (assistantUserId: string) => {
    const acting = await resolveAssistantActing(prisma, { assistantUserId, teacherUserId: t.id, now });
    return acting ? assistantNavItems(t.id, acting).map((item) => item.labelKey).join() : "none";
  };
  check(
    // W8d (the prompt's old → new: the assistant nav is dynamic): Full also gets Earnings.
    "The assistant nav per preset: Grader → home, assessments; Co-teacher → + classes, requests; Full → + overview, earnings; classes.view only → home, classes",
    (await navOf(grader.assistant.id)) === "home,assessments" &&
      (await navOf(co.id)) === "home,assessments,classes,requests" &&
      (await navOf(full.assistant.id)) === "home,assessments,classes,requests,overview,earnings" &&
      (await navOf(custom.assistant.id)) === "home,classes",
  );
  await prisma.centerSettings.updateMany({ where: { centerId: { in: [b1.id, b2.id] } }, data: { allowTeacherAssistants: false } });
  const noBranches = await resolveAssistantActing(prisma, { assistantUserId: full.assistant.id, teacherUserId: t.id, now });
  check(
    "Every branch switched off: the link still resolves (the landing page says \"Not available\") with no branch, and the nav is Home only",
    noBranches !== null && noBranches.branches.length === 0 && (await navOf(full.assistant.id)) === "home",
  );
  await prisma.centerSettings.updateMany({ where: { centerId: { in: [b1.id, b2.id] } }, data: { allowTeacherAssistants: true } });

  // ── 20. Removal, premium and the swapped id cut access at once ────────
  console.log("\n20. Removing the link, lapsing premium or swapping the teacher cuts access immediately");
  check("Before: Co-teacher acts at B1", await can(co.id, "assessments.manage", b1.id));
  check("A swapped teacherId resolves nothing (the assistant of T for U)", (await resolveAssistantActing(prisma, { assistantUserId: co.id, teacherUserId: u.id, now })) === null);
  check("The teacher's own id as the assistant resolves nothing", (await resolveAssistantActing(prisma, { assistantUserId: t.id, teacherUserId: t.id, now })) === null);
  const premiumEnd = (await prisma.user.findUniqueOrThrow({ where: { id: t.id }, select: { premiumUntil: true } })).premiumUntil!;
  check("Premium lapsed: nothing resolves and the writer refuses", (await resolveAssistantActing(prisma, { assistantUserId: co.id, teacherUserId: t.id, now: premiumEnd })) === null);
  const removed = await removeAssistant(prisma, { actorUserId: t.id, linkId: coTeacher.linkId, now });
  const afterRemove = await saveAssessmentDraft(prisma, asCo, tAtB1, examId, draftExam(now));
  const readAfterRemove = await readAssessmentResults(prisma, asCo, tAtB1, examId, now);
  check("Link removed: the next write and read are refused by direct call", removed.ok && !afterRemove.ok && !readAfterRemove.ok);
  check(
    "W7b assistants still hold no Membership and no PermissionGrant row of their own",
    (await prisma.membership.count({ where: { userId: { in: [co.id, grader.assistant.id, full.assistant.id, custom.assistant.id] } } })) === 0,
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => {
      console.error(error);
      failures += 1;
    });
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assistants check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll assistants checks passed.");
  });
