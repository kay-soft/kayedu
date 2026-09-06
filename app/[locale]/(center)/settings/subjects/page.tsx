import { getTranslations } from "next-intl/server";

import {
  createSubjectAction,
  deleteSubjectAction,
  toggleSubjectAction,
  updateSubjectAction,
} from "@/app/[locale]/(center)/settings/actions";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";

export default async function SubjectsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const db = scoped(ctx);
  const t = await getTranslations("Settings.subjects");
  const tCommon = await getTranslations("Settings.common");
  const grades = await db.grades.list();
  const subjects = await db.subjects.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "gradeId",
      kind: "select",
      label: t("fields.grade"),
      emptyLabel: tCommon("none"),
      options: grades.map((grade) => ({
        value: grade.id,
        label: grade.active
          ? grade.name
          : `${grade.name} · ${tCommon("inactive")}`,
      })),
    },
  ];

  const records: EntityRecord[] = subjects.map((subject) => ({
    id: subject.id,
    active: subject.active,
    values: { name: subject.name, gradeId: subject.gradeId ?? "" },
    cells: [subject.name, subject.grade?.name ?? tCommon("none")],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      {grades.length === 0 ? (
        <FormMessage tone="info">{t("noGradesHint")}</FormMessage>
      ) : null}

      <EntityManager
        fields={fields}
        records={records}
        createAction={createSubjectAction}
        updateAction={updateSubjectAction}
        toggleAction={toggleSubjectAction}
        deleteAction={deleteSubjectAction}
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
