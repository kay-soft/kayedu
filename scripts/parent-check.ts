/**
 * Parent role & portal check — the M16 acceptance gate, rewritten for F3
 * (OD-6 decided: family links by one-time code; docs/03-build-order.md F3).
 *
 * Run with:  npm run check:parent
 *
 * `lib/auth/tenant.ts` is not imported here (it pulls in Next-runtime
 * modules). This exercises `lib/db/parents.ts` — the module the account
 * page, `/family/join`, the student page and the `/parent` portal all call —
 * directly, plus `lib/auth/permissions.ts`'s `can()` for the "no write path"
 * ceiling, plus static sweeps of the source.
 *
 * Old → new (the F3 prompt's allowed changes):
 *  - "a phone match writes a PENDING link"   → "a phone match writes nothing"
 *  - "a privileged phone is refused"          → "a platform admin is refused;
 *                                                staff/teacher accepted with a valid code"
 *  - "a parent-phone change revokes the link" → "only explicit, audited revocation ends a link"
 *  - "an unverified link grants zero reads"   → "a pending invitation grants zero reads"
 * The M16 OD-6 placeholder's own checks (wrong-centre verify, "verify refuses",
 * "already verified") went with the placeholder: there is no verify step.
 * Kept unchanged: never a superset of the child, no write path, cross-centre
 * denial, an inactive profile / a suspended centre hidden.
 *
 * Parts:
 *  1. Codes — alphabet and length, normalization, and **hash-only storage**
 *     (the row holds sha256 + a two-character hint; the database refuses a
 *     plaintext code).
 *  2. A phone match writes nothing, and nothing in sign-up or the student
 *     record paths touches a family link.
 *  3. Student invitations — a pending invitation grants zero reads; slots
 *     (3); a parent account cannot invite; New code / Cancel.
 *  4. Accepting — every refusal, staff/teacher accepted, the audit row.
 *  5. Single use under concurrency — two parallel accepts of one code (two
 *     database clients) make exactly one link.
 *  6. Branch codes — a student with no login; regenerate revokes the old;
 *     audited; another branch's student is notFound.
 *  7. Revocation — the student can't; branch (reason required, on the record,
 *     not in the audit row), parent and platform admin can; reads stop at
 *     once; relinking needs a new code.
 *  8. Never a superset of the child; cross-centre denial; inactive profile and
 *     suspended centre hidden.
 *  9. Rate limit — 10 attempts an hour per account and per IP.
 * 10. No write path — the PARENT ceiling and no "use server" under (parent).
 *
 * Needs a reachable database (writes throwaway rows and cleans up). Not for
 * the shared dev project as routine verification (CLAUDE.md rule 8).
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  FAMILY_CODE_ALPHABET,
  FAMILY_LIMITS,
  acceptFamilyCode,
  activeChildLinks,
  familyAccessForStudent,
  familyForAccount,
  generateFamilyCode,
  hashFamilyCode,
  isStudentAccount,
  issueBranchCode,
  issueStudentInvitation,
  normalizeFamilyCode,
  regenerateStudentInvitation,
  revokeBranchCode,
  revokeFamilyLink,
  revokeStudentInvitation,
} from "../lib/db/parents.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import { studentPastAttendance } from "../lib/db/student-portal.ts";
import { PERMISSIONS, permissionsFor, type PermissionGrants } from "../lib/auth/permissions.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SLUG_A = "parent-check-a";
const SLUG_B = "parent-check-b";
const EMAIL_PREFIX = "parent-check-";
const RUN = randomUUID().slice(0, 8);
const ipsUsed = new Set<string>();

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fresh client address per call, so one test's attempts never use up another's per-IP budget. */
function ip(): string {
  const value = `parent-check-${RUN}-${randomUUID()}`;
  ipsUsed.add(value);
  return value;
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  const centers = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { id: true } });
  const centerIds = centers.map((center) => center.id);
  if (userIds.length > 0 || centerIds.length > 0) {
    await deleteAuditRows(prisma, { OR: [{ actorUserId: { in: userIds } }, { centerId: { in: centerIds } }] });
  }
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: "Parent Check" }, centers: { none: {} } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.rateLimitBucket.deleteMany({
    where: { OR: [...userIds.map((id) => ({ key: { endsWith: id } })), { key: { contains: `parent-check-${RUN}` } }] },
  });
}

async function makeCenter(slug: string, name: string) {
  return prisma.center.create({ data: { slug, name, organization: { create: { name } } } });
}

