import { getTranslations } from "next-intl/server";

import {
  createBranchAction,
  deleteBranchAction,
  toggleBranchAction,
  updateBranchAction,
} from "@/app/[locale]/(center)/settings/actions";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";

export default async function BranchesPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "center.settings.edit");

  const t = await getTranslations("Settings.branches");
  const branches = await scoped(ctx).branches.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "address",
      kind: "text",
      label: t("fields.address"),
      maxLength: 160,
    },
  ];

  const records: EntityRecord[] = branches.map((branch) => ({
    id: branch.id,
    active: branch.active,
    values: { name: branch.name, address: branch.address ?? "" },
    cells: [branch.name, branch.address ?? ""],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <EntityManager
        fields={fields}
        records={records}
        createAction={createBranchAction}
        updateAction={updateBranchAction}
        toggleAction={toggleBranchAction}
        deleteAction={deleteBranchAction}
        labels={{
          addTitle: t("addTitle"),
          addDescription: t("addDescription"),
          listTitle: t("listTitle"),
          listDescription: t("listDescription"),
          empty: t("empty"),
        }}
      />
    </div>
  );
}
