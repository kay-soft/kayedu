-- M12: the permission matrix, cross-branch grants, and retiring the two
-- CenterSettings boolean grants + the unread Membership.canSeeEarnings
-- (docs/03-build-order.md M12, docs/02-architecture.md §6.1).
--
-- This is a live-behavior-preserving migration, not a reset: it backfills
-- PermissionGrant rows that reproduce *today's* effective permissions (the
-- pre-M12 hardcoded Record<TenantRole, Permission[]> in lib/auth/permissions.ts,
-- plus whatever the two CenterSettings booleans had actually granted) for
-- every existing Center, before removing the code path and columns they came
-- from. ACCOUNTANT is new at M12, so it gets a fresh baseline instead of a
-- backfilled one.

-- ── 1. PermissionGrant ──────────────────────────────────────────────────────
CREATE TABLE "PermissionGrant" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PermissionGrant_centerId_role_action_key" ON "PermissionGrant"("centerId", "role", "action");
CREATE INDEX "PermissionGrant_centerId_idx" ON "PermissionGrant"("centerId");

ALTER TABLE "PermissionGrant" ADD CONSTRAINT "PermissionGrant_centerId_fkey"
    FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. MembershipBranchGrant ─────────────────────────────────────────────────
CREATE TABLE "MembershipBranchGrant" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipBranchGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipBranchGrant_membershipId_centerId_key" ON "MembershipBranchGrant"("membershipId", "centerId");
CREATE INDEX "MembershipBranchGrant_membershipId_idx" ON "MembershipBranchGrant"("membershipId");
CREATE INDEX "MembershipBranchGrant_centerId_idx" ON "MembershipBranchGrant"("centerId");

ALTER TABLE "MembershipBranchGrant" ADD CONSTRAINT "MembershipBranchGrant_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipBranchGrant" ADD CONSTRAINT "MembershipBranchGrant_centerId_fkey"
    FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Backfill: reproduce today's effective permissions as matrix rows ─────
-- OWNER and MANAGER share the pre-M12 MANAGER_PERMISSIONS baseline.
-- center.ownership.manage is deliberately not seeded here: it is forced true
-- for OWNER in code regardless of any row, and forbidden to every other role
-- regardless of any row (lib/auth/permissions.ts's grantable ceiling), so a
-- stored row for it would be redundant at best and misleading at worst.
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", r."role"::"Role", a."action", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES ('OWNER'), ('MANAGER')) AS r("role")
CROSS JOIN (VALUES
    ('center.settings.edit'), ('center.branding.edit'), ('center.profit.view'),
    ('staff.invite'), ('staff.manage'), ('teacher.manage'), ('teacher.delete'),
    ('student.manage'), ('student.delete'), ('student.promote'), ('student.block'),
    ('class.manage'), ('class.delete'), ('session.manage'), ('session.cancel'),
    ('session.view'), ('reception.use'), ('attendance.record'), ('attendance.correct'),
    ('payment.record'), ('payment.void'), ('expense.manage'), ('analytics.center.view'),
    ('approvals.manage'), ('audit.view')
) AS a("action");

-- RECEPTIONIST's pre-M12 baseline (ROLE_PERMISSIONS.RECEPTIONIST).
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", 'RECEPTIONIST'::"Role", a."action", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES
    ('reception.use'), ('session.view'), ('attendance.record'),
    ('payment.record'), ('student.manage')
) AS a("action");

-- RECEPTIONIST's two conditional settings-driven grants — only where a
-- centre had actually turned them on (the retired permissionGrantsFromSettings()).
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), cs."centerId", 'RECEPTIONIST'::"Role", 'center.profit.view', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CenterSettings" cs
WHERE cs."receptionistCanViewProfit" = true;

INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), cs."centerId", 'RECEPTIONIST'::"Role", 'attendance.correct', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CenterSettings" cs
WHERE cs."receptionistCanCorrectAttendance" = true;

-- TEACHER's pre-M12 baseline.
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", 'TEACHER'::"Role", a."action", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES
    ('analytics.own.view'), ('changeRequest.create'), ('student.block')
) AS a("action");

-- ACCOUNTANT is new at M12 (docs/00-master-product-spec.md §3) — a fresh
-- baseline, not a backfilled one: analytics + expenses, nothing else.
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", 'ACCOUNTANT'::"Role", a."action", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES ('analytics.center.view'), ('expense.manage')) AS a("action");

-- ── 4. Retire the two CenterSettings boolean grants ─────────────────────────
ALTER TABLE "CenterSettings" DROP COLUMN "receptionistCanViewProfit";
ALTER TABLE "CenterSettings" DROP COLUMN "receptionistCanCorrectAttendance";

-- ── 5. Retire the unread Membership.canSeeEarnings ─────────────────────────
ALTER TABLE "Membership" DROP COLUMN "canSeeEarnings";
