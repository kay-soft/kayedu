import { getTranslations } from "next-intl/server";
import type { Role } from "@prisma/client";

import { PermissionMatrixForm } from "@/app/[locale]/(center)/settings/permissions/permissions-form";
import { SectionHeader } from "@/components/shared/section-header";
import {
  MATRIX_ROLES,
  PERMISSIONS,
  editableActionsFor,
  type Permission,
} from "@/lib/auth/permissions";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { listPermissionGrants } from "@/lib/db/permissions";

/**
 * The action × role matrix (M12, docs/02-architecture.md §6.1) — OWNER only,
 * by this `requirePermission` **and** by `savePermissionMatrixAction`'s own
 * check: `permission.manage` is one of the ceiling-forced ownership actions
 * (`lib/auth/permissions.ts`), so nothing short of actually being OWNER ever
 * satisfies it.
 */
export default async function PermissionsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "permission.manage");

  const rows = await listPermissionGrants(prisma, ctx.center.id);
  const allowed = new Set(
    rows.filter((row) => row.allowed).map((row) => `${row.role}__${row.action}`),
  );

  const t = await getTranslations("Settings.permissions");

  const editableByRole = new Map<Role, Set<Permission>>(
    MATRIX_ROLES.map((role) => [role, new Set(editableActionsFor(role))]),
  );
  // One row per action that is editable for at least one matrix role — an
  // action editable for none of them (e.g. it has no grantable role at all)
  // would just be an empty row.
  const actions = PERMISSIONS.filter((action) =>
    MATRIX_ROLES.some((role) => editableByRole.get(role)!.has(action)),
  );

  const editableByRolePlain: Record<string, Permission[]> = {};
  const checked: Record<string, boolean> = {};
  for (const role of MATRIX_ROLES) {
    editableByRolePlain[role] = [...editableByRole.get(role)!];
    for (const action of actions) {
      checked[`${role}__${action}`] = allowed.has(`${role}__${action}`);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <PermissionMatrixForm
        roles={[...MATRIX_ROLES]}
        actions={actions}
        editableByRole={editableByRolePlain}
        checked={checked}
      />
    </div>
  );
}