let userSeq = 0;
async function makeUser(tag: string, extra: { isPlatformAdmin?: boolean; phone?: string; contactPhone?: string } = {}) {
  userSeq += 1;
  return prisma.user.create({
    data: { firstName: "U", lastName: tag, email: `${EMAIL_PREFIX}${tag}-${userSeq}@kayedu.test`, locale: "en", ...extra },
  });
}

async function makeStudent(centerId: string, tag: string, parentPhone: string | null = null) {
  const user = await makeUser(tag);
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: `PC-${tag}-${userSeq}`, firstName: "S", lastName: tag, parentPhone }),
  });
  return { user, profile };
}

async function makeStaff(centerId: string, tag: string, role: "OWNER" | "MANAGER" | "TEACHER") {
  const user = await makeUser(tag);
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role, firstName: "M", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

/** A student-issued code for `studentUserId`, asserting the issue worked. */
async function inviteCode(studentUserId: string): Promise<string> {
  const issued = await issueStudentInvitation(prisma, {
    studentUserId,
    declaredParentFirstName: "Declared",
    declaredParentLastName: "Parent",
    declaredParentPhone: "01055555555",
  });
  if (!issued.ok) throw new Error(`issueStudentInvitation: ${issued.error}`);
  return issued.code;
}

const accept = (acceptorUserId: string, code: unknown, client = prisma) =>
  acceptFamilyCode(client, { acceptorUserId, code, ip: ip() });

// ── Static sweeps ──────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function exportedBody(path: string, name: string): string {
  const source = read(path);
  const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

function staticChecks() {
  console.log("Static sweeps");
  const parentDir = join(ROOT, "app", "[locale]", "(parent)");
  const parentFiles = walk(parentDir);
  check("At least one file exists under app/[locale]/(parent)/ (the sweep is exercising something)", parentFiles.length > 0);
  const serverActionFiles = parentFiles.filter((file) => /["']use server["']/.test(readFileSync(file, "utf8")));
  check(
    "No file under app/[locale]/(parent)/ declares a Server Action (\"use server\") — no write path is reachable from this surface at all",
    serverActionFiles.length === 0,
    serverActionFiles.join(", "),
  );

  const signUp = stripComments(exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction"));
  check(
    "A phone match writes nothing: sign-up calls nothing in lib/db/parents and touches no family or parent-link table",
    !/originateParentLinks|issue\w*Invitation|acceptFamilyCode|familyLink|familyInvitation|parentLink/i.test(signUp),
  );
  check(
    "lib/db/parents.ts never reads a phone or contactPhone as a key (the declared phone is only normalized and stored)",
    !/where:\s*\{[^}]*\b(phone|parentPhone|parentAltPhone|contactPhone)\b/.test(stripComments(read("lib/db/parents.ts"))),
  );

  // ParentLink is deprecated: nothing in the app reads or writes it.
  const appFiles = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "components")), join(ROOT, "prisma", "seed.ts")];
  const parentLinkUsers = appFiles.filter((file) => /\.parentLink\b/.test(stripComments(readFileSync(file, "utf8"))));
  check("No app, lib, component or seed code reads or writes ParentLink (deprecated at F3)", parentLinkUsers.length === 0, parentLinkUsers.join(", "));

  const studentEdit = stripComments(exportedBody("app/[locale]/(center)/students/actions.ts", "updateStudentAction"));
  const completion = stripComments(exportedBody("app/[locale]/(student)/student/profile/actions.ts", "completeStudentProfileAction"));
  check(
    "Only explicit revocation ends a link: editing a student or completing a profile calls nothing that revokes",
    !/revoke|familyLink|parentLink/i.test(studentEdit) && !/revoke|familyLink|parentLink/i.test(completion),
  );

  const familyActions = stripComments(read("app/[locale]/account/family-actions.ts"));
  const linkRevokes = [...familyActions.matchAll(/revokeFamilyLink\(prisma,\s*\{\s*by:\s*"(\w+)"/g)].map((match) => match[1]);
  check(
    "The person's own actions revoke a link only as its parent (the student has no path)",
    linkRevokes.length === 1 && linkRevokes[0] === "parent",
    linkRevokes.join(","),
  );
  check("Every family action takes the actor from the session, never the form", !/formData\.get\(["'](userId|studentUserId|parentUserId|actorUserId)["']\)/.test(familyActions) && /getCurrentUser\(\)/.test(familyActions));
  const studentsActions = stripComments(read("app/[locale]/(center)/students/actions.ts"));
  check(
    "Branch code and revoke actions are gated on parent.link.manage",
    /ctxCan\(ctx, "parent\.link\.manage"\)/.test(studentsActions) && /parentAccessContext\(\)/.test(exportedBody("app/[locale]/(center)/students/actions.ts", "revokeParentLinkAction")),
  );
  const joinForm = read("components/family/join-family-form.tsx");
  check(
    "The join page reads the code from the URL fragment and never builds a ?code= query",
    /location\.hash/.test(joinForm) && !/[?&]code=/.test(stripComments(joinForm)) && !/[?&]code=/.test(read("app/[locale]/(auth)/family/join/page.tsx")),
  );
}

async function main() {
  await cleanup();
  staticChecks();

  console.log("\n1. Codes");
  const sample = Array.from({ length: 200 }, () => generateFamilyCode());
  check(
    "Codes are 8 symbols from the unambiguous alphabet (no 0 O 1 I L)",
    sample.every((code) => code.length === 8 && [...code].every((char) => FAMILY_CODE_ALPHABET.includes(char))) &&
      !/[0O1IL]/.test(FAMILY_CODE_ALPHABET),
  );
  check("200 codes are 200 different codes", new Set(sample).size === sample.length);
  check(
    "Typing is forgiving: lower case, the dash, spaces and Arabic digits normalize; a misreadable symbol does not",
    normalizeFamilyCode("abcd-2345") === "ABCD2345" &&
      normalizeFamilyCode(" AB CD 23 45 ") === "ABCD2345" &&
      normalizeFamilyCode("ABCD" + String.fromCodePoint(0x0662, 0x0663, 0x0664, 0x0665)) === "ABCD2345" &&
      normalizeFamilyCode("ABCD-0123") === null &&
      normalizeFamilyCode("ABC") === null,
  );

  const centerA = await makeCenter(SLUG_A, "Parent Check A");
  const centerB = await makeCenter(SLUG_B, "Parent Check B");

  const { user: kid, profile: kidProfile } = await makeStudent(centerA.id, "kid");
  const code = await inviteCode(kid.id);
  const invitation = await prisma.familyInvitation.findFirstOrThrow({ where: { studentUserId: kid.id, status: "PENDING" } });
  const rowText = JSON.stringify(invitation);
  check(
    "Hash-only storage: the row holds sha256(code) and its last two symbols, and the plaintext appears nowhere in it",
    invitation.codeHash === createHash("sha256").update(code).digest("hex") &&
      invitation.codeHint === code.slice(-2) &&
      !rowText.includes(code) &&
      !rowText.includes(code.slice(0, 4)),
  );
  let plaintextRefused = false;
  try {
    await prisma.familyInvitation.create({
      data: { studentUserId: kid.id, codeHash: "ABCDEFGH", codeHint: "GH", source: "STUDENT_INVITE", createdBy: kid.id },
    });
  } catch {
    plaintextRefused = true;
  }
  check("The database refuses a plaintext code (codeHash must be a sha256 — CHECK constraint)", plaintextRefused);
  check("The declared parent phone is normalized by lib/phone.ts", invitation.declaredParentPhone === "01055555555");

  console.log("\n2. A phone match writes nothing");
  // A number no seeded person holds (User.phone is unique).
  let PHONE = "";
  do PHONE = `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  while (await prisma.user.findUnique({ where: { phone: PHONE } }));
  const { user: phoneKid } = await makeStudent(centerA.id, "phonekid", PHONE);
  const phoneParent = await makeUser("phoneparent", { phone: PHONE, contactPhone: PHONE });
  check(
    "A person whose phone (global and self-declared) equals a student's parent phone has no link, no code and reads no child",
    (await prisma.familyLink.count({ where: { OR: [{ parentUserId: phoneParent.id }, { studentUserId: phoneKid.id }] } })) === 0 &&
      (await activeChildLinks(prisma, phoneParent.id)).length === 0,
  );

  console.log("\n3. Student invitations");
  const wouldBeParent = await makeUser("parent-pending");
  check(
    "A pending invitation grants zero reads (no link exists until a code is accepted)",
    (await activeChildLinks(prisma, wouldBeParent.id)).length === 0,
  );
  const { user: slotKid } = await makeStudent(centerA.id, "slotkid");
  const slotCodes = [await inviteCode(slotKid.id), await inviteCode(slotKid.id), await inviteCode(slotKid.id)];
  const fourth = await issueStudentInvitation(prisma, {
    studentUserId: slotKid.id,
    declaredParentFirstName: "D",
    declaredParentLastName: "P",
    declaredParentPhone: null,
  });
  check(`A student holds at most ${FAMILY_LIMITS.slotsPerStudent} slots — the 4th invitation is refused (slotsFull)`, slotCodes.length === 3 && !fourth.ok && fourth.error === "slotsFull");
  const slotPending = await prisma.familyInvitation.findMany({ where: { studentUserId: slotKid.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
  const cancelled = await revokeStudentInvitation(prisma, { studentUserId: slotKid.id, invitationId: slotPending[0].id });
  const otherCancels = await revokeStudentInvitation(prisma, { studentUserId: kid.id, invitationId: slotPending[1].id });
  check("The student cancels their own pending invitation; another student cannot", cancelled.ok && !otherCancels.ok);
  check("A cancelled invitation's code is invalid", (await accept(wouldBeParent.id, slotCodes[0])).ok === false);
  const regenerated = await regenerateStudentInvitation(prisma, { studentUserId: slotKid.id, invitationId: slotPending[1].id });
  check(
    "New code: the old code stops working and the slot count is unchanged",
    regenerated.ok &&
      (await prisma.familyInvitation.findUniqueOrThrow({ where: { id: slotPending[1].id } })).status === "REVOKED" &&
      (await prisma.familyInvitation.count({ where: { studentUserId: slotKid.id, status: "PENDING" } })) === 2,
  );
  const oldCodeAfterRegen = await accept(wouldBeParent.id, slotCodes[1]);
  check("The replaced code is refused as invalidCode", !oldCodeAfterRegen.ok && oldCodeAfterRegen.error === "invalidCode");

  console.log("\n4. Accepting a code");
  const garbage = await accept(wouldBeParent.id, "ZZZZ-ZZZZ");
  check("An unknown code is refused as invalidCode", !garbage.ok && garbage.error === "invalidCode");
  const own = await accept(kid.id, code);
  check("The student's own code is refused as ownCode", !own.ok && own.error === "ownCode");
  const { user: classmate } = await makeStudent(centerB.id, "classmate");
  const byClassmate = await accept(classmate.id, code);
  check("An account holding a StudentProfile is refused as studentAccount — the 'hand it to a classmate' case", !byClassmate.ok && byClassmate.error === "studentAccount");
  const byClassmateBadCode = await accept(classmate.id, "ZZZZ-ZZZZ");
  check("…and a student account gets the same answer for a bad code (no oracle for which codes are live)", !byClassmateBadCode.ok && byClassmateBadCode.error === "studentAccount");
  const noBranchStudent = await makeUser("invite-only-student");
  await inviteCode(noBranchStudent.id);
  const byNoBranchStudent = await accept(noBranchStudent.id, code);
  check(
    "A student with no branch yet, who has a pending invitation, is a student account too",
    (await isStudentAccount(prisma, noBranchStudent.id)) && !byNoBranchStudent.ok && byNoBranchStudent.error === "studentAccount",
  );
  const admin = await makeUser("admin", { isPlatformAdmin: true });
  const byAdmin = await accept(admin.id, code);
  check("A platform admin is refused (platformAdmin)", !byAdmin.ok && byAdmin.error === "platformAdmin");

  const teacherParent = await makeStaff(centerA.id, "teacher-parent", "TEACHER");
  const byTeacher = await accept(teacherParent.id, code);
  check("A teacher at the child's own branch is accepted with a valid code (supersedes the M16 privileged-phone rule)", byTeacher.ok);
  const createdAudit = byTeacher.ok
    ? await prisma.auditLog.findFirst({ where: { action: "family.link.create", entityId: byTeacher.linkId } })
    : null;
  check(
    "The link is audited family.link.create with ids only (D-20)",
    createdAudit !== null && forbiddenAuditKey(createdAudit.after) === null && createdAudit.centerId === null,
  );
  const used = await accept(wouldBeParent.id, code);
  check("A used code is refused as invalidCode", !used.ok && used.error === "invalidCode");
  check(
    "The invitation is ACCEPTED, by the acceptor",
    (await prisma.familyInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedBy === teacherParent.id,
  );
  const again = await accept(teacherParent.id, await inviteCode(kid.id));
  check("Accepting a second code for the same child is refused as alreadyLinked (and that code stays PENDING)", !again.ok && again.error === "alreadyLinked");

  const managerParent = await makeStaff(centerB.id, "manager-parent", "MANAGER");
  const { user: managersChild } = await makeStudent(centerA.id, "managers-child");
  const byManager = await accept(managerParent.id, await inviteCode(managersChild.id));
  check("A manager (at another branch) is accepted as a parent with a valid code", byManager.ok);

  // Limits — fixtures for the existing links, so the rate limit never interferes.
  const { user: fullKid } = await makeStudent(centerA.id, "fullkid");
  for (let index = 0; index < FAMILY_LIMITS.parentsPerStudent; index += 1) {
    const parent = await makeUser(`fullkid-parent-${index}`);
    await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: fullKid.id, source: "LEGACY_VERIFIED" } });
  }
  const pendingForFull = await prisma.familyInvitation.create({
    data: { studentUserId: fullKid.id, codeHash: hashFamilyCode("PARENTQQ"), codeHint: "QQ", source: "STUDENT_INVITE", createdBy: fullKid.id },
  });
  const fourthParent = await accept((await makeUser("fourth-parent")).id, "PARENTQQ");
  check(`A child with ${FAMILY_LIMITS.parentsPerStudent} active parents refuses a 4th (parentLimit); the code stays PENDING`, !fourthParent.ok && fourthParent.error === "parentLimit" && (await prisma.familyInvitation.findUniqueOrThrow({ where: { id: pendingForFull.id } })).status === "PENDING");

  const busyParent = await makeUser("busy-parent");
  for (let index = 0; index < FAMILY_LIMITS.childrenPerParent; index += 1) {
    const child = await makeUser(`busy-child-${index}`);
    await prisma.familyLink.create({ data: { parentUserId: busyParent.id, studentUserId: child.id, source: "LEGACY_VERIFIED" } });
  }
  const { user: eleventh } = await makeStudent(centerA.id, "eleventh");
  const tooMany = await accept(busyParent.id, await inviteCode(eleventh.id));
  check(`A parent with ${FAMILY_LIMITS.childrenPerParent} children refuses an 11th (childLimit)`, !tooMany.ok && tooMany.error === "childLimit");

  console.log("\n5. Single use under concurrency");
  const deskA = await gatePrisma({ sweepUsers: false });
  const deskB = await gatePrisma({ sweepUsers: false });
  try {
    const { user: raceKid } = await makeStudent(centerA.id, "racekid");
    const raceCode = await inviteCode(raceKid.id);
    const [p1, p2] = [await makeUser("race-parent-1"), await makeUser("race-parent-2")];
    const results = await Promise.all([accept(p1.id, raceCode, deskA), accept(p2.id, raceCode, deskB)]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    check(
      "Two parallel accepts of one code (two clients): exactly one wins, the other is invalidCode",
      winners.length === 1 && losers.length === 1 && !losers[0].ok && losers[0].error === "invalidCode",
      JSON.stringify(results),
    );
    check("…and exactly one link exists for that child", (await prisma.familyLink.count({ where: { studentUserId: raceKid.id } })) === 1);

    const { user: raceKid2 } = await makeStudent(centerA.id, "racekid2");
    const sameParent = await makeUser("race-same-parent");
    const [codeX, codeY] = [await inviteCode(raceKid2.id), await inviteCode(raceKid2.id)];
    await Promise.all([accept(sameParent.id, codeX, deskA), accept(sameParent.id, codeY, deskB)]);
    check(
      "One parent racing two codes for one child gets one link (the other code stays unused)",
      (await prisma.familyLink.count({ where: { studentUserId: raceKid2.id, parentUserId: sameParent.id } })) === 1 &&
        (await prisma.familyInvitation.count({ where: { studentUserId: raceKid2.id, status: "PENDING" } })) === 1,
    );
  } finally {
    await Promise.all([deskA.$disconnect(), deskB.$disconnect()]);
  }

  console.log("\n6. Branch codes");
  const manager = await makeStaff(centerA.id, "manager", "MANAGER");
  const { user: noLogin, profile: noLoginProfile } = await makeStudent(centerA.id, "nologin");
  check("The staff-created student has no login (authId null)", noLogin.authId === null);
  const branchIssued = await issueBranchCode(prisma, { centerId: centerA.id, studentProfileId: noLoginProfile.id, actorUserId: manager.id });
  const issueAudit = branchIssued.ok
    ? await prisma.auditLog.findFirst({ where: { action: "family.code.issue", entityId: branchIssued.invitationId } })
    : null;
  check("A branch code is issued for a student with no account, audited family.code.issue (ids only, this branch)", branchIssued.ok && issueAudit?.centerId === centerA.id && forbiddenAuditKey(issueAudit.after) === null);
  const replacement = await issueBranchCode(prisma, { centerId: centerA.id, studentProfileId: noLoginProfile.id, actorUserId: manager.id });
  check(
    "Regenerating revokes the previous branch code: one PENDING code per (student, branch)",
    replacement.ok &&
      (await prisma.familyInvitation.count({ where: { studentUserId: noLogin.id, issuingCenterId: centerA.id, status: "PENDING" } })) === 1,
  );
  const oldBranch = branchIssued.ok ? await accept(wouldBeParent.id, branchIssued.code) : null;
  check("The replaced branch code is invalidCode", oldBranch !== null && !oldBranch.ok && oldBranch.error === "invalidCode");
  let secondPendingRefused = false;
  try {
    await prisma.familyInvitation.create({
      data: { studentUserId: noLogin.id, codeHash: hashFamilyCode("BRANCHQQ"), codeHint: "QQ", source: "CENTER_CODE", createdBy: manager.id, issuingCenterId: centerA.id },
    });
  } catch {
    secondPendingRefused = true;
  }
  check("The database refuses a second PENDING code from one branch for one student (partial unique index)", secondPendingRefused);
  const crossBranch = await issueBranchCode(prisma, { centerId: centerB.id, studentProfileId: noLoginProfile.id, actorUserId: manager.id });
  check("Another branch naming this student's profile id gets notFound (cross-centre denial)", !crossBranch.ok && crossBranch.error === "notFound");
  check("Another branch reads nothing of this student's parent access", (await familyAccessForStudent(prisma, centerB.id, noLoginProfile.id)) === null);

  const branchParent = await makeUser("branch-parent");
  const branchAccept = replacement.ok ? await accept(branchParent.id, replacement.code) : null;
  const branchReads = await activeChildLinks(prisma, branchParent.id);
  check(
    "The parent links with the printed code; the child's branch appears in the parent's reads",
    branchAccept?.ok === true && branchReads.length === 1 && branchReads[0].studentUser.studentProfiles.some((profile) => profile.id === noLoginProfile.id),
  );
  const access = await familyAccessForStudent(prisma, centerA.id, noLoginProfile.id);
  check("Staff see the link as \"this branch's code\", by account name, with no parent email or phone", access?.links.length === 1 && access.links[0].origin === "thisBranch" && !("email" in access.links[0]) && !("phone" in access.links[0]));
  const kidAccess = await familyAccessForStudent(prisma, centerA.id, kidProfile.id);
  check("A student invitation shows as the child's invitation, with the declared parent name beside it", kidAccess?.links.some((link) => link.origin === "childInvite" && link.declaredParentName === "Declared Parent") === true);
  const { profile: cancelProfile } = await makeStudent(centerA.id, "cancelcode");
  await issueBranchCode(prisma, { centerId: centerA.id, studentProfileId: cancelProfile.id, actorUserId: manager.id });
  const cancelCode = await revokeBranchCode(prisma, { centerId: centerA.id, studentProfileId: cancelProfile.id, actorUserId: manager.id });
  check("Cancel code: the branch's waiting code is revoked and audited family.code.revoke", cancelCode.ok && (await prisma.auditLog.count({ where: { action: "family.code.revoke", centerId: centerA.id } })) >= 1);

  console.log("\n7. Revocation");
  const teacherLink = await prisma.familyLink.findFirstOrThrow({ where: { parentUserId: teacherParent.id, studentUserId: kid.id } });
  const byStudent = await revokeFamilyLink(prisma, { by: "parent", linkId: teacherLink.id, actorUserId: kid.id });
  check("The student cannot revoke an active parent (no student path; the parent path is keyed on the link's own parent)", !byStudent.ok && byStudent.error === "notFound");
  const noReason = await revokeFamilyLink(prisma, { by: "branch", linkId: teacherLink.id, actorUserId: manager.id, centerId: centerA.id, studentUserId: kid.id, reason: "  " });
  check("A branch revocation without a reason is refused (reasonRequired)", !noReason.ok && noReason.error === "reasonRequired");
  const wrongBranch = await revokeFamilyLink(prisma, { by: "branch", linkId: teacherLink.id, actorUserId: managerParent.id, centerId: centerB.id, studentUserId: kid.id, reason: "x" });
  check("A branch where the child has no profile cannot revoke the link (notFound)", !wrongBranch.ok && wrongBranch.error === "notFound");
  const notAdmin = await revokeFamilyLink(prisma, { by: "admin", linkId: teacherLink.id, actorUserId: manager.id });
  check("The admin path refuses a non-admin (forbidden)", !notAdmin.ok && notAdmin.error === "forbidden");
  check("Before revocation the parent reads the child", (await activeChildLinks(prisma, teacherParent.id)).length === 1);
  const byBranch = await revokeFamilyLink(prisma, { by: "branch", linkId: teacherLink.id, actorUserId: manager.id, centerId: centerA.id, studentUserId: kid.id, reason: "Not the parent" });
  const revokedRow = await prisma.familyLink.findUniqueOrThrow({ where: { id: teacherLink.id } });
  const revokeAudit = await prisma.auditLog.findFirst({ where: { action: "family.link.revoke", entityId: teacherLink.id } });
  check(
    "Branch staff revoke with a reason: REVOKED, the reason on the link, the audit row ids only and at this branch",
    byBranch.ok && revokedRow.status === "REVOKED" && revokedRow.revokedReason === "Not the parent" && revokedRow.revokedBy === manager.id &&
      revokeAudit?.centerId === centerA.id && forbiddenAuditKey(revokeAudit.after) === null && !JSON.stringify(revokeAudit).includes("Not the parent"),
  );
  check("Reads stop immediately after revocation", (await activeChildLinks(prisma, teacherParent.id)).length === 0);
  check("Revocation is final for its code: the old code is not reusable", (await accept(teacherParent.id, code)).ok === false);
  const relink = await accept(teacherParent.id, await inviteCode(kid.id));
  check(
    "Relinking needs a new code — and re-activates the same row (unique pair)",
    relink.ok && relink.linkId === teacherLink.id && (await prisma.familyLink.count({ where: { parentUserId: teacherParent.id, studentUserId: kid.id } })) === 1,
  );
  const unlink = await revokeFamilyLink(prisma, { by: "parent", linkId: teacherLink.id, actorUserId: teacherParent.id });
  check("The parent unlinks themself; reads stop", unlink.ok && (await activeChildLinks(prisma, teacherParent.id)).length === 0);
  const branchParentLink = await prisma.familyLink.findFirstOrThrow({ where: { parentUserId: branchParent.id } });
  const byAdminRevoke = await revokeFamilyLink(prisma, { by: "admin", linkId: branchParentLink.id, actorUserId: admin.id });
  check("A platform admin revokes; reads stop", byAdminRevoke.ok && (await activeChildLinks(prisma, branchParent.id)).length === 0);
  const { user: phoneChild, profile: phoneChildProfile } = await makeStudent(centerA.id, "phone-change", "01088888888");
  const phoneChildParent = await makeUser("phone-change-parent");
  const phoneChildLink = await accept(phoneChildParent.id, await inviteCode(phoneChild.id));
  await prisma.studentProfile.update({ where: { id: phoneChildProfile.id }, data: { parentPhone: "01077777777", parentAltPhone: null } });
  check(
    "Only explicit, audited revocation ends a link: a parent-phone change on the record leaves the link ACTIVE and readable",
    phoneChildLink.ok &&
      (await prisma.familyLink.findUniqueOrThrow({ where: { id: phoneChildLink.linkId } })).status === "ACTIVE" &&
      (await activeChildLinks(prisma, phoneChildParent.id)).length === 1,
  );

  console.log("\n8. Never a superset; cross-centre; inactive and suspended hidden");
  const reader = await makeUser("reader-parent");
  const { user: childX, profile: childXProfile } = await makeStudent(centerA.id, "childX");
  const { profile: childY } = await makeStudent(centerA.id, "childY");
  const childXAtB = await prisma.studentProfile.create({
    data: scopedData(centerB.id, { userId: childX.id, studentCode: `PC-childX-B-${RUN}`, firstName: "S", lastName: "childX" }),
  });
  const readerLink = await accept(reader.id, await inviteCode(childX.id));
  check("The reader links childX", readerLink.ok);
  const teacher = await makeStaff(centerA.id, "teacher", "TEACHER");
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), teacherId: teacher.id, price: 10_000 }),
  });
  const session = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: classGroup.id,
      teacherId: teacher.id,
      date: new Date(Date.now() - 24 * 60 * 60 * 1000),
      startTime: "10:00",
      endTime: "11:00",
      status: "COMPLETED",
      priceSnapshot: 10_000,
    }),
  });
  for (const studentProfileId of [childXProfile.id, childY.id]) {
    await prisma.sessionAttendee.create({
      data: scopedData(centerA.id, { sessionId: session.id, studentProfileId, attendanceStatus: "PRESENT", recordedBy: teacher.id }),
    });
  }
  const readable = (await activeChildLinks(prisma, reader.id)).flatMap((link) => link.studentUser.studentProfiles);
  check(
    "The parent's readable profiles are exactly the child's own, at each branch (A and B)",
    readable.length === 2 && readable.every((profile) => profile.userId === childX.id) && readable.some((profile) => profile.id === childXAtB.id),
  );
  const history = await studentPastAttendance(prisma, centerA.id, childXProfile.id, new Date());
  check(
    "Never a superset: the read through childX's profile holds only childX's attendance, never childY's",
    history.length === 1 && history.every((row) => row.studentProfileId === childXProfile.id),
  );
  check("childY's own row exists (the read is genuinely narrowed)", (await studentPastAttendance(prisma, centerA.id, childY.id, new Date())).length === 1);
  await prisma.studentProfile.update({ where: { id: childXAtB.id }, data: { active: false } });
  const afterInactive = (await activeChildLinks(prisma, reader.id)).flatMap((link) => link.studentUser.studentProfiles);
  check("A deactivated profile disappears from the parent's reads (D-10)", afterInactive.length === 1 && afterInactive[0].id === childXProfile.id);
  await prisma.center.update({ where: { id: centerA.id }, data: { lifecycleState: "SUSPENDED" } });
  const afterSuspend = (await activeChildLinks(prisma, reader.id)).flatMap((link) => link.studentUser.studentProfiles);
  check("A suspended branch disappears from the parent's reads (D-10); the link itself stays", afterSuspend.length === 0 && (await activeChildLinks(prisma, reader.id)).length === 1);
  await prisma.center.update({ where: { id: centerA.id }, data: { lifecycleState: "ACTIVE" } });

  const family = await familyForAccount(prisma, reader.id);
  const kidFamily = await familyForAccount(prisma, childX.id);
  const adminFamily = await familyForAccount(prisma, admin.id);
  check(
    "Account → Family: the parent gets the parent view, the student the student view, a platform admin neither",
    family.showParentView && !family.showStudentView && kidFamily.showStudentView && !kidFamily.showParentView && kidFamily.parents.length === 1 &&
      !adminFamily.showParentView && !adminFamily.showStudentView,
  );
  const parentInvites = await issueStudentInvitation(prisma, { studentUserId: reader.id, declaredParentFirstName: "A", declaredParentLastName: "B", declaredParentPhone: null });
  check("A parent account cannot invite parents of its own (notAStudent)", !parentInvites.ok && parentInvites.error === "notAStudent");

  console.log("\n9. Rate limit");
  const awayFromEdge = async () => {
    const hour = 60 * 60_000;
    const into = Date.now() % hour;
    if (into > hour - 30_000) await new Promise((resolve) => setTimeout(resolve, hour - into + 500));
  };
  await awayFromEdge();
  const guesser = await makeUser("guesser");
  const fixedIp = ip();
  const perUser: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const result = await acceptFamilyCode(prisma, { acceptorUserId: guesser.id, code: "ZZZZ-ZZZZ", ip: index === 0 ? fixedIp : ip() });
    perUser.push(result.ok ? "ok" : result.error);
  }
  check("Per account: 10 attempts an hour are answered, the 11th is rateLimited", perUser.slice(0, 10).every((error) => error === "invalidCode") && perUser[10] === "rateLimited", perUser.join(","));
  const sharedIp = ip();
  const perIp: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const someone = await makeUser(`ip-guesser-${index}`);
    const result = await acceptFamilyCode(prisma, { acceptorUserId: someone.id, code: "ZZZZ-ZZZZ", ip: sharedIp });
    perIp.push(result.ok ? "ok" : result.error);
  }
  check("Per IP: 10 attempts an hour are answered, the 11th is rateLimited", perIp.slice(0, 10).every((error) => error === "invalidCode") && perIp[10] === "rateLimited", perIp.join(","));

  console.log("\n10. No write path");
  const allGrantsOpen: PermissionGrants = Object.fromEntries(PERMISSIONS.map((permission) => [permission, true])) as PermissionGrants;
  check(
    "PARENT holds zero permissions even against a hypothetical, maximally-open grants map — the ceiling in can() denies unconditionally",
    permissionsFor("PARENT", allGrantsOpen).length === 0,
    JSON.stringify(permissionsFor("PARENT", allGrantsOpen)),
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} parent check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll parent checks passed.");
  });
