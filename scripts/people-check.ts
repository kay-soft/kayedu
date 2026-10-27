/**
 * People check — the M3 acceptance gate, revised for center-local contacts
 * and system-assigned student codes:
 * "a student can be registered once and connected to the center; a printable
 *  QR ID card generates; a teacher can block-list a student; a duplicate
 *  phone/email — global OR another center's local record — triggers the
 *  match workflow instead of a duplicate person; each center keeps its own
 *  contact record, editable independently; student codes are claimed
 *  race-free with no duplicates and no gaps."
 *
 * Run with:  npm run check:people
 *
 * `check:isolation` proves the scoping primitives; `check:config` proves the
 * configuration surface. This one covers the paths M3 added — teachers,
 * students, blocks, identity matching and Storage — using the same
 * predicates, schemas and renderers the Server Actions use, so a cross-center
 * leak on a *new* path is caught rather than assumed.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { type BlockScope, type Role } from "@prisma/client";
import {
  MissingCenterScopeError,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import { fullName, localName } from "../lib/identity.ts";
import {
  createPerson,
  describeMatch,
  isLinkableMatch,
  resolveContact,
  seedLocalName,
  type LookupContext,
} from "../lib/db/identity.ts";
import { normalizePhone } from "../lib/phone.ts";
import { checkRateLimit } from "../lib/rate-limit.ts";
import { claimStudentCode } from "../lib/db/students.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { confirmGradePromotion, promotionPreview, undoGradePromotion } from "../lib/db/promotion.ts";
import { PROMOTION_UNDO_DAYS, isWithinUndoWindow } from "../lib/promotion.ts";
import {
  StoragePathError,
  assertPathInCenter,
  centerObjectPath,
  isPathInCenter,
  photoExtensionFor,
  studentIdCardPath,
  studentPhotoPath,
} from "../lib/storage-paths.ts";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  parseStudentQrPayload,
  renderIdCardSvg,
  resolveCardLayout,
  studentQrPayload,
} from "../lib/id-card.ts";
import {
  blockCreateSchema,
  gradePromotionSchema,
  studentCreateSchema,
  teacherCreateSchema,
} from "../lib/validation/people.ts";

const prisma = await gatePrisma();

// Typed so a spread into a Prisma `where` keeps the enum, not `string`.
const TEACHER_ROLE: Role = "TEACHER";
const TEACHER_SCOPE: BlockScope = "TEACHER";

const SLUG_A = "people-check-a";
const SLUG_B = "people-check-b";
const SLUG_C = "people-check-c";
const SHARED_EMAIL = "people-check-shared@kayedu.test";
const SHARED_PHONE = "01012345678";
const TEACHER_EMAIL = "people-check-teacher@kayedu.test";
const LOCAL_ONLY_EMAIL = "people-check-local-only@kayedu.test";
const LOCAL_EMAIL = "people-check-local@kayedu.test";
const RACE_EMAIL_PREFIX = "people-check-race";
const CONTACT_PHONE_EMAIL = "people-check-contact-phone@kayedu.test";
const CONTACT_PHONE = "01544443322";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * M18's single-normalizer assertion: `lib/phone.ts` is the ONLY file allowed
 * to define phone-normalization logic anywhere in the tree. This is an
 * import-graph/grep-level check (CLAUDE.md rule 10), not a behavioral one —
 * a second regex that happens to produce the same output today would still
 * be a second answer to "is this the same person" the moment one of the two
 * drifts, and a behavioral test alone would never catch that.
 */
