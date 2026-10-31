import type { Prisma, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:branches` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/platform.ts).
import { baselineGrantKeys } from "./provision.ts";
import type { BranchCopyKey } from "../branch-setup.ts";

/**
 * "Copy setup from <branch>" (F1). Since U5 only a platform admin adds a
 * branch — the Owner's Settings → Branches and its `addBranchAsOwner` are
 * gone — so the one caller is the admin's "Add to an existing organization"
 * (`lib/db/platform.ts`'s `addBranchToOrganization`), on its transaction.
 */

/**
 * Copies the ticked setup from one branch to a branch created in this same
 * transaction. **Never copied**, by construction — nothing here reads them:
 * rooms, classes, sessions, people (memberships, students, invitations),
 * money (payments, refunds, settlements, expenses and their categories), the
 * ID-card layout and the logo. Returns the keys it applied, for the audit row.
 */
export async function copyBranchSetup(
  tx: Prisma.TransactionClient,
  fromCenterId: string,
  toCenterId: string,
  keys: readonly BranchCopyKey[],
): Promise<BranchCopyKey[]> {
  const wanted = new Set(keys);
  const applied: BranchCopyKey[] = [];

  if (wanted.has("catalog")) {
    // The picks with the centre's own renames and base prices (M13, R8).
    const selections = await tx.centerCatalogSelection.findMany({
      where: { centerId: fromCenterId, active: true },
    });
    if (selections.length > 0) {
      await tx.centerCatalogSelection.createMany({
        data: selections.map((row) => ({
          centerId: toCenterId,
          kind: row.kind,
          educationSystemId: row.educationSystemId,
          gradeId: row.gradeId,
          subjectId: row.subjectId,
          displayNameAr: row.displayNameAr,
          displayNameEn: row.displayNameEn,
          basePrice: row.basePrice,
        })),
        skipDuplicates: true,
      });
    }
    applied.push("catalog");
  }

  if (wanted.has("paymentMethods")) {
    // Replace the defaults the baseline just wrote — nothing references them
    // yet — with the source's active methods. A branch always keeps one
    // active method (R1); the source has one by the same rule, and when it
    // somehow has none the defaults stay.
    const methods = await tx.centerPaymentMethod.findMany({
      where: { centerId: fromCenterId, active: true },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    });
    if (methods.length > 0) {
      await tx.centerPaymentMethod.deleteMany({ where: { centerId: toCenterId } });
      await tx.centerPaymentMethod.createMany({
        data: methods.map((method) => ({ centerId: toCenterId, name: method.name })),
      });
    }
    applied.push("paymentMethods");
  }

  if (wanted.has("terms")) {
    // Presets only — a class copies a term's dates, never links to it (R4).
    const terms = await tx.centerTerm.findMany({
      where: { centerId: fromCenterId, active: true },
      select: { name: true, startDate: true, endDate: true },
    });
    if (terms.length > 0) {
      await tx.centerTerm.createMany({
        data: terms.map((term) => ({ ...term, centerId: toCenterId })),
      });
    }
    applied.push("terms");
  }

  if (wanted.has("holidays")) {
    const holidays = await tx.holiday.findMany({
      where: { centerId: fromCenterId },
      select: { date: true, name: true },
    });
    if (holidays.length > 0) {
      await tx.holiday.createMany({
        data: holidays.map((holiday) => ({ ...holiday, centerId: toCenterId })),
        skipDuplicates: true,
      });
    }
    applied.push("holidays");
  }

  if (wanted.has("permissions")) {
    // The new branch behaves exactly as the source does: every stored cell
    // is copied, and a baseline cell the source has no row for (denied there)
    // is stored as denied here — so the new branch has no baseline gap
    // (`centerBaselineGaps`) and grants nothing the source does not.
    const rows = await tx.permissionGrant.findMany({
      where: { centerId: fromCenterId },
      select: { role: true, action: true, allowed: true },
    });
    const writes = new Map<string, { role: Role; action: string; allowed: boolean }>();
    for (const key of baselineGrantKeys()) {
      const [role, action] = key.split(":") as [Role, string];
      writes.set(key, { role, action, allowed: false });
    }
    for (const row of rows) writes.set(`${row.role}:${row.action}`, row);
    for (const write of writes.values()) {
      await tx.permissionGrant.upsert({
        where: { centerId_role_action: { centerId: toCenterId, role: write.role, action: write.action } },
        update: { allowed: write.allowed },
        create: { centerId: toCenterId, role: write.role, action: write.action, allowed: write.allowed },
      });
    }
    applied.push("permissions");
  }

  if (wanted.has("generalSettings")) {
    const settings = await tx.centerSettings.findUnique({ where: { centerId: fromCenterId } });
    if (settings) {
      await tx.centerSettings.update({
        where: { centerId: toCenterId },
        data: {
          defaultShareType: settings.defaultShareType,
          defaultShareValue: settings.defaultShareValue,
          defaultLateThreshold: settings.defaultLateThreshold,
          scheduleConflictPolicy: settings.scheduleConflictPolicy,
          centerDataVisibilityDays: settings.centerDataVisibilityDays,
          teacherDataVisibilityDays: settings.teacherDataVisibilityDays,
          // Deprecated (U6), copied only until it is dropped (backlog).
          dataVisibilityDays: settings.dataVisibilityDays,
          teacherEditDeadlineHours: settings.teacherEditDeadlineHours,
        },
      });
    }
    applied.push("generalSettings");
  }

  return applied;
}
