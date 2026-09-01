import { getTranslations } from "next-intl/server";

import {
  createGradeAction,
  deleteGradeAction,
  toggleGradeAction,
  updateGradeAction,
} from "@/app/[locale]/(center)/settings/actions";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { FormMessage } from "@/components/shared/form-message";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";

export default async function GradesPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const db = scoped(ctx);
  const t = await getTranslations("Settings.grades");
  const tCommon = await getTranslations("Settings.common");
  const systems = await db.educationSystems.list();
  const grades = await db.grades.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "educationSystemId",
      kind: "select",
      label: t("fields.educationSystem"),
      // Optional: a center may run one taxonomy and never split by system.
      emptyLabel: tCommon("none"),
      // Inactive systems stay selectable so an existing grade keeps its link.
      options: systems.map((system) => ({
        value: system.id,
        label: system.active
          ? system.name
          : `${system.name} · ${tCommon("inactive")}`,
      })),
    },
  ];

  const records: EntityRecord[] = grades.map((grade) => ({
    id: grade.id,
    active: grade.active,
    values: {
      name: grade.name,
      educationSystemId: grade.educationSystemId ?? "",
    },
    cells: [grade.name, grade.educationSystem?.name ?? tCommon("none")],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      {systems.length === 0 ? (
        <FormMessage tone="info">{t("noSystemsHint")}</FormMessage>
      ) : null}

      <EntityManager
        fields={fields}
        records={records}
        createAction={createGradeAction}
        updateAction={updateGradeAction}
        toggleAction={toggleGradeAction}
        deleteAction={deleteGradeAction}
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