function checkSingleNormalizer(): void {
  const root = join(process.cwd());
  const scanDirs = ["lib", "app", "components", "scripts", "prisma"];
  const skipDirs = new Set(["node_modules", ".next", ".git"]);
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (skipDirs.has(entry)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  }

  for (const dir of scanDirs) {
    const full = join(root, dir);
    if (existsSync(full)) walk(full);
  }

  const phoneTs = join(root, "lib", "phone.ts");
  // This gate script itself quotes these very patterns as string literals
  // (to define them) — exclude it from the scan, or it would flag itself.
  const selfPath = join(root, "scripts", "people-check.ts");
  const normalizerDefinitionPattern = /function\s+normalizePhone\s*\(/;
  // The shape of an inline reimplementation even without that exact name —
  // stripping to digits then hand-rolling an Egyptian-mobile prefix check.
  const inlineReimplementationPattern = /01\[0125\]|replace\(\/\[\^\\d\]/;

  const offenders: string[] = [];
  for (const file of files) {
    if (file === phoneTs || file === selfPath) continue;
    const contents = readFileSync(file, "utf8");
    if (normalizerDefinitionPattern.test(contents)) {
      offenders.push(`${relative(root, file)} (defines normalizePhone)`);
    }
    if (inlineReimplementationPattern.test(contents)) {
      offenders.push(`${relative(root, file)} (inline phone regex)`);
    }
  }

  check(
    "lib/phone.ts is the only file that defines phone-normalization logic",
    offenders.length === 0,
    offenders.join(", "),
  );

  // Every other file that imports `normalizePhone` must import it from
  // lib/phone.ts (directly or via a relative path resolving there) — never
  // from a second module that merely re-exports a redefinition.
  const importPattern = /normalizePhone.*from\s+["']([^"']+)["']/;
  const badImports: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    const match = contents.match(importPattern);
    if (!match) continue;
    const specifier = match[1];
    const resolvesToPhoneTs =
      specifier.endsWith("/phone") ||
      specifier.endsWith("/phone.ts") ||
      specifier === "./phone" ||
      specifier === "./phone.ts" ||
      specifier === "../phone" ||
      specifier === "../phone.ts";
    if (!resolvesToPhoneTs) {
      badImports.push(`${relative(root, file)} imports normalizePhone from "${specifier}"`);
    }
  }

  check(
    "Every normalizePhone import resolves to lib/phone.ts",
    badImports.length === 0,
    badImports.join(", "),
  );
}

/** The body of `export async function <name>(` up to the next top-level export (as in check:security). */
function exportedBody(path: string, name: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

/**
 * M18's receptionist-phone-lookup shape assertion (spec §5.1): "reuses M3's
 * duplicate-match panel — not a raw phone-to-record endpoint... minimum
 * fields returned... rate-limited." Two static/grep checks plus one
 * behavioral one against the real rate limiter — no database needed for any
 * of them.
 */
async function checkPhoneLookupShape(): Promise<void> {
  const root = join(process.cwd());
  const files = [
    join(root, "app", "[locale]", "(center)", "students", "actions.ts"),
    join(root, "app", "[locale]", "(center)", "teachers", "actions.ts"),
  ];

  for (const file of files) {
    // G2 (OD-14): the whole action, not a fixed 800-character window — the call
    // sat at character 790 and any added line moved it out of the window.
    const body = exportedBody(file, "lookupPersonByPhoneAction");
    // SEC-11 (SEC-2a): the limit moved inside `resolveContact` itself, so it
    // covers every path that can reveal a match, not just this one.
    check(
      `${relative(root, file)}'s lookupPersonByPhoneAction resolves through the rate-limited resolveContact`,
      /resolveContact\(/.test(body) && /rateLimited/.test(body),
    );
    check(
      `${relative(root, file)}'s lookupPersonByPhoneAction reuses describeMatch (never a raw record fetch)`,
      /describeMatch\(/.test(body) &&
        !/\.findMany\(/.test(body) &&
        !/prisma\.user\.findUnique/.test(body),
    );
  }

  const peopleValidation = readFileSync(
    join(root, "lib", "validation", "people.ts"),
    "utf8",
  );
  check(
    "PhoneLookupResult's found case is a MatchCandidate — minimum fields, same shape the match panel already renders",
    /found";\s*match:\s*MatchCandidate/.test(
      peopleValidation.replace(/\s+/g, " "),
    ),
  );

  // The rate limiter itself, exercised directly (lib/rate-limit.ts) — a
  // fresh key allows exactly `limit` calls in the window, then refuses.
  // Fixture timing (SYS): the window is fixed and epoch-aligned, so 25 remote
  // calls (~7 s) started late in a minute could straddle two windows and be
  // allowed 20 + n. Start with at least 15 s of the window left.
  const msLeft = 60_000 - (Date.now() % 60_000);
  if (msLeft < 15_000) await new Promise((resolve) => setTimeout(resolve, msLeft + 50));
  const key = `people-check-${Date.now()}`;
  let allowed = 0;
  for (let i = 0; i < 25; i += 1) {
    if (await checkRateLimit(key, 20, 60_000)) allowed += 1;
  }
  check(
    "The rate limiter allows exactly the configured limit, then refuses",
    allowed === 20 && !(await checkRateLimit(key, 20, 60_000)),
  );
}

/** Parses like a Server Action does, and shouts if the fixture is wrong. */
function parse<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: Record<string, string>,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined) {
    throw new Error(`${label} failed validation: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** Centres this run created — their `resolveContact` rate-limit buckets go with them. */
const createdCenterIds = new Set<string>();

async function cleanup() {
  if (createdCenterIds.size > 0) {
    await prisma.rateLimitBucket.deleteMany({
      where: { key: { in: [...createdCenterIds].map((id) => `identityLookupPerCenter:${id}`) } },
    });
  }
  // F4: promotion batches write audit rows (append-only) naming these centres.
  const fixtureCenters = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_C] } }, select: { id: true } });
  if (fixtureCenters.length > 0) {
    await deleteAuditRows(prisma, { centerId: { in: fixtureCenters.map((center) => center.id) } });
  }
  await prisma.center.deleteMany({
    where: { slug: { in: [SLUG_A, SLUG_B, SLUG_C] } },
  });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "people-check-f4-" } },
        { email: { in: [SHARED_EMAIL, TEACHER_EMAIL, LOCAL_ONLY_EMAIL, LOCAL_EMAIL, CONTACT_PHONE_EMAIL] } },
        { phone: SHARED_PHONE },
        { email: { startsWith: RACE_EMAIL_PREFIX } },
      ],
    },
  });
  // Global catalog rows (M13) don't cascade away with the centers above.
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: "People-Check" } } });
}

/**
 * F4 — bulk grade promotion is previewable, partial and undoable, and moves
 * only this branch's grade on file. Runs the REAL `lib/db/promotion.ts`.
 */
async function checkGradePromotion(
  centerA: { id: string },
  centerB: { id: string },
): Promise<void> {
  console.log("\nF4 — grade promotion (preview, partial, undo, isolation)");

  const gFrom = await prisma.catalogGrade.create({ data: { nameAr: "People-Check F4 From", nameEn: "People-Check F4 From" } });
  const gTo = await prisma.catalogGrade.create({ data: { nameAr: "People-Check F4 To", nameEn: "People-Check F4 To" } });
  const gOther = await prisma.catalogGrade.create({ data: { nameAr: "People-Check F4 Other", nameEn: "People-Check F4 Other" } });
  const gUnoffered = await prisma.catalogGrade.create({ data: { nameAr: "People-Check F4 Unoffered", nameEn: "People-Check F4 Unoffered" } });
  const gRetired = await prisma.catalogGrade.create({ data: { nameAr: "People-Check F4 Retired", nameEn: "People-Check F4 Retired", active: false } });
  for (const centerId of [centerA.id, centerB.id]) {
    for (const grade of [gFrom, gTo, gOther, gRetired]) {
      await prisma.centerCatalogSelection.create({ data: { centerId, kind: "GRADE", gradeId: grade.id } });
    }
  }

  const form = (n: number) => ({
    locale: "en",
    firstName: `F4Student${n}`,
    lastName: "Check",
    email: `people-check-f4-s${n}@kayedu.test`,
    parentFirstName: "Parent",
    parentPhone: "01166677788",
  });
  const s1 = await registerStudent(centerA.id, form(1));
  const s2 = await registerStudent(centerA.id, form(2));
  const s3 = await registerStudent(centerA.id, form(3));
  const s4 = await registerStudent(centerA.id, form(4));
  const sB = await registerStudent(centerB.id, form(5));
  await prisma.studentProfile.updateMany({ where: { id: { in: [s1.profileId, s2.profileId, s3.profileId, s4.profileId] } }, data: { gradeId: gFrom.id } });
  await prisma.studentProfile.update({ where: { id: s4.profileId }, data: { active: false } });
  await prisma.studentProfile.update({ where: { id: sB.profileId }, data: { gradeId: gFrom.id } });
  // s3's own account says a different grade; it must survive every promotion.
  await prisma.user.update({ where: { id: s3.userId }, data: { gradeId: gOther.id } });

  // An active enrolment in a class of the From grade — promotion must never touch it.
  const teacher = await prisma.user.create({
    data: { firstName: "F4", lastName: "Teacher", email: "people-check-f4-teacher@kayedu.test" },
  });
  const classGroup = await prisma.classGroup.create({
    data: {
      centerId: centerA.id,
      teacherId: teacher.id,
      gradeId: gFrom.id,
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-01-31"),
    },
  });
  await prisma.enrollment.create({ data: { centerId: centerA.id, studentProfileId: s1.profileId, classGroupId: classGroup.id } });
  const enrolmentsBefore = JSON.stringify(await prisma.enrollment.findMany({ where: { centerId: centerA.id }, orderBy: { id: "asc" } }));
  const classBefore = JSON.stringify(await prisma.classGroup.findUnique({ where: { id: classGroup.id } }));
  const gradeOf = async (profileId: string) =>
    (await prisma.studentProfile.findUniqueOrThrow({ where: { id: profileId } })).gradeId;
  const actor = teacher.id;

  // ── Preview ────────────────────────────────────────────────────────────
  const preview = await promotionPreview(prisma, centerA.id, gFrom.id);
  check(
    "The preview lists this branch's ACTIVE students in the From grade only (not the inactive one, not another branch's)",
    preview.map((row) => row.id).sort().join() === [s1.profileId, s2.profileId, s3.profileId].sort().join(),
  );
  check(
    "The preview shows a differing account grade and the active enrolments in the From grade",
    preview.find((row) => row.id === s3.profileId)?.accountGradeId === gOther.id &&
      preview.find((row) => row.id === s1.profileId)?.activeEnrollments === 1 &&
      preview.find((row) => row.id === s2.profileId)?.activeEnrollments === 0,
  );

  // ── Refusals before anything is written ─────────────────────────────────
  check("Promoting into the same grade is refused", (await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gFrom.id, studentIds: [s1.profileId] })).ok === false);
  const unoffered = await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gUnoffered.id, studentIds: [s1.profileId] });
  check("A To grade this branch never picked is refused (notFound)", !unoffered.ok && unoffered.error === "notFound");
  const retired = await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gRetired.id, studentIds: [s1.profileId] });
  check("A To grade the platform has deactivated is refused", !retired.ok && retired.error === "notFound");
  const none = await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gTo.id, studentIds: [] });
  check("Confirming with nobody ticked is refused", !none.ok && none.error === "noStudentsToPromote");
  check("None of those refusals moved anyone", (await gradeOf(s1.profileId)) === gFrom.id);

  // ── Partial promotion ───────────────────────────────────────────────────
  // Ticked: s1, s3, the inactive s4 and ANOTHER BRANCH's student. s2 is unticked.
  const first = await confirmGradePromotion(prisma, {
    centerId: centerA.id,
    actorUserId: actor,
    fromGradeId: gFrom.id,
    toGradeId: gTo.id,
    studentIds: [s1.profileId, s3.profileId, s4.profileId, sB.profileId],
  });
  check("A partial promotion moves exactly the ticked, active, in-branch students", first.ok && first.count === 2 && first.skipped === 2, JSON.stringify(first));
  check(
    "Ticked students moved; the unticked and inactive ones did not",
    (await gradeOf(s1.profileId)) === gTo.id &&
      (await gradeOf(s3.profileId)) === gTo.id &&
      (await gradeOf(s2.profileId)) === gFrom.id &&
      (await gradeOf(s4.profileId)) === gFrom.id,
  );
  check("Another branch's student, ticked by id, did not move (cross-branch isolation)", (await gradeOf(sB.profileId)) === gFrom.id);
  const batch1 = first.ok ? await prisma.gradePromotionBatch.findUnique({ where: { id: first.batchId }, include: { items: true } }) : null;
  check(
    "One batch with one item per student actually moved, recording the previous grade",
    batch1 !== null && batch1.centerId === centerA.id && batch1.fromGradeId === gFrom.id && batch1.toGradeId === gTo.id &&
      batch1.items.length === 2 && batch1.items.every((item) => item.previousGradeId === gFrom.id) && batch1.undoneAt === null,
  );
  const promoteAudit = first.ok ? await prisma.auditLog.findMany({ where: { centerId: centerA.id, action: "student.grade.promote", entityId: first.batchId } }) : [];
  check(
    "Exactly one audit row student.grade.promote: batch id and counts, no names (D-20)",
    promoteAudit.length === 1 &&
      forbiddenAuditKey(promoteAudit[0].after) === null &&
      (promoteAudit[0].after as { count?: number } | null)?.count === 2,
  );
  check("User.gradeId is untouched by promotion", (await prisma.user.findUniqueOrThrow({ where: { id: s3.userId } })).gradeId === gOther.id);
  check(
    "Enrolments and the class are untouched (byte for byte, updatedAt included)",
    JSON.stringify(await prisma.enrollment.findMany({ where: { centerId: centerA.id }, orderBy: { id: "asc" } })) === enrolmentsBefore &&
      JSON.stringify(await prisma.classGroup.findUnique({ where: { id: classGroup.id } })) === classBefore,
  );

  // ── Cross-branch isolation of the batch itself ──────────────────────────
  const bUndo = first.ok ? await undoGradePromotion(prisma, { centerId: centerB.id, actorUserId: actor, batchId: first.batchId }) : null;
  check("Another branch cannot undo this branch's batch (notFound)", bUndo !== null && !bUndo.ok && bUndo.error === "notFound");
  check("Another branch sees none of this branch's batches", (await prisma.gradePromotionBatch.count({ where: scopedWhere(centerB.id) })) === 0);
  const bConfirm = await confirmGradePromotion(prisma, { centerId: centerB.id, actorUserId: actor, fromGradeId: gTo.id, toGradeId: gFrom.id, studentIds: [s1.profileId] });
  check("Another branch cannot move this branch's student by id", !bConfirm.ok && (await gradeOf(s1.profileId)) === gTo.id);

  // ── Undo: only the latest batch, only untouched rows ─────────────────────
  const second = await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gTo.id, studentIds: [s2.profileId] });
  const notLatest = first.ok ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: first.batchId }) : null;
  check("Only the latest batch can be undone (the older one is refused while a newer is open)", second.ok && notLatest !== null && !notLatest.ok && notLatest.error === "notLatest");

  // A manager moves s3 elsewhere after the batch; undo must leave it alone.
  await prisma.studentProfile.update({ where: { id: s3.profileId }, data: { gradeId: gOther.id } });
  const undoSecond = second.ok ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: second.batchId }) : null;
  check("Undoing the latest batch puts its student back", undoSecond?.ok === true && undoSecond.reverted === 1 && (await gradeOf(s2.profileId)) === gFrom.id);
  const undoFirst = first.ok ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: first.batchId }) : null;
  check(
    "Undo reverts only students whose grade still equals the batch's To grade",
    undoFirst?.ok === true && undoFirst.reverted === 1 && undoFirst.skipped === 1 &&
      (await gradeOf(s1.profileId)) === gFrom.id && (await gradeOf(s3.profileId)) === gOther.id,
    JSON.stringify(undoFirst),
  );
  const again = first.ok ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: first.batchId }) : null;
  check("An undone batch cannot be undone twice", again !== null && !again.ok && again.error === "alreadyUndone");
  const undone = first.ok ? await prisma.gradePromotionBatch.findUnique({ where: { id: first.batchId } }) : null;
  check("The batch records who undid it and when", undone?.undoneAt != null && undone.undoneBy === actor);
  const undoAudit = first.ok ? await prisma.auditLog.count({ where: { centerId: centerA.id, action: "student.grade.promote.undo", entityId: first.batchId } }) : 0;
  check("The undo is audited as student.grade.promote.undo", undoAudit === 1);
  check("User.gradeId and enrolments are still untouched after undo", (await prisma.user.findUniqueOrThrow({ where: { id: s3.userId } })).gradeId === gOther.id && JSON.stringify(await prisma.enrollment.findMany({ where: { centerId: centerA.id }, orderBy: { id: "asc" } })) === enrolmentsBefore);

  // ── The 14-day limit ────────────────────────────────────────────────────
  const third = await confirmGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, fromGradeId: gFrom.id, toGradeId: gTo.id, studentIds: [s1.profileId] });
  const batch3 = third.ok ? await prisma.gradePromotionBatch.findUniqueOrThrow({ where: { id: third.batchId } }) : null;
  const day = 24 * 60 * 60 * 1000;
  check(
    "The undo window is 14 days: open at 14 days, closed a second after",
    batch3 !== null && PROMOTION_UNDO_DAYS === 14 &&
      isWithinUndoWindow(batch3.createdAt, new Date(batch3.createdAt.getTime() + 14 * day)) &&
      !isWithinUndoWindow(batch3.createdAt, new Date(batch3.createdAt.getTime() + 14 * day + 1000)),
  );
  const expired = third.ok && batch3 ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: third.batchId, now: new Date(batch3.createdAt.getTime() + 14 * day + 1000) }) : null;
  check("Past 14 days the undo is refused and moves nobody", expired !== null && !expired.ok && expired.error === "expired" && (await gradeOf(s1.profileId)) === gTo.id);
  const inTime = third.ok && batch3 ? await undoGradePromotion(prisma, { centerId: centerA.id, actorUserId: actor, batchId: third.batchId, now: new Date(batch3.createdAt.getTime() + 13 * day) }) : null;
  check("Inside the window the same undo succeeds", inTime?.ok === true && inTime.reverted === 1 && (await gradeOf(s1.profileId)) === gFrom.id);

  // ── The old one-click path is gone ──────────────────────────────────────
  const scopedSource = readFileSync(join(process.cwd(), "lib", "db", "scoped.ts"), "utf8");
  check("scoped students has no one-click promoteGrade any more", !/promoteGrade\s*:/.test(scopedSource));

  // The audit trail is append-only and a deleted centre only nulls its rows'
  // centerId — so these rows are removed (maintenance path) while still findable.
  await deleteAuditRows(prisma, { centerId: { in: [centerA.id, centerB.id] } });
}

/** The lookup context the centre's Add-student action passes (no actor: this gate is not a staff member). */
const lookupAt = (centerId: string): LookupContext => ({ centerId, actorUserId: null, adding: "student" });

/**
 * Registers a student the way `createStudentAction` does — through the REAL
 * identity module (SEC-2c: this gate used to carry its own copy of the
 * matching query, which could never disagree with itself): `resolveContact`
 * across global + local contacts, `describeMatch` before linking, the local
 * name seeded by `seedLocalName`, then `createPerson` (for a brand-new person),
 * the code claim and the profile in one transaction. Takes a centerId and
 * nothing else — same "zero code changes for a second center" claim the M2
 * gate makes.
 */
async function registerStudent(
  centerId: string,
  form: Record<string, string>,
): Promise<{ userId: string; profileId: string; studentCode: string; linked: boolean }> {
  const input = parse(studentCreateSchema, form, "studentCreate");
  const contact = { email: input.email, phone: input.phone };
  const resolution = await resolveContact(lookupAt(centerId), contact);
  if (resolution.kind === "conflict" || resolution.kind === "rateLimited") {
    throw new Error(`unexpected ${resolution.kind} in fixture`);
  }

  let described: Awaited<ReturnType<typeof describeMatch>> | null = null;
  let linkTo: string | null = null;
  if (resolution.kind === "matched") {
    described = await describeMatch(centerId, resolution.match, contact);
    if (described.existingHere === "student" || !described.linkable) {
      throw new Error("unexpected alreadyStudent in fixture");
    }
    linkTo = resolution.match.user.id;
  }
  const name = seedLocalName(resolution, { firstName: input.firstName, lastName: input.lastName }, described);

  const created = await prisma.$transaction(async (tx) => {
    const userId =
      linkTo ??
      (
        await createPerson(
          {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            phone: input.phone,
            altPhone: input.altPhone,
            locale: input.locale,
          },
          tx,
        )
      ).id;

    const code = await claimStudentCode(tx, centerId);

    const profile = await tx.studentProfile.create({
      data: scopedData(centerId, {
        userId,
        studentCode: code,
        firstName: name.firstName,
        lastName: name.lastName,
        email: input.email,
        phone: input.phone,
        parentFirstName: input.parentFirstName,
        parentPhone: input.parentPhone,
      }),
    });

    return { userId, profile };
  });

  return {
    userId: created.userId,
    profileId: created.profile.id,
    studentCode: created.profile.studentCode,
    linked: linkTo !== null,
  };
}

async function main() {
  // Database-free static gates first (M18) — no fixtures to clean up either
  // way, so they run before anything else touches the database.
  checkSingleNormalizer();
  await checkPhoneLookupShape();

  await cleanup();

  const centerA = await prisma.center.create({
    data: {
      slug: SLUG_A,
      name: "People A",
      themeColor: "#2563eb",
      organization: { create: { name: "People A" } },
    },
  });
  createdCenterIds.add(centerA.id);
  const centerB = await prisma.center.create({
    data: {
      slug: SLUG_B,
      name: "People B",
      themeColor: "#16a34a",
      organization: { create: { name: "People B" } },
    },
  });
  createdCenterIds.add(centerB.id);

  // Global catalog rows (M13) — no centerId; StudentProfile.gradeId
  // references them directly. Three distinct rows, matching the pre-M13
  // fixture shape (this test only needs valid, distinct grade ids, not
  // centre ownership of them).
  const gradeA1 = await prisma.catalogGrade.create({
    data: { nameAr: "People-Check Grade 10", nameEn: "People-Check Grade 10" },
  });
  const gradeA2 = await prisma.catalogGrade.create({
    data: { nameAr: "People-Check Grade 11", nameEn: "People-Check Grade 11" },
  });
  const gradeB1 = await prisma.catalogGrade.create({
    data: { nameAr: "People-Check Grade 10 (B)", nameEn: "People-Check Grade 10 (B)" },
  });

  console.log("People check (M3 revised — center-local contacts, system-assigned codes)");

  // ── 1. One person, registered at two centers ───────────────────────────
  const sharedForm = {
    locale: "en",
    firstName: "Mona",
    lastName: "Hassan",
    email: SHARED_EMAIL,
    phone: SHARED_PHONE,
    parentFirstName: "Hassan",
    parentPhone: "01112345678",
  };

  const inA = await registerStudent(centerA.id, sharedForm);
  check(
    "A student registers once and is connected to the center",
    inA.linked === false && Boolean(inA.profileId),
  );

  // The same human walks into the second center. Typed with a +20 prefix and
  // a capitalised email — the same identity either way.
  const inB = await registerStudent(centerB.id, {
    ...sharedForm,
    email: SHARED_EMAIL.toUpperCase(),
    phone: "+201012345678",
  });

  check(
    "A duplicate phone/email matches the existing person instead of creating one",
    inB.linked === true && inB.userId === inA.userId,
    `A=${inA.userId} B=${inB.userId}`,
  );
  check(
    "One identity, two center profiles (no duplicate person)",
    (await prisma.user.count({ where: { email: SHARED_EMAIL } })) === 1 &&
      (await prisma.studentProfile.count({ where: { userId: inA.userId } })) === 2,
  );
  check(
    "Nothing matchable means no match at all (a blank form matches nobody)",
    await (async () => {
      const blank = await resolveContact(lookupAt(centerA.id), { email: null, phone: null });
      return blank.kind === "none" && blank.others.length === 0;
    })(),
  );

  // ── 1b. Contact details are center-local, not global ───────────────────
  // The seed above wrote SHARED_EMAIL/SHARED_PHONE onto the *global* User
  // (this was a brand-new person) AND onto centerA's local StudentProfile.
  // Center A now edits its own copy; Center B's copy — and the global User —
  // must be untouched.
  const localOnlyContact = { email: LOCAL_ONLY_EMAIL, phone: "01099999999" };
  await prisma.studentProfile.update({
    where: { id: inA.profileId },
    data: localOnlyContact,
  });

  const [globalAfterEdit, profileB, profileA] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: inA.userId } }),
    prisma.studentProfile.findUniqueOrThrow({ where: { id: inB.profileId } }),
    prisma.studentProfile.findUniqueOrThrow({ where: { id: inA.profileId } }),
  ]);
  check(
    "Editing a center's local contact does not touch the global User",
    globalAfterEdit.email === SHARED_EMAIL && globalAfterEdit.phone === SHARED_PHONE,
  );
  check(
    "Editing Center A's local contact does not touch Center B's local record",
    profileB.email === SHARED_EMAIL.toLowerCase() && profileB.phone === SHARED_PHONE,
  );
  check(
    "Center A's local record reflects its own edit",
    profileA.email === LOCAL_ONLY_EMAIL && profileA.phone === "01099999999",
  );

  // A third center registers someone new, entering only a contact that lives
  // on Center A's *local* record (never the global User, never seen by B).
  // The match must still find them — this is the reason local records are
  // searched at all, not just the global User.
  const centerC = await prisma.center.create({
    data: {
      slug: SLUG_C,
      name: "People C",
      themeColor: "#f59e0b",
      organization: { create: { name: "People C" } },
    },
  });
  createdCenterIds.add(centerC.id);
  const matchedFromLocalOnly = await resolveContact(lookupAt(centerC.id), { email: LOCAL_ONLY_EMAIL, phone: null });
  check(
    "A contact that exists only on another center's local record is found, never linkable (SEC-2a)",
    matchedFromLocalOnly.kind === "none" &&
      matchedFromLocalOnly.others.some((other) => other.user.id === inA.userId && !isLinkableMatch(other)),
    JSON.stringify({
      kind: matchedFromLocalOnly.kind,
      others: "others" in matchedFromLocalOnly ? matchedFromLocalOnly.others.map((other) => other.user.id === inA.userId) : null,
    }),
  );
  // F2 (D-02 (a)): a self-declared `User.contactPhone` is never an identity
  // key — the same lookup a receptionist runs finds nobody by it.
  const declarer = await prisma.user.create({
    data: { email: CONTACT_PHONE_EMAIL, firstName: "Self", lastName: "Declared", contactPhone: CONTACT_PHONE },
  });
  const byContactPhone = await resolveContact(lookupAt(centerC.id), { email: null, phone: CONTACT_PHONE });
  check(
    "A User's self-declared contactPhone never matches, links or describes them (F2, D-02 (a))",
    byContactPhone.kind === "none" &&
      !("others" in byContactPhone && byContactPhone.others.some((other) => other.user.id === declarer.id)),
    JSON.stringify({ kind: byContactPhone.kind }),
  );
  await prisma.center.delete({ where: { id: centerC.id } });

  // ── 2. Student codes are system-assigned, per-center, race-free ────────
  check(
    "The first two students in a fresh center get codes 1001 and 1002",
    inA.studentCode === "1001" &&
      (
        await registerStudent(centerA.id, {
          locale: "en",
          firstName: "Youssef",
          lastName: "Adel",
          email: LOCAL_EMAIL,
        })
      ).studentCode === "1002",
  );
  check(
    "The same numbering starts fresh in a second center — zero code changes",
    inB.studentCode === "1001",
  );

  const RACE_SIZE = 12;
  const raceResults = await Promise.all(
    Array.from({ length: RACE_SIZE }, (_, i) =>
      registerStudent(centerA.id, {
        locale: "en",
        firstName: "Race",
        lastName: String(i),
        email: `${RACE_EMAIL_PREFIX}-${i}@kayedu.test`,
      }),
    ),
  );
  const raceCodes = raceResults.map((r) => Number(r.studentCode)).sort((a, b) => a - b);
  const uniqueCodes = new Set(raceCodes);
  const isContiguous = raceCodes.every(
    (code, i) => i === 0 || code === raceCodes[i - 1] + 1,
  );
  check(
    `${RACE_SIZE} concurrent registrations produce ${RACE_SIZE} unique codes (no duplicates)`,
    uniqueCodes.size === RACE_SIZE,
    `got ${uniqueCodes.size} unique of ${raceCodes.length}`,
  );
  check(
    "Concurrent registrations produce contiguous codes (no gaps)",
    isContiguous,
    JSON.stringify(raceCodes),
  );

  // ── 3. Cross-center reads on every path M3 added ───────────────────────
  const teacher = await prisma.user.create({
    data: { firstName: "Sara", lastName: "Nabil", email: TEACHER_EMAIL },
  });
  const teacherInA = await prisma.membership.create({
    data: {
      userId: teacher.id,
      centerId: centerA.id,
      role: "TEACHER",
      email: TEACHER_EMAIL,
    },
  });
  const teacherInB = await prisma.membership.create({
    data: {
      userId: teacher.id,
      centerId: centerB.id,
      role: "TEACHER",
      email: TEACHER_EMAIL,
    },
  });

  const blockInA = await prisma.studentBlock.create({
    data: {
      centerId: centerA.id,
      scope: "TEACHER",
      refId: teacher.id,
      blockedUserId: inA.userId,
      reason: "check",
    },
  });

  const leaks: [string, unknown][] = [
    [
      "StudentProfile",
      await scopedFindById(prisma.studentProfile, centerA.id, inB.profileId),
    ],
    [
      "teacher Membership",
      await scopedFindById(prisma.membership, centerA.id, teacherInB.id),
    ],
    [
      "StudentBlock",
      await scopedFindById(prisma.studentBlock, centerB.id, blockInA.id),
    ],
  ];
  for (const [label, leaked] of leaks) {
    check(`Center A cannot read Center B's ${label} by id`, leaked === null);
  }

  const teachersInB = await prisma.membership.findMany({
    where: scopedWhere(centerB.id, { role: TEACHER_ROLE }),
  });
  check(
    "A scoped teacher list excludes the other center's membership",
    teachersInB.length === 1 && teachersInB[0].id === teacherInB.id,
  );
  check(
    "The shared teacher's local email is independent per center",
    (
      await prisma.membership.findUniqueOrThrow({ where: { id: teacherInA.id } })
    ).email === TEACHER_EMAIL,
  );

  // ── 4. Blocking is per center, for a teacher shared by two ─────────────
  // The flagship risk on this path: the same teacher and the same student
  // exist in both centers, so a block must not follow them across.
  const blockedInA = await prisma.studentBlock.count({
    where: scopedWhere(centerA.id, {
      scope: TEACHER_SCOPE,
      refId: teacher.id,
      blockedUserId: inA.userId,
    }),
  });
  const blockedInB = await prisma.studentBlock.count({
    where: scopedWhere(centerB.id, {
      scope: TEACHER_SCOPE,
      refId: teacher.id,
      blockedUserId: inA.userId,
    }),
  });
  check("A block applies in the center that made it", blockedInA === 1);
  check(
    "A shared teacher's block does NOT follow the student to another center",
    blockedInB === 0,
  );

  let duplicateBlockRejected = false;
  try {
    await prisma.studentBlock.create({
      data: {
        centerId: centerA.id,
        scope: "TEACHER",
        refId: teacher.id,
        blockedUserId: inA.userId,
      },
    });
  } catch {
    duplicateBlockRejected = true;
  }
  check("The same student cannot be blocked twice", duplicateBlockRejected);

  const blockForm = parse(
    blockCreateSchema,
    {
      locale: "en",
      teacherUserId: teacher.id,
      studentProfileId: inA.profileId,
      reason: "Repeated disruption",
    },
    "blockCreate",
  );
  check(
    "The block schema keeps the teacher and student ids it was given",
    blockForm.teacherUserId === teacher.id &&
      blockForm.studentProfileId === inA.profileId,
  );

  // ── 5. Grade promotion stays inside its center ─────────────────────────
  await prisma.studentProfile.updateMany({
    where: scopedWhere(centerA.id),
    data: { gradeId: gradeA1.id },
  });
  await prisma.studentProfile.updateMany({
    where: scopedWhere(centerB.id),
    data: { gradeId: gradeB1.id },
  });

  const promotion = parse(
    gradePromotionSchema,
    { locale: "en", fromGradeId: gradeA1.id, toGradeId: gradeA2.id },
    "gradePromotion",
  );
  const promoted = await prisma.studentProfile.updateMany({
    where: scopedWhere(centerA.id, {
      gradeId: promotion.fromGradeId,
      active: true,
    }),
    data: { gradeId: promotion.toGradeId },
  });

  check(
    "Promotion moves this center's students",
    promoted.count === 2 + RACE_SIZE,
    `got ${promoted.count}`,
  );
  check(
    "Promotion leaves the other center's students where they were",
    (await prisma.studentProfile.count({
      where: scopedWhere(centerB.id, { gradeId: gradeB1.id }),
    })) === 1,
  );
  check(
    "Promoting into the same grade is rejected",
    !gradePromotionSchema.safeParse({
      locale: "en",
      fromGradeId: gradeA1.id,
      toGradeId: gradeA1.id,
    }).success,
  );

  // ── 5b. F4: previewable, partial, undoable promotion ───────────────────
  await checkGradePromotion(centerA, centerB);

  // ── 6. Storage paths are the tenant boundary for files ─────────────────
  const photoPath = studentPhotoPath(centerA.id, inA.profileId, "png", "abc");
  const cardPath = studentIdCardPath(centerA.id, inA.profileId);

  check(
    "Every object path is namespaced by centerId",
    photoPath.startsWith(`${centerA.id}/`) &&
      cardPath === `${centerA.id}/${inA.profileId}.svg`,
    photoPath,
  );
  check(
    "The filename stem stays the profile id, so the read policy still matches",
    photoPath.split("/")[1].split(".")[0] === inA.profileId,
  );
  check(
    "A path built for one center is refused by another",
    !isPathInCenter(centerB.id, cardPath),
  );

  let assertRejected = false;
  try {
    assertPathInCenter(centerB.id, cardPath);
  } catch (error) {
    assertRejected = error instanceof StoragePathError;
  }
  check("assertPathInCenter throws across centers", assertRejected);

  let unscopedPathRejected = false;
  try {
    centerObjectPath("", "anything.png");
  } catch (error) {
    unscopedPathRejected = error instanceof StoragePathError;
  }
  check(
    "A storage path cannot be built without a centerId",
    unscopedPathRejected,
  );

  let traversalRejected = false;
  try {
    centerObjectPath(centerA.id, "../../etc/passwd");
  } catch (error) {
    traversalRejected = error instanceof StoragePathError;
  }
  check("A traversal segment is refused", traversalRejected);
  check(
    "A prefix collision is not a match (centerA vs centerA-extra)",
    !isPathInCenter(centerA.id, `${centerA.id}-extra/${inA.profileId}.svg`),
  );
  check(
    "Only the allowed image types get an extension",
    photoExtensionFor("image/png") === "png" &&
      photoExtensionFor("image/svg+xml") === null,
  );

  // The query primitive and the storage primitive fail the same way.
  let unscopedWhereRejected = false;
  try {
    scopedWhere("", { id: inB.profileId });
  } catch (error) {
    unscopedWhereRejected = error instanceof MissingCenterScopeError;
  }
  check(
    "scopedWhere still refuses to build an unscoped where",
    unscopedWhereRejected,
  );

  // ── 7. The ID card ─────────────────────────────────────────────────────
  const layout = resolveCardLayout({
    version: 1,
    elements: { qr: { x: 70, width: 22 } },
  });
  check(
    "A center's card layout merges over the built-in one",
    layout.elements.qr.x === 70 &&
      layout.elements.qr.width === 22 &&
      layout.elements.studentName.x === 36,
  );
  check(
    "A malformed layout falls back to the built-in one",
    resolveCardLayout("not json at all").elements.qr.x === 74,
  );

  const payload = studentQrPayload(centerA.id, inA.studentCode);
  const parsedPayload = parseStudentQrPayload(payload);
  check(
    "The QR payload round-trips to the center and the student code",
    parsedPayload?.centerId === centerA.id &&
      parsedPayload.studentCode === inA.studentCode,
  );
  check(
    "A foreign QR payload does not parse as a student card",
    parseStudentQrPayload("1001") === null,
  );

  const svg = renderIdCardSvg({
    centerName: 'Center "A" & Co',
    brandColor: centerA.themeColor,
    studentName: "Mona Hassan",
    gradeName: "Grade 11",
    studentCode: inA.studentCode,
    qrPayload: payload,
    labels: { code: "Student code" },
    dir: "ltr",
    layout,
  });

  check(
    "A printable card renders with the student's name, code and a QR block",
    svg.startsWith("<svg") &&
      svg.includes("Mona Hassan") &&
      svg.includes(`>${inA.studentCode}<`) &&
      /<path d="M\d/.test(svg),
  );
  check(
    "The card is landscape credit-card sized for print",
    svg.includes('width="85.6mm"') && svg.includes('height="54mm"'),
  );
  check(
    "Card text is escaped, so a name can never inject markup",
    svg.includes("Center &quot;A&quot; &amp; Co") && !svg.includes('"A" & Co'),
  );

  // The built-in layout must lay out cleanly on its own: an element that falls
  // off the face, or a logo that sits on top of the photo, is a card a center
  // prints and throws away.
  const defaultSvg = renderIdCardSvg({
    centerName: "Al-Noor",
    brandColor: "#2563eb",
    studentName: "Mona Hassan",
    gradeName: "Grade 11",
    studentCode: inA.studentCode,
    qrPayload: payload,
    labels: { code: "Student code" },
    dir: "ltr",
    layout: resolveCardLayout(null),
  });

  const boxes = [
    ...defaultSvg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g),
  ]
    .map((match) => match.slice(1, 5).map(Number) as [number, number, number, number])
    // Drop the full-bleed background and the bottom brand band.
    .filter(([, , width]) => width < CARD_WIDTH);

  const outOfBounds = boxes.filter(
    ([x, y, width, height]) =>
      x < 0 || y < 0 || x + width > CARD_WIDTH || y + height > CARD_HEIGHT,
  );
  let overlapping = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [ax, ay, aw, ah] = boxes[i];
      const [bx, by, bw, bh] = boxes[j];
      if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) {
        overlapping += 1;
      }
    }
  }
  check(
    "Every card element stays on the card face",
    outOfBounds.length === 0,
    JSON.stringify(outOfBounds),
  );
  check(
    "No two card elements overlap in the built-in layout",
    overlapping === 0,
    `${overlapping} overlapping pair(s)`,
  );

  const rtl = renderIdCardSvg({
    centerName: "مركز",
    brandColor: centerA.themeColor,
    studentName: "منى حسن",
    studentCode: inA.studentCode,
    qrPayload: payload,
    labels: { code: "كود الطالب" },
    dir: "rtl",
    layout,
  });
  // DES: anchors are logical — under direction="rtl" a start-aligned text keeps
  // text-anchor="start" (its right edge); flipping it to "end" as well had
  // anchored every Arabic text at its left end (docs/04 §5, check:card-layout).
  check(
    "An Arabic card mirrors the layout and sets its direction",
    rtl.includes('direction="rtl"') &&
      rtl.includes('text-anchor="start" direction="rtl"') &&
      rtl !== svg,
  );

  // ── 8. Name is center-local too, exactly like the other contact fields ──
  // Revised: name is no longer global-locked. It is seeded from the User at
  // creation (register / add-existing-person) and then editable per center,
  // independently, with no lock of any kind — mirroring §1b's contact
  // independence assertions.
  const studentBeforeRename = await prisma.studentProfile.findUniqueOrThrow({
    where: { id: inA.profileId },
  });
  check(
    "A new registration seeds the local name from the form input",
    studentBeforeRename.firstName === "Mona" && studentBeforeRename.lastName === "Hassan",
  );

  const profileBBeforeRename = await prisma.studentProfile.findUniqueOrThrow({
    where: { id: inB.profileId },
  });
  check(
    "A linked registration seeds the local name from the matched person's real name",
    profileBBeforeRename.firstName === "Mona" && profileBBeforeRename.lastName === "Hassan",
  );

  await prisma.studentProfile.update({
    where: { id: inA.profileId },
    data: { firstName: "Mona-CenterA", lastName: "Hassan-CenterA" },
  });

  const [userAfterRename, studentAAfterRename, studentBAfterRename] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: inA.userId } }),
    prisma.studentProfile.findUniqueOrThrow({ where: { id: inA.profileId } }),
    prisma.studentProfile.findUniqueOrThrow({ where: { id: inB.profileId } }),
  ]);
  check(
    "Renaming a center's local record does not touch the global User",
    userAfterRename.firstName === "Mona" && userAfterRename.lastName === "Hassan",
  );
  check(
    "Renaming Center A's local record does not touch Center B's local record",
    studentBAfterRename.firstName === "Mona" && studentBAfterRename.lastName === "Hassan",
  );
  check(
    "Center A's local record reflects its own rename, immediately — no lock",
    studentAAfterRename.firstName === "Mona-CenterA" &&
      studentAAfterRename.lastName === "Hassan-CenterA",
  );
  check(
    "The display name for Center A now reflects the rename",
    fullName(localName(studentAAfterRename, userAfterRename)) === "Mona-CenterA Hassan-CenterA",
  );
  check(
    "Center B's display name is unaffected by Center A's rename",
    fullName(localName(studentBAfterRename, userAfterRename)) === "Mona Hassan",
  );

  // The same independence holds for the teacher shared by both centers.
  await prisma.membership.update({
    where: { id: teacherInA.id },
    data: { firstName: "Sara-CenterA", lastName: "Nabil-CenterA" },
  });
  const [teacherUserAfterRename, teacherAAfterRename, teacherBAfterRename] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: teacher.id } }),
    prisma.membership.findUniqueOrThrow({ where: { id: teacherInA.id } }),
    prisma.membership.findUniqueOrThrow({ where: { id: teacherInB.id } }),
  ]);
  check(
    "Renaming a shared teacher's Center A record does not touch the global User",
    teacherUserAfterRename.firstName === "Sara" && teacherUserAfterRename.lastName === "Nabil",
  );
  check(
    "Renaming a shared teacher's Center A record does not touch Center B's",
    teacherBAfterRename.firstName === null && teacherBAfterRename.lastName === null,
  );
  check(
    "A shared teacher's name is independently editable per center, immediately",
    teacherAAfterRename.firstName === "Sara-CenterA" &&
      teacherAAfterRename.lastName === "Nabil-CenterA",
  );

  // A record whose local name was never seeded (the older staff-invite path,
  // untouched by this change) still displays something sensible: the fallback
  // to the global User's name (lib/identity.ts `localName()`).
  check(
    "A record with no local name falls back to the global User's name",
    fullName(localName(teacherBAfterRename, teacherUserAfterRename)) === "Sara Nabil",
  );

  // ── 9. The schemas reject what the UI must not store ───────────────────
  check(
    "A phone is normalized to one canonical form",
    normalizePhone("+20 101 234 5678") === SHARED_PHONE &&
      normalizePhone("00201012345678") === SHARED_PHONE,
  );
  check(
    "A non-Egyptian mobile is rejected",
    !studentCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      phone: "12345",
    }).success,
  );
  check(
    "A blank name is rejected",
    !studentCreateSchema.safeParse({
      locale: "en",
      firstName: "  ",
      lastName: "B",
    }).success,
  );
  check(
    "The student schema carries no studentCode field at all — it is never typed",
    !("studentCode" in studentCreateSchema.parse({
      locale: "en",
      firstName: "A",
      lastName: "B",
    })),
  );
  check(
    "A student may be registered with no contact details at all (a minor)",
    studentCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
    }).success,
  );
  check(
    "A teacher without a phone or an email is rejected",
    !teacherCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
    }).success,
  );
  check(
    "A teacher with only an email is accepted",
    teacherCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      email: TEACHER_EMAIL,
    }).success,
  );
  check(
    "The teacher schema carries no canSeeEarnings field — earnings are visible by default",
    !("canSeeEarnings" in teacherCreateSchema.parse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      email: TEACHER_EMAIL,
    })),
  );

  // Deleting the center takes its memberships with it; the person does not.
  await prisma.center.delete({ where: { id: centerA.id } });
  check(
    "Removing a center removes its memberships, never the person",
    (await prisma.membership.count({ where: { id: teacherInA.id } })) === 0 &&
      (await prisma.user.count({ where: { id: teacher.id } })) === 1,
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
      console.error(`\n${failures} people check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll people checks passed.");
  });
