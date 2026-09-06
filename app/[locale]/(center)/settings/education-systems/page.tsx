import { getLocale, getTranslations } from "next-intl/server";

import {
  createEducationSystemAction,
  deleteEducationSystemAction,
  toggleEducationSystemAction,
  updateEducationSystemAction,
} from "@/app/[locale]/(center)/settings/actions";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatMoney } from "@/lib/format";
import { piastresToInputValue } from "@/lib/money";

export default async function EducationSystemsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const locale = await getLocale();
  const t = await getTranslations("Settings.educationSystems");
  const systems = await scoped(ctx).educationSystems.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "basePrice",
      kind: "money",
      label: t("fields.basePrice"),
      hint: t("fields.basePriceHint"),
    },
  ];

  const records: EntityRecord[] = systems.map((system) => ({
    id: system.id,
    active: system.active,
    values: {
      name: system.name,
      basePrice: piastresToInputValue(system.basePrice),
    },
    cells: [system.name, formatMoney(system.basePrice, locale)],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <EntityManager
        fields={fields}
        records={records}
        createAction={createEducationSystemAction}
        updateAction={updateEducationSystemAction}
        toggleAction={toggleEducationSystemAction}
        deleteAction={deleteEducationSystemAction}
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
