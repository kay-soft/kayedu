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
 * Writes throwaway rows under the `assistants-check` stem and cleans up.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
  await prisma.center.deleteMany({ where: { slug: SLUG } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: ORG_NAME }, centers: { none: {} } } });
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
  for (const name of ["createAssistantInvite", "revokeAssistantInvite", "updateAssistantPermissions", "removeAssistant"]) {
    const body = exportedBody("lib/db/assistants.ts", name);
    check(
      `${name}: locks the teacher's row, then the teacher + premium gate, inside its transaction`,
      /inTransaction\(db,/.test(body) && body.indexOf("lockTeacher(") > 0 && body.indexOf("lockTeacher(") < body.indexOf("teacherGate("),
    );
  }
  check("The teacher gate is a TEACHER membership plus requirePremium", /isTeacherAccount\(tx, actorUserId\)[\s\S]*requirePremium\(tx, actorUserId, now\)/.test(exportedBody("lib/db/assistants.ts", "isTeacherAccount") + writer));
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

  const assistantSurface = [
    ...walk(join(ROOT, "app", "[locale]", "(assistant)")),
    join(ROOT, "lib", "auth", "assistant-context.ts"),
  ];
  const tenantReaders = assistantSurface.filter((file) =>
    /getTenantContext|requireExperience|getTeacherScope|lib\/db\/scoped|scoped\(|ctxCan\(|from "@\/lib\/db\/(?!assistants|client)/.test(stripComments(readSource(file))),
  );
  check(
    "The assistant experience resolves no tenant context and reads no centre data module",
    assistantSurface.length >= 5 && tenantReaders.length === 0,
    tenantReaders.join(", "),
  );
  const serverActions = assistantSurface.filter((file) => /["']use server["']/.test(readSource(file)));
  check("Nothing under app/[locale]/(assistant)/ declares a Server Action (nothing to act on in W7a)", serverActions.length === 0, serverActions.join(", "));
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
    removeAssistant(prisma, { actorUserId: lapsing.id, linkId: helperLink, now: boundary }),
  ]);
  check("A lapsed teacher is refused every teacher action (premiumRequired)", lapsedWrites.every((result) => !result.ok && result.error === "premiumRequired"));
  const lapsedCode = await invite(lapsing.id, "GRADER", before);
  const toLapsed = await redeemAssistantCode(prisma, { userId: (await makeUser("late")).id, code: lapsedCode.code, ip: ip(), now: boundary });
  check("A code from a teacher who is not premium now is refused (teacherUnavailable), nothing claimed", !toLapsed.ok && toLapsed.error === "teacherUnavailable" && (await prisma.assistantInvite.findUniqueOrThrow({ where: { id: lapsedCode.inviteId } })).usedAt === null);
  const renewed = await extendPremium(prisma, { actorUserId: admin.id, userId: lapsing.id, endDay: premiumLatestEndDay(now), now });
  check("Renewal (W6's extend) restores the experience at the same instant, grants unchanged", renewed.ok && (await keys(boundary)).includes(assistantExperienceKey(lapsing.id)) &&
    (await findEffectiveAssistantLink(prisma, { assistantUserId: helper.id, teacherUserId: lapsing.id, now: boundary }))?.permissions.join() === PRESET_PERMISSIONS.FULL.join());
  const revokedPremium = await revokePremium(prisma, { actorUserId: admin.id, userId: lapsing.id, now });
  const listedAfterRevoke = (await loadExperiences(prisma, helper.id)).map((entry) => entry.key);
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
    ["a non-premium teacher", plainTeacher.id, "premiumRequired"],
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
    check(`${label}: create, revoke, change permissions and remove all refused (${expected})`, results.every((result) => !result.ok && result.error === expected), results.map((result) => (result.ok ? "ok" : result.error)).join(","));
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
