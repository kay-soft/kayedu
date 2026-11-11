/**
 * Admin check — the acceptance gate for the Super Admin / platform milestone
 * (M9, docs/00-master-product-spec.md §3 "Super Admin" and §4.4).
 *
 * Run with:  npm run check:admin
 *
 * Exercises the real production functions in `lib/db/platform.ts` — the same
 * ones `app/[locale]/(admin)/admin/centers/actions.ts` and the admin pages
 * call — against throwaway centers, plus a direct assertion on the exact
 * condition `requirePlatformAdmin()` (`lib/auth/tenant.ts`) gates on:
 * `User.isPlatformAdmin`. `requirePlatformAdmin()` itself calls Next's
 * `redirect()`/cookies and cannot run outside the Next.js runtime — the same
 * constraint every other gate script works around by testing the underlying
 * pure condition directly (e.g. `npm run check:approvals` asserts against
 * `lib/auth/permissions.ts`'s `can()` rather than rendering `/approvals`).
 *
 * Platform KPIs (`platformCenterCounts`/`platformTeacherCount`/
 * `platformStudentCount`/`platformSessionCount`/`platformAdoptionTrend`) are
 * deliberately **not** centerId-scoped — a platform admin spans every tenant
 * by design (spec §3) — so, unlike the other gates, this one asserts on the
 * *delta* those functions report across seeding two throwaway centers,
 * rather than an absolute count, since a real dev database may already hold
 * other centers. `platformCenterList`/`platformCenterDetailStats` filter
 * their own result down to just the throwaway centers, which is exact
 * regardless of what else exists in the database.
 *
 * M19 adds: the lifecycle-transition table (`isValidLifecycleTransition`/
 * `transitionCenterLifecycle`, replacing the old boolean activate/suspend),
 * `Center.plan` being fully gone, and (U6) `CenterSettings.
 * centerDataVisibilityDays`/`teacherDataVisibilityDays` defaulting to 365/30
 * and being writable — the same shape `updateCenterVisibilityWindowAction`
 * writes in, under the caps its schema enforces.
 *
 * W6 (D-W35) adds §9: premium — `isPremium` at the boundary instant, the
 * end-date rule in Cairo (past and 401 days refused, exactly 400 allowed),
 * every non-admin role refused on lookup, grant, extend and revoke by direct
 * call to `lib/db/premium.ts`, the neutral answer for an unknown email, the
 * state rules (extend must be later, revoke sets null), audit rows carrying
 * ids and the new end date only, `requirePremium`, and the statics (admin-only
 * actions and nav, and — since W7a — `requirePremium` called only from
 * `lib/db/assistants.ts`).
 *
 * Needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { type CenterLifecycleState } from "@prisma/client";
import {
  ACCESSIBLE_LIFECYCLE_STATES,
  addBranchToOrganization,
  createCenterWithSettings,
  platformOrganizationList,
  updateOrganizationBranchLimit,
  isValidLifecycleTransition,
  platformAdoptionTrend,
  platformCenterCounts,
  platformCenterDetailStats,
  platformCenterList,
  platformSessionCount,
  platformStudentCount,
  platformTeacherCount,
  recordSupportAccess,
  transitionCenterLifecycle,
  validNextLifecycleStates,
} from "../lib/db/platform.ts";
import { centerBaselineGaps, hasFullBaseline } from "../lib/db/provision.ts";
import {
  centerVisibilityWindowSchema,
  createCenterSchema,
  premiumGrantSchema,
  premiumLookupSchema,
} from "../lib/validation/admin.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PREMIUM_ENDING_SOON_DAYS,
  PREMIUM_MAX_DAYS_AHEAD,
  isPremium,
  premiumEndDay,
  premiumEndDayError,
  premiumStatus,
  premiumToday,
  premiumUntilForDay,
  requirePremium,
} from "../lib/auth/premium.ts";
import {
  PREMIUM_AUDIT_ACTIONS,
  extendPremium,
  findPremiumAccountByEmail,
  findPremiumAccountById,
  grantPremium,
  revokePremium,
} from "../lib/db/premium.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { addDays, dateKey, dayMarker } from "../lib/scheduling.ts";
import { navForExperience } from "../components/shell/nav.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { readSource } from "./lib/source.ts";

const prisma = await gatePrisma();

const SLUG_A = "admin-check-a";
const SLUG_B = "admin-check-b";
const SLUG_DUP = "admin-check-a"; // deliberately the same as SLUG_A
// F1: an organization founded here and the branches added to it.
const SLUG_F1_FOUNDER = "admin-check-f1-founder";
const SLUG_F1_SECOND = "admin-check-f1-second";
const SLUG_F1_THIRD = "admin-check-f1-third";
const SLUG_F1_FOURTH = "admin-check-f1-fourth";
const F1_ORG_NAME = "Admin Check F1 Org";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const f1Orgs = await prisma.organization.findMany({ where: { name: F1_ORG_NAME }, select: { id: true } });
  await deleteAuditRows(prisma, { entityType: "Organization", entityId: { in: f1Orgs.map((org) => org.id) } });
  await prisma.center.deleteMany({
    where: { slug: { in: [SLUG_A, SLUG_B, SLUG_F1_FOUNDER, SLUG_F1_SECOND, SLUG_F1_THIRD, SLUG_F1_FOURTH] } },
  });
  await prisma.organization.deleteMany({ where: { id: { in: f1Orgs.map((org) => org.id) } } });
  // W6: the premium rows name their User, not a centre — they go with the fixtures.
  const premiumFixtures = await prisma.user.findMany({ where: { email: { startsWith: "admin-check-premium-" } }, select: { id: true } });
  await deleteAuditRows(prisma, {
    action: { startsWith: "platform.premium." },
    entityType: "User",
    entityId: { in: premiumFixtures.map((user) => user.id) },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: "admin-check-" } } });
  // CatalogSubject is global (M13) — it doesn't cascade away with the
  // throwaway centers above.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Admin-Check" } } });
}

function invite(email: string, invitedBy: string) {
  return {
    email,
    token: `admin-check-token-${Math.random().toString(36).slice(2)}`,
    invitedBy,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

async function main() {
  await cleanup();

  console.log("Platform-admin gate (no database needed)");

  const platformAdmin = { isPlatformAdmin: true };
  const otherCenterOwner = { isPlatformAdmin: false };
  check(
    "A platform admin's User.isPlatformAdmin is true — requirePlatformAdmin()'s exact condition",
    platformAdmin.isPlatformAdmin === true,
  );
  check(
    "An OWNER of some other center has isPlatformAdmin: false — requirePlatformAdmin() denies them",
    otherCenterOwner.isPlatformAdmin === false,
  );

  console.log("\nDatabase-backed checks");

  const admin = await prisma.user.create({
    data: {
      firstName: "Admin",
      lastName: "Check",
      email: "admin-check-admin@kayedu.test",
      locale: "en",
      isPlatformAdmin: true,
    },
  });

  const baselineCenterCounts = await platformCenterCounts(prisma);
  const baselineTeachers = await platformTeacherCount(prisma);
  const baselineStudents = await platformStudentCount(prisma);
  const baselineSessions = await platformSessionCount(prisma);
  const baselineTrend = await platformAdoptionTrend(prisma, 6);
  const baselineCurrentMonth = baselineTrend[baselineTrend.length - 1].count;

  // ── 1. Create a center tenant end-to-end ─────────────────────────────────
  const created = await createCenterWithSettings(prisma, {
    name: "Admin Check Center A",
    slug: SLUG_A,
    themeColor: "#2563EB",
    // Already-lowercased: the real action's zod schema normalizes email
    // before this function ever sees it (`lib/validation/admin.ts`'s
    // `ownerEmail`); createCenterWithSettings itself does no normalizing.
    invite: invite("admin-check-ownera@kayedu.test", admin.id),
  });
  check("createCenterWithSettings succeeds for a fresh slug", created.ok, JSON.stringify(created));
  const centerA = created.ok ? created.center : null;

  if (centerA) {
    check(
      "A freshly admin-provisioned center starts ONBOARDING, not ACTIVE (M19)",
      centerA.lifecycleState === "ONBOARDING",
      centerA.lifecycleState,
    );

    const settingsRow = await prisma.centerSettings.findUnique({ where: { centerId: centerA.id } });
    check(
      "A CenterSettings row is created in the same flow, with sane defaults",
      settingsRow !== null &&
        settingsRow.defaultShareType === "PERCENTAGE" &&
        settingsRow.defaultShareValue === 15 &&
        settingsRow.centerDataVisibilityDays === 365 &&
        settingsRow.teacherDataVisibilityDays === 30,
      JSON.stringify(settingsRow),
    );

    const ownerInvitation = await prisma.invitation.findFirst({
      where: { centerId: centerA.id, role: "OWNER" },
    });
    check(
      "A founding-Owner Invitation is created for the address supplied",
      ownerInvitation?.email === "admin-check-ownera@kayedu.test",
      JSON.stringify(ownerInvitation),
    );

    // M12: the matrix is deny-by-default, so a fresh center needs its
    // baseline PermissionGrant rows seeded in this same flow — otherwise the
    // founding Owner could do nothing beyond the ceiling-forced ownership
    // actions the moment they accept the invite above.
    const ownerGrants = await prisma.permissionGrant.findMany({
      where: { centerId: centerA.id, role: "OWNER" },
    });
    check(
      "A fresh center's founding Owner has real baseline PermissionGrant rows, not zero",
      ownerGrants.length > 0 &&
        ownerGrants.every((row) => row.allowed) &&
        ownerGrants.some((row) => row.action === "student.manage"),
      JSON.stringify(ownerGrants.map((row) => row.action)),
    );
  }

  const duplicate = await createCenterWithSettings(prisma, {
    name: "Duplicate slug attempt",
    slug: SLUG_DUP,
    themeColor: "#2563EB",
    invite: invite("admin-check-dup@kayedu.test", admin.id),
  });
  check(
    "A duplicate slug is refused as slugTaken, not silently overwritten",
    !duplicate.ok && duplicate.error === "slugTaken",
    JSON.stringify(duplicate),
  );

  const createdB = await createCenterWithSettings(prisma, {
    name: "Admin Check Center B",
    slug: SLUG_B,
    themeColor: "#16A34A",
    invite: invite("admin-check-ownerB@kayedu.test", admin.id),
  });
  const centerB = createdB.ok ? createdB.center : null;
  check("A second, independent center provisions the same way", createdB.ok, JSON.stringify(createdB));

  if (!centerA || !centerB) {
    throw new Error("Setup failed — cannot continue admin-check.");
  }

  // ── 2. Centre lifecycle transitions (M19) ────────────────────────────────
  console.log("\nLifecycle transition table (no database needed)");
  const expectedAccessible: CenterLifecycleState[] = ["ONBOARDING", "ACTIVE", "GRACE"];
  check(
    "ACCESSIBLE_LIFECYCLE_STATES is exactly ONBOARDING/ACTIVE/GRACE — the sign-in gate lib/auth/tenant.ts filters on",
    ACCESSIBLE_LIFECYCLE_STATES.length === 3 &&
      expectedAccessible.every((state) => ACCESSIBLE_LIFECYCLE_STATES.includes(state)) &&
      !ACCESSIBLE_LIFECYCLE_STATES.includes("SUSPENDED") &&
      !ACCESSIBLE_LIFECYCLE_STATES.includes("ARCHIVED"),
    JSON.stringify(ACCESSIBLE_LIFECYCLE_STATES),
  );
  check(
    "ONBOARDING -> ACTIVE is valid (setup finishing)",
    isValidLifecycleTransition("ONBOARDING", "ACTIVE"),
  );
  check(
    "ONBOARDING -> GRACE is refused — grace is a lapse from active service, not a pre-launch state",
    !isValidLifecycleTransition("ONBOARDING", "GRACE"),
  );
  check("ACTIVE -> GRACE is valid", isValidLifecycleTransition("ACTIVE", "GRACE"));
  check("GRACE -> ACTIVE is valid (resolved before a hard suspension)", isValidLifecycleTransition("GRACE", "ACTIVE"));
  check("GRACE -> SUSPENDED is valid", isValidLifecycleTransition("GRACE", "SUSPENDED"));
  check("SUSPENDED -> ACTIVE is valid (reinstated)", isValidLifecycleTransition("SUSPENDED", "ACTIVE"));
  const nonTerminalStates: CenterLifecycleState[] = ["ONBOARDING", "ACTIVE", "GRACE", "SUSPENDED"];
  check(
    "Every non-terminal state can jump straight to SUSPENDED",
    nonTerminalStates
      .filter((state) => state !== "SUSPENDED")
      .every((state) => isValidLifecycleTransition(state, "SUSPENDED")),
  );
  check(
    "Every non-terminal state can jump straight to ARCHIVED",
    nonTerminalStates.every((state) => isValidLifecycleTransition(state, "ARCHIVED")),
  );
  check(
    "ARCHIVED is terminal — nothing transitions out of it, not even back to ACTIVE",
    validNextLifecycleStates("ARCHIVED").length === 0 &&
      !isValidLifecycleTransition("ARCHIVED", "ACTIVE"),
  );
  check(
    "SUSPENDED cannot go directly to GRACE — recovery is to ACTIVE or a close-out to ARCHIVED only",
    !isValidLifecycleTransition("SUSPENDED", "GRACE"),
  );

  console.log("\nLifecycle transitions against the database — refused, not silently allowed, when invalid");
  const toGrace = await transitionCenterLifecycle(prisma, centerA.id, "ACTIVE");
  check(
    "transitionCenterLifecycle(ONBOARDING -> ACTIVE) succeeds and writes the new state",
    toGrace.ok && toGrace.center.lifecycleState === "ACTIVE",
    JSON.stringify(toGrace),
  );

  const invalidJump = await transitionCenterLifecycle(prisma, centerA.id, "ONBOARDING");
  check(
    "transitionCenterLifecycle(ACTIVE -> ONBOARDING) is refused — not a valid transition",
    !invalidJump.ok && invalidJump.error === "invalidTransition",
    JSON.stringify(invalidJump),
  );
  const afterInvalidJump = await prisma.center.findUnique({ where: { id: centerA.id } });
  check(
    "A refused transition leaves the stored lifecycleState unchanged",
    afterInvalidJump?.lifecycleState === "ACTIVE",
    afterInvalidJump?.lifecycleState,
  );

  const archived = await transitionCenterLifecycle(prisma, centerA.id, "ARCHIVED");
  check(
    "transitionCenterLifecycle(ACTIVE -> ARCHIVED) succeeds (a direct close-out, no SUSPENDED stopover required)",
    archived.ok && archived.center.lifecycleState === "ARCHIVED",
    JSON.stringify(archived),
  );
  const reviveAttempt = await transitionCenterLifecycle(prisma, centerA.id, "ACTIVE");
  check(
    "transitionCenterLifecycle(ARCHIVED -> ACTIVE) is refused — archiving is final",
    !reviveAttempt.ok && reviveAttempt.error === "invalidTransition",
    JSON.stringify(reviveAttempt),
  );

  const missingCenter = await transitionCenterLifecycle(prisma, "00000000-0000-0000-0000-000000000000", "ACTIVE");
  check(
    "transitionCenterLifecycle on a non-existent center reports notFound, not invalidTransition",
    !missingCenter.ok && missingCenter.error === "notFound",
    JSON.stringify(missingCenter),
  );

  // Reactivate centerA — the seeding/KPI checks below don't care about
  // lifecycle state, but there's no reason to leave a throwaway fixture in a
  // state a later assertion might trip over.
  await prisma.center.update({ where: { id: centerA.id }, data: { lifecycleState: "ACTIVE" } });

  // ── 3. Data-visibility window (M19) ──────────────────────────────────────
  const beforeWindow = await prisma.centerSettings.findUnique({ where: { centerId: centerA.id } });
  check(
    "A fresh center's windows default to 365 days (centre) and 30 days (teacher) — U6",
    beforeWindow?.centerDataVisibilityDays === 365 && beforeWindow?.teacherDataVisibilityDays === 30,
  );
  const widenedWindow = await prisma.centerSettings.update({
    where: { centerId: centerA.id },
    data: { centerDataVisibilityDays: 200, teacherDataVisibilityDays: 20 },
  });
  check(
    "Both windows are writable per-centre — the same columns both the centre's own settings and a platform admin's override write",
    widenedWindow.centerDataVisibilityDays === 200 && widenedWindow.teacherDataVisibilityDays === 20,
  );
  const override = (centre: string, teacher: string) =>
    centerVisibilityWindowSchema.safeParse({
      locale: "en",
      id: centerA.id,
      centerDataVisibilityDays: centre,
      teacherDataVisibilityDays: teacher,
    }).success;
  check(
    "The platform admin's override refuses a centre window over 365 or a teacher window over 30 (server-side caps)",
    override("365", "30") && !override("366", "30") && !override("365", "31") && !override("0", "30"),
  );
  check(
    "The override action writes both windows and audits both, before and after",
    (() => {
      const source = readSource(join(process.cwd(), "app/[locale]/(admin)/admin/centers/actions.ts"));
      return (
        /data: \{ centerDataVisibilityDays, teacherDataVisibilityDays \}/.test(source) &&
        /after: \{ centerDataVisibilityDays, teacherDataVisibilityDays \}/.test(source)
      );
    })(),
  );

  // ── 4. Seed staff/teachers/students/sessions across both centers ─────────
  async function seedCenter(centerId: string, tag: string, teacherCount: number, studentCount: number) {
    const manager = await prisma.user.create({
      data: { firstName: "M", lastName: tag, email: `admin-check-mgr-${tag}@kayedu.test`, locale: "en" },
    });
    await prisma.membership.create({
      data: { userId: manager.id, centerId, role: "MANAGER", active: true, joinedAt: new Date() },
    });

    const teacherIds: string[] = [];
    for (let i = 0; i < teacherCount; i += 1) {
      const teacher = await prisma.user.create({
        data: { firstName: "T", lastName: `${tag}${i}`, email: `admin-check-t-${tag}${i}@kayedu.test`, locale: "en" },
      });
      await prisma.membership.create({
        data: { userId: teacher.id, centerId, role: "TEACHER", active: true, joinedAt: new Date() },
      });
      teacherIds.push(teacher.id);
    }

    for (let i = 0; i < studentCount; i += 1) {
      const studentUser = await prisma.user.create({
        data: { firstName: "S", lastName: `${tag}${i}`, email: `admin-check-s-${tag}${i}@kayedu.test`, locale: "en" },
      });
      await prisma.studentProfile.create({
        data: {
          userId: studentUser.id,
          centerId,
          studentCode: `${tag}-${1000 + i}`,
          firstName: "S",
          lastName: `${tag}${i}`,
          active: true,
        },
      });
    }

    // A global catalog row (M13) — ClassGroup.subjectId references it
    // directly; no CenterCatalogSelection is needed for this script's own
    // fixture writes, since it bypasses the Server Actions entirely.
    const subject = await prisma.catalogSubject.create({
      data: { nameAr: "Admin-Check Math", nameEn: "Admin-Check Math" },
    });
    const classGroup = await prisma.classGroup.create({
      data: { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), centerId, teacherId: teacherIds[0], subjectId: subject.id, price: 10_000 },
    });
    const sessionCount = teacherCount; // arbitrary but deterministic per center
    for (let i = 0; i < sessionCount; i += 1) {
      await prisma.session.create({
        data: {
          centerId,
          classGroupId: classGroup.id,
          teacherId: teacherIds[0],
          date: new Date(),
          startTime: `${8 + i}:00`,
          endTime: `${9 + i}:00`,
          priceSnapshot: 10_000,
        },
      });
    }

    return { teacherIds, sessionCount };
  }

  const seedA = await seedCenter(centerA.id, "a", 2, 3);
  const seedB = await seedCenter(centerB.id, "b", 1, 2);

  // ── 5. Platform KPIs reconcile against the seeded data (as a delta) ──────
  const afterCenterCounts = await platformCenterCounts(prisma);
  check(
    "platformCenterCounts.total grows by exactly the two centers created here",
    afterCenterCounts.total - baselineCenterCounts.total === 2,
    JSON.stringify({ before: baselineCenterCounts, after: afterCenterCounts }),
  );
  check(
    "platformCenterCounts.operational reflects both centers (A: ACTIVE, B: still ONBOARDING) as operational",
    afterCenterCounts.operational - baselineCenterCounts.operational === 2,
    JSON.stringify({ before: baselineCenterCounts, after: afterCenterCounts }),
  );
  check(
    "platformCenterCounts.byState reconciles exactly: +1 ACTIVE (center A) and +1 ONBOARDING (center B)",
    afterCenterCounts.byState.ACTIVE - baselineCenterCounts.byState.ACTIVE === 1 &&
      afterCenterCounts.byState.ONBOARDING - baselineCenterCounts.byState.ONBOARDING === 1,
    JSON.stringify({ before: baselineCenterCounts.byState, after: afterCenterCounts.byState }),
  );

  const afterTeachers = await platformTeacherCount(prisma);
  check(
    "platformTeacherCount grows by the exact number of TEACHER memberships seeded (2 + 1)",
    afterTeachers - baselineTeachers === seedA.teacherIds.length + seedB.teacherIds.length,
    `before=${baselineTeachers} after=${afterTeachers}`,
  );

  const afterStudents = await platformStudentCount(prisma);
  check(
    "platformStudentCount grows by the exact number of StudentProfile rows seeded (3 + 2)",
    afterStudents - baselineStudents === 5,
    `before=${baselineStudents} after=${afterStudents}`,
  );

  const afterSessions = await platformSessionCount(prisma);
  check(
    "platformSessionCount grows by the exact number of Session rows seeded (2 + 1)",
    afterSessions - baselineSessions === seedA.sessionCount + seedB.sessionCount,
    `before=${baselineSessions} after=${afterSessions}`,
  );

  const trendAfter = await platformAdoptionTrend(prisma, 6);
  check(
    "platformAdoptionTrend's current-month bucket grows by exactly the two centers created just now",
    trendAfter[trendAfter.length - 1].count - baselineCurrentMonth === 2,
    JSON.stringify({ before: baselineCurrentMonth, after: trendAfter[trendAfter.length - 1] }),
  );

  // ── 6. Per-center stats are exact, regardless of global noise ────────────
  const list = await platformCenterList(prisma);
  const rowA = list.find((row) => row.id === centerA.id);
  const rowB = list.find((row) => row.id === centerB.id);
  check(
    "platformCenterList reports Center A's exact staff/teacher/student counts",
    rowA?.staffCount === 1 && rowA?.teacherCount === 2 && rowA?.studentCount === 3,
    JSON.stringify(rowA),
  );
  check(
    "platformCenterList reports Center B's exact staff/teacher/student counts, independent of A",
    rowB?.staffCount === 1 && rowB?.teacherCount === 1 && rowB?.studentCount === 2,
    JSON.stringify(rowB),
  );

  const detailA = await platformCenterDetailStats(prisma, centerA.id);
  check(
    "platformCenterDetailStats reconciles with the list row for the same center",
    detailA.staff === rowA?.staffCount &&
      detailA.teachers === rowA?.teacherCount &&
      detailA.students === rowA?.studentCount &&
      detailA.sessions === seedA.sessionCount,
    JSON.stringify({ detailA, rowA }),
  );

  // ── 7. Support access is always audited ──────────────────────────────────
  const beforeAuditCount = await prisma.auditLog.count({
    where: { centerId: centerA.id, action: "platform.support.access" },
  });
  await recordSupportAccess(prisma, { centerId: centerA.id, actorUserId: admin.id });
  const supportRow = await prisma.auditLog.findFirst({
    where: { centerId: centerA.id, action: "platform.support.access" },
    orderBy: { createdAt: "desc" },
  });
  const afterAuditCount = await prisma.auditLog.count({
    where: { centerId: centerA.id, action: "platform.support.access" },
  });
  check(
    "Every support-access view writes exactly one new AuditLog row",
    afterAuditCount - beforeAuditCount === 1,
  );
  check(
    "The AuditLog row carries the viewed center's id, the admin's id and the expected action",
    supportRow?.centerId === centerA.id &&
      supportRow?.actorUserId === admin.id &&
      supportRow?.action === "platform.support.access" &&
      supportRow?.entityType === "Center" &&
      supportRow?.entityId === centerA.id,
    JSON.stringify(supportRow),
  );

  await checkOrganizationsAndLimits(admin.id, centerA.organizationId);
  await checkPremium(admin.id, centerA.id);
}

// ── 8. F1: organizations, the branch limit, "add to an existing organization" ─

async function checkOrganizationsAndLimits(adminId: string, centerAOrganizationId: string) {
  console.log("\nF1 — organizations and their branch limit (OD-12 (a))");

  // Old → new (F1): provisioning "creates a new organization, or adds a
  // branch to an existing one within its limit". The pre-F1 call shape still
  // founds a new one-branch organization named after the branch.
  const centerAOrg = await prisma.organization.findUnique({ where: { id: centerAOrganizationId } });
  check(
    "createCenterWithSettings without an organization founds one named after the branch, limit 1",
    centerAOrg?.name === "Admin Check Center A" && centerAOrg.maxBranches === 1,
    JSON.stringify(centerAOrg),
  );

  const founded = await createCenterWithSettings(prisma, {
    name: "Admin Check F1 Founder",
    slug: SLUG_F1_FOUNDER,
    themeColor: "#2563EB",
    invite: invite("admin-check-f1-owner@kayedu.test", adminId),
    organization: { name: F1_ORG_NAME, nameEn: "F1 Org", maxBranches: 2 },
  });
  const org = founded.ok
    ? await prisma.organization.findUnique({ where: { id: founded.center.organizationId } })
    : null;
  check(
    "New organization: its own name, English name and branch limit; the founder's invitation is created",
    org?.name === F1_ORG_NAME &&
      org.nameEn === "F1 Org" &&
      org.maxBranches === 2 &&
      founded.ok &&
      (await prisma.invitation.count({ where: { centerId: founded.center.id, role: "OWNER" } })) === 1,
    JSON.stringify(org),
  );
  if (!org) throw new Error("F1 setup failed — cannot continue.");

  const added = await addBranchToOrganization(prisma, {
    organizationId: org.id,
    name: "Admin Check F1 Second",
    slug: SLUG_F1_SECOND,
    themeColor: "#16A34A",
  });
  check(
    "Add to an existing organization under its limit: the branch joins it, starts ONBOARDING, gets the full baseline and invites nobody",
    added.ok &&
      added.center.organizationId === org.id &&
      added.center.lifecycleState === "ONBOARDING" &&
      hasFullBaseline(await centerBaselineGaps(prisma, added.center.id)) &&
      (await prisma.invitation.count({ where: { centerId: added.center.id } })) === 0,
    JSON.stringify(added),
  );

  const full = await addBranchToOrganization(prisma, {
    organizationId: org.id,
    name: "Admin Check F1 Third",
    slug: SLUG_F1_THIRD,
    themeColor: "#16A34A",
  });
  check(
    "At the limit the admin's add is refused branchLimitReached, and nothing is created",
    !full.ok && full.error === "branchLimitReached" && (await prisma.center.count({ where: { slug: SLUG_F1_THIRD } })) === 0,
    JSON.stringify(full),
  );
  const unknownOrg = await addBranchToOrganization(prisma, {
    organizationId: "00000000-0000-0000-0000-000000000000",
    name: "Admin Check F1 Nowhere",
    slug: SLUG_F1_THIRD,
    themeColor: "#16A34A",
  });
  check("An unknown organization is refused organizationNotFound", !unknownOrg.ok && unknownOrg.error === "organizationNotFound");
  const takenSlug = await addBranchToOrganization(prisma, {
    organizationId: org.id,
    name: "Admin Check F1 Dup",
    slug: SLUG_F1_SECOND,
    themeColor: "#16A34A",
  });
  check("A taken slug is refused slugTaken", !takenSlug.ok && takenSlug.error === "slugTaken");

  // The limit editor: platform admin only (the action's requirePlatformAdmin),
  // validated and audited here with no centre and numbers only.
  const invalid = await updateOrganizationBranchLimit(prisma, { organizationId: org.id, maxBranches: 0, actorUserId: adminId });
  check("A limit below 1 is refused invalidLimit", !invalid.ok && invalid.error === "invalidLimit");
  const raised = await updateOrganizationBranchLimit(prisma, { organizationId: org.id, maxBranches: 3, actorUserId: adminId });
  const limitAudit = await prisma.auditLog.findFirst({
    where: { action: "platform.organization.limit.update", entityId: org.id },
    orderBy: { createdAt: "desc" },
  });
  check(
    "Raising the limit is audited platform.organization.limit.update — centerId null, before/after numbers only",
    raised.ok &&
      limitAudit?.centerId === null &&
      limitAudit.actorUserId === adminId &&
      limitAudit.entityType === "Organization" &&
      JSON.stringify(limitAudit.before) === JSON.stringify({ maxBranches: 2 }) &&
      JSON.stringify(limitAudit.after) === JSON.stringify({ maxBranches: 3 }),
    JSON.stringify(limitAudit),
  );
  const third = await addBranchToOrganization(prisma, {
    organizationId: org.id,
    name: "Admin Check F1 Third",
    slug: SLUG_F1_THIRD,
    themeColor: "#16A34A",
  });
  check("Once the limit is raised, the same add succeeds", third.ok);

  const lowered = await updateOrganizationBranchLimit(prisma, { organizationId: org.id, maxBranches: 1, actorUserId: adminId });
  const fourth = await addBranchToOrganization(prisma, {
    organizationId: org.id,
    name: "Admin Check F1 Fourth",
    slug: SLUG_F1_FOURTH,
    themeColor: "#16A34A",
  });
  check(
    "Lowering the limit below the current count is allowed, removes nothing, and only blocks new branches",
    lowered.ok &&
      (await prisma.center.count({ where: { organizationId: org.id } })) === 3 &&
      !fourth.ok &&
      fourth.error === "branchLimitReached",
  );

  const rows = await platformOrganizationList(prisma);
  const row = rows.find((item) => item.id === org.id);
  check(
    "platformOrganizationList reports the organization's usage against its limit",
    row?.usedBranches === 3 && row.totalBranches === 3 && row.maxBranches === 1,
    JSON.stringify(row),
  );
  const branchesOfOrg = await platformCenterList(prisma, org.id);
  check(
    "platformCenterList(db, organizationId) lists exactly that organization's branches",
    branchesOfOrg.length === 3 && branchesOfOrg.every((branch) => [SLUG_F1_FOUNDER, SLUG_F1_SECOND, SLUG_F1_THIRD].includes(branch.slug)),
  );

  // The create form's schema: two modes, the pre-F1 post still a new organization.
  const legacy = createCenterSchema.safeParse({ locale: "en", name: "X", slug: "x-legacy", themeColor: "#2563EB", ownerEmail: "o@kayedu.test" });
  const existingNoOwner = createCenterSchema.safeParse({
    locale: "en",
    name: "X",
    slug: "x-existing",
    themeColor: "#2563EB",
    organizationMode: "existing",
    organizationId: org.id,
  });
  const newNoOwner = createCenterSchema.safeParse({ locale: "en", name: "X", slug: "x-new", themeColor: "#2563EB", organizationMode: "new" });
  check(
    "createCenterSchema: a post without a mode is a new organization (limit 1); existing needs no owner; new still needs one",
    legacy.success &&
      legacy.data.organizationMode === "new" &&
      legacy.data.maxBranches === 1 &&
      existingNoOwner.success &&
      !newNoOwner.success,
  );
}

// ── 9. W6 (D-W35): premium — the predicate, the date rules, admin-only writes ─

const PREMIUM_TARGET_EMAIL = "admin-check-premium-target@kayedu.test";
const PREMIUM_AUDIT_PREFIX = "platform.premium.";

/** Every source file under `dir` (relative to the repo root), node_modules and .next skipped. */
function sourceFiles(dir: string): string[] {
  const root = process.cwd();
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function checkPremium(adminId: string, centerId: string) {
  console.log("\nW6 — premium (D-W14, D-W35)");

  // ── 9a. The predicate, at the boundary instant — no job involved ──────────
  const now = new Date("2026-11-07T10:00:00.000Z");
  check("isPremium: premiumUntil equal to now is NOT premium", !isPremium({ premiumUntil: new Date(now) }, now));
  check("isPremium: one millisecond after now is premium", isPremium({ premiumUntil: new Date(now.getTime() + 1) }, now));
  check("isPremium: a past date is not premium", !isPremium({ premiumUntil: new Date(now.getTime() - 86_400_000) }, now));
  check("isPremium: null (never premium) is not premium", !isPremium({ premiumUntil: null }, now) && !isPremium(null, now));

  // ── 9b. The end-date rule, in Cairo ───────────────────────────────────────
  const today = premiumToday(now);
  const plus = (days: number) => dateKey(addDays(dayMarker(today), days));
  check("End date: today is allowed", premiumEndDayError(today, now) === null);
  check("End date: yesterday is refused (dateInPast)", premiumEndDayError(plus(-1), now) === "dateInPast");
  check("End date: exactly 400 days ahead is allowed (the boundary)", premiumEndDayError(plus(PREMIUM_MAX_DAYS_AHEAD), now) === null && PREMIUM_MAX_DAYS_AHEAD === 400);
  check("End date: 401 days ahead is refused (dateTooFar)", premiumEndDayError(plus(401), now) === "dateTooFar");
  check(
    "End date: not a real day is refused (invalidDate)",
    premiumEndDayError("2026-02-30", now) === "invalidDate" && premiumEndDayError("31/12/2026", now) === "invalidDate",
  );
  // 22:30 UTC on 7 Nov is 00:30 on 8 Nov in Cairo: "today" is the Cairo day.
  const lateNight = new Date("2026-11-07T22:30:00.000Z");
  check("Today is the Cairo day, not the UTC day", premiumToday(lateNight) === "2026-11-08" && premiumEndDayError("2026-11-07", lateNight) === "dateInPast");
  check(
    "An end day ends at the following Cairo midnight (winter UTC+2, summer UTC+3)",
    premiumUntilForDay("2026-12-31").toISOString() === "2026-12-31T22:00:00.000Z" &&
      premiumUntilForDay("2026-07-15").toISOString() === "2026-07-15T21:00:00.000Z",
    `${premiumUntilForDay("2026-12-31").toISOString()} ${premiumUntilForDay("2026-07-15").toISOString()}`,
  );
  check(
    "premiumEndDay reads the stored instant back as the picked day",
    ["2026-01-01", "2026-04-24", "2026-07-15", "2026-10-30", "2026-12-31"].every((day) => premiumEndDay(premiumUntilForDay(day)) === day),
  );
  const endsToday = premiumUntilForDay(today);
  check("The picked day itself is still premium at its last minute in Cairo", isPremium({ premiumUntil: endsToday }, new Date(endsToday.getTime() - 60_000)));
  check("…and not at its end", !isPremium({ premiumUntil: endsToday }, endsToday));

  // ── 9c. What the card and the admin page show ─────────────────────────────
  const soon = premiumStatus(premiumUntilForDay(plus(PREMIUM_ENDING_SOON_DAYS)), now);
  const notSoon = premiumStatus(premiumUntilForDay(plus(PREMIUM_ENDING_SOON_DAYS + 1)), now);
  const lastDay = premiumStatus(premiumUntilForDay(today), now);
  const expired = premiumStatus(premiumUntilForDay(plus(-3)), now);
  check("Status: null is Not premium", premiumStatus(null, now).kind === "none");
  check(
    `Status: ${PREMIUM_ENDING_SOON_DAYS} days left is "ending soon", ${PREMIUM_ENDING_SOON_DAYS + 1} is not (one constant, 14)`,
    PREMIUM_ENDING_SOON_DAYS === 14 &&
      soon.kind === "active" && soon.daysLeft === 14 && soon.endingSoon &&
      notSoon.kind === "active" && notSoon.daysLeft === 15 && !notSoon.endingSoon,
    JSON.stringify({ soon, notSoon }),
  );
  check("Status: the last day reads 0 days left", lastDay.kind === "active" && lastDay.daysLeft === 0 && lastDay.endDay === today);
  check("Status: a past end is Expired on that day", expired.kind === "expired" && expired.endDay === plus(-3));

  // ── 9d. Fixtures: the account, and one actor per non-admin role ───────────
  const target = await prisma.user.create({
    data: { firstName: "Premium", lastName: "Target", email: PREMIUM_TARGET_EMAIL, locale: "en" },
  });
  const makeUser = (key: string) =>
    prisma.user.create({ data: { firstName: "Admin", lastName: `Check ${key}`, email: `admin-check-premium-${key}@kayedu.test`, locale: "en" } });
  const actors: { label: string; id: string | null }[] = [{ label: "no actor", id: null }];
  actors.push({ label: "an account with no relation", id: (await makeUser("bare")).id });
  for (const role of ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "TEACHER"] as const) {
    const user = await makeUser(role.toLowerCase());
    await prisma.membership.create({ data: { userId: user.id, centerId, role } });
    actors.push({ label: `a centre ${role}`, id: user.id });
  }
  const student = await makeUser("student");
  await prisma.studentProfile.create({ data: { userId: student.id, centerId, studentCode: "ADMIN-CHECK-1" } });
  actors.push({ label: "a student", id: student.id });
  const parent = await makeUser("parent");
  await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: student.id, status: "ACTIVE", source: "STUDENT_INVITE" } });
  actors.push({ label: "a parent", id: parent.id });

  const auditCount = () => prisma.auditLog.count({ where: { action: { startsWith: PREMIUM_AUDIT_PREFIX }, entityId: target.id } });
  const premiumOf = async () => (await prisma.user.findUniqueOrThrow({ where: { id: target.id }, select: { premiumUntil: true } })).premiumUntil;

  // ── 9e. Every non-admin is refused on lookup, grant, extend and revoke ────
  // Give the target a live period first, so extend and revoke would have
  // something to change if the refusal were missing.
  await prisma.user.update({ where: { id: target.id }, data: { premiumUntil: premiumUntilForDay(plus(30)) } });
  const before = await premiumOf();
  const auditsBefore = await auditCount();
  for (const actor of actors) {
    const lookup = await findPremiumAccountByEmail(prisma, { actorUserId: actor.id, email: PREMIUM_TARGET_EMAIL });
    const unknown = await findPremiumAccountByEmail(prisma, { actorUserId: actor.id, email: "admin-check-nobody@kayedu.test" });
    const byId = await findPremiumAccountById(prisma, { actorUserId: actor.id, userId: target.id });
    const grant = await grantPremium(prisma, { actorUserId: actor.id, userId: target.id, endDay: plus(60) });
    const extend = await extendPremium(prisma, { actorUserId: actor.id, userId: target.id, endDay: plus(60) });
    const revoke = await revokePremium(prisma, { actorUserId: actor.id, userId: target.id });
    const refused = [lookup, unknown, byId, grant, extend, revoke].every((result) => !result.ok && result.error === "forbidden");
    check(`${actor.label}: lookup (known and unknown email), grant, extend and revoke are all forbidden`, refused);
  }
  check("…and nothing changed: the end date and the audit trail are untouched", (await premiumOf())?.getTime() === before?.getTime() && (await auditCount()) === auditsBefore);
  // A refused write is refused before any date check: no hint about the rules either.
  const refusedBadDate = await grantPremium(prisma, { actorUserId: actors[1].id, userId: target.id, endDay: "not-a-date" });
  check("A non-admin with a bad date still gets forbidden, not a date error", !refusedBadDate.ok && refusedBadDate.error === "forbidden");

  await prisma.user.update({ where: { id: target.id }, data: { premiumUntil: null } });

  // ── 9f. Lookup: exact email only, one neutral answer ──────────────────────
  const exact = await findPremiumAccountByEmail(prisma, { actorUserId: adminId, email: `  ${PREMIUM_TARGET_EMAIL.toUpperCase()}  ` });
  check("Lookup is case-insensitive and trimmed", exact.ok && exact.account?.userId === target.id && exact.account.premiumUntil === null);
  const partial = await findPremiumAccountByEmail(prisma, { actorUserId: adminId, email: "admin-check-premium-target" });
  const domainOnly = await findPremiumAccountByEmail(prisma, { actorUserId: adminId, email: "@kayedu.test" });
  const nobody = await findPremiumAccountByEmail(prisma, { actorUserId: adminId, email: "admin-check-nobody@kayedu.test" });
  check(
    "Part of an email finds nobody, and an unknown email gets the same answer (account: null)",
    partial.ok && partial.account === null && domainOnly.ok && domainOnly.account === null && nobody.ok && nobody.account === null &&
      JSON.stringify(partial) === JSON.stringify(nobody),
  );
  const blank = await findPremiumAccountByEmail(prisma, { actorUserId: adminId, email: "   " });
  check("A blank email matches nobody (never the accounts without an email)", blank.ok && blank.account === null);
  check(
    "The lookup schema needs an email and keeps it whole",
    !premiumLookupSchema.safeParse({ locale: "en", email: "  " }).success &&
      premiumLookupSchema.safeParse({ locale: "en", email: PREMIUM_TARGET_EMAIL }).success,
  );

  // ── 9g. Grant, extend, revoke — the date rules and the state rules ────────
  const pastGrant = await grantPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: plus(-1) });
  const farGrant = await grantPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: plus(401) });
  const extendNone = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: plus(10) });
  const revokeNone = await revokePremium(prisma, { actorUserId: adminId, userId: target.id });
  const missing = await grantPremium(prisma, { actorUserId: adminId, userId: "00000000-0000-4000-8000-000000000000", endDay: plus(10) });
  check(
    "Grant: a past date and a date 401 days ahead are refused; extend and revoke refuse a non-premium account; an unknown id is accountNotFound",
    !pastGrant.ok && pastGrant.error === "dateInPast" &&
      !farGrant.ok && farGrant.error === "dateTooFar" &&
      !extendNone.ok && extendNone.error === "notPremium" &&
      !revokeNone.ok && revokeNone.error === "notPremium" &&
      !missing.ok && missing.error === "accountNotFound",
    JSON.stringify({ pastGrant, farGrant, extendNone, revokeNone, missing }),
  );
  check("…and none of them wrote anything", (await premiumOf()) === null && (await auditCount()) === auditsBefore);
  check(
    "The grant schema refuses a past date and 401 days at the form too",
    !premiumGrantSchema.safeParse({ locale: "en", userId: target.id, endDay: premiumToday(new Date(Date.now() - 2 * 86_400_000)) }).success &&
      premiumGrantSchema.safeParse({ locale: "en", userId: target.id, endDay: premiumToday() }).success,
  );

  const realNow = new Date();
  const realPlus = (days: number) => dateKey(addDays(dayMarker(premiumToday(realNow)), days));
  const granted = await grantPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(30) });
  check(
    "Grant stores the end of that day in Cairo, and the account is premium on the next read",
    granted.ok &&
      granted.account.premiumUntil?.toISOString() === premiumUntilForDay(realPlus(30)).toISOString() &&
      isPremium({ premiumUntil: await premiumOf() }),
    JSON.stringify(granted),
  );
  const grantAgain = await grantPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(60) });
  check("Grant on a premium account is refused (alreadyPremium) — extend it instead", !grantAgain.ok && grantAgain.error === "alreadyPremium");

  const extendSame = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(30) });
  const extendEarlier = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(10) });
  const extendFar = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(401) });
  check(
    "Extend must be later: the same day and an earlier day are notLater; 401 days is dateTooFar",
    !extendSame.ok && extendSame.error === "notLater" &&
      !extendEarlier.ok && extendEarlier.error === "notLater" &&
      !extendFar.ok && extendFar.error === "dateTooFar",
  );
  const extended = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(PREMIUM_MAX_DAYS_AHEAD) });
  check(
    "Extend to exactly 400 days ahead succeeds",
    extended.ok && extended.account.premiumUntil?.toISOString() === premiumUntilForDay(realPlus(PREMIUM_MAX_DAYS_AHEAD)).toISOString(),
  );

  const premiumGate = await requirePremium(prisma, target.id);
  check("requirePremium passes a premium account (one with no centre relation at all)", premiumGate.ok);

  const revoked = await revokePremium(prisma, { actorUserId: adminId, userId: target.id });
  check("Revoke sets premiumUntil to null", revoked.ok && revoked.account.premiumUntil === null && (await premiumOf()) === null);
  const revokeAgain = await revokePremium(prisma, { actorUserId: adminId, userId: target.id });
  check("Revoke twice: the second is notPremium and writes nothing", !revokeAgain.ok && revokeAgain.error === "notPremium");

  // An expired period: not premium, extend refused, a new grant allowed.
  await prisma.user.update({ where: { id: target.id }, data: { premiumUntil: new Date(realNow.getTime() - 60_000) } });
  const extendExpired = await extendPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(10) });
  check("An expired account is not premium, and extend refuses it (notPremium)", !isPremium({ premiumUntil: await premiumOf() }) && !extendExpired.ok && extendExpired.error === "notPremium");
  const lapsedGate = await requirePremium(prisma, target.id);
  check("requirePremium refuses an expired account with premiumRequired", !lapsedGate.ok && lapsedGate.error === "premiumRequired");
  const renewed = await grantPremium(prisma, { actorUserId: adminId, userId: target.id, endDay: realPlus(5) });
  check("Grant renews an expired account", renewed.ok && isPremium({ premiumUntil: await premiumOf() }));
  const revokedAgain = await revokePremium(prisma, { actorUserId: adminId, userId: target.id });
  check("…and revoke ends it again", revokedAgain.ok);

  // ── 9h. requirePremium ────────────────────────────────────────────────────
  const noneGate = await requirePremium(prisma, target.id);
  const unknownGate = await requirePremium(prisma, "00000000-0000-4000-8000-000000000000");
  check(
    "requirePremium refuses a never-premium and an unknown account with the typed premiumRequired",
    !noneGate.ok && noneGate.error === "premiumRequired" && !unknownGate.ok && unknownGate.error === "premiumRequired",
  );
  const boundary = premiumUntilForDay(realPlus(1));
  await prisma.user.update({ where: { id: target.id }, data: { premiumUntil: boundary } });
  const atBoundary = await requirePremium(prisma, target.id, boundary);
  const justBefore = await requirePremium(prisma, target.id, new Date(boundary.getTime() - 1));
  check("requirePremium at the boundary: refused at premiumUntil, passes 1 ms before", !atBoundary.ok && justBefore.ok);
  await prisma.user.update({ where: { id: target.id }, data: { premiumUntil: null } });

  // ── 9i. Audit rows: ids and the new end date only ─────────────────────────
  const rows = await prisma.auditLog.findMany({
    where: { action: { startsWith: PREMIUM_AUDIT_PREFIX }, entityId: target.id },
    orderBy: { createdAt: "asc" },
  });
  const actions = rows.map((row) => row.action);
  check(
    "Each write wrote exactly one row: grant, extend, revoke, grant, revoke",
    JSON.stringify(actions) ===
      JSON.stringify([PREMIUM_AUDIT_ACTIONS.grant, PREMIUM_AUDIT_ACTIONS.extend, PREMIUM_AUDIT_ACTIONS.revoke, PREMIUM_AUDIT_ACTIONS.grant, PREMIUM_AUDIT_ACTIONS.revoke]),
    JSON.stringify(actions),
  );
  check(
    "Every row: no centre, the admin as actor, the User as entity",
    rows.length === 5 && rows.every((row) => row.centerId === null && row.actorUserId === adminId && row.entityType === "User" && row.entityId === target.id),
  );
  const expectedAfter = [
    premiumUntilForDay(realPlus(30)).toISOString(),
    premiumUntilForDay(realPlus(PREMIUM_MAX_DAYS_AHEAD)).toISOString(),
    null,
    premiumUntilForDay(realPlus(5)).toISOString(),
    null,
  ];
  check(
    "Every row carries the new end date only ({ premiumUntil }) and no before",
    rows.every((row, index) => row.before === null && JSON.stringify(row.after) === JSON.stringify({ premiumUntil: expectedAfter[index] })),
    JSON.stringify(rows.map((row) => [row.before, row.after])),
  );
  const serialised = JSON.stringify(rows);
  check(
    "No row carries an email or a name",
    !serialised.includes("@") && !serialised.toLowerCase().includes(PREMIUM_TARGET_EMAIL) && !serialised.includes("Premium Target") &&
      rows.every((row) => forbiddenAuditKey(row.after) === null && forbiddenAuditKey(row.before) === null),
  );

  // ── 9j. Statics: admin-only by nav and action, and nothing gated yet ──────
  const navKeys = navForExperience("admin", "PLATFORM_ADMIN").map((item) => item.labelKey);
  check('The admin nav has "premium" (Teachers), linking /admin/teachers', navKeys.includes("premium") &&
    navForExperience("admin", "PLATFORM_ADMIN").some((item) => item.labelKey === "premium" && item.href === "/admin/teachers"));
  const otherNavs = (["center", "teacher", "student", "parent"] as const).flatMap((experience) =>
    (["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "TEACHER", "STUDENT", "PARENT"] as const).map((role) => navForExperience(experience, role)),
  );
  check("No other experience's nav links /admin/teachers", otherNavs.every((nav) => nav.every((item) => item.href !== "/admin/teachers")));

  const actionsSource = stripComments(readSource(join(process.cwd(), "app/[locale]/(admin)/admin/teachers/actions.ts")));
  const exported = [...actionsSource.matchAll(/export async function (\w+)\([\s\S]*?\{([\s\S]*?)\n\}/g)];
  check(
    "Every Teachers action starts with requirePlatformAdmin()",
    exported.length === 4 && exported.every(([, , body]) => /^\s*const admin = await requirePlatformAdmin\(\);/.test(body)),
    exported.map(([, name]) => name).join(", "),
  );
  const pageSource = stripComments(readSource(join(process.cwd(), "app/[locale]/(admin)/admin/teachers/page.tsx")));
  check("The Teachers page calls requirePlatformAdmin()", /await requirePlatformAdmin\(\)/.test(pageSource));

  const files = ["app", "components", "lib"].flatMap((dir) => sourceFiles(dir));
  const callers = files.filter((file) => file !== "lib/auth/premium.ts" && /\brequirePremium\s*\(/.test(stripComments(readSource(join(process.cwd(), file)))));
  // W7a old → new (the W7a prompt's allowed change): "no caller outside the tests"
  // → "called only from the assistant invite and permission actions".
  // W8a old → new (the W8a prompt's allowed change): → "the assistants and
  // workspace actions" — lib/db/assistants.ts and lib/db/workspaces.ts.
  check(
    "requirePremium is called only from the assistant and workspace actions (W7a, W8a)",
    callers.length === 2 && callers.includes("lib/db/assistants.ts") && callers.includes("lib/db/workspaces.ts"),
    callers.join(", "),
  );
  const writers = files.filter((file) => /data:\s*\{[^}]*\bpremiumUntil\b/.test(stripComments(readSource(join(process.cwd(), file)))));
  check("Only lib/db/premium.ts writes User.premiumUntil", writers.length === 1 && writers[0] === "lib/db/premium.ts", writers.join(", "));
  const deciders = files.filter((file) => file !== "lib/auth/premium.ts" && /premiumUntil\??\.getTime\(\)|premiumUntil\s*[<>]=?|[<>]=?\s*\w*\.premiumUntil/.test(stripComments(readSource(join(process.cwd(), file)))));
  check("Nothing outside lib/auth/premium.ts (and the writer's notLater rule) compares premiumUntil with a time", deciders.every((file) => file === "lib/db/premium.ts"), deciders.join(", "));
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
      console.error(`\n${failures} admin check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll admin checks passed.");
  });
