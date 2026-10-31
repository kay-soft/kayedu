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
import { centerVisibilityWindowSchema, createCenterSchema } from "../lib/validation/admin.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";

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
      const source = readFileSync(join(process.cwd(), "app/[locale]/(admin)/admin/centers/actions.ts"), "utf8");
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
