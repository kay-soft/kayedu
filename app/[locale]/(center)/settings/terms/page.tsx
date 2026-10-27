import { getLocale, getTranslations } from "next-intl/server";

import {
  createTermAction,
  deleteTermAction,
  toggleTermAction,
  updateTermAction,
} from "@/app/[locale]/(center)/settings/actions";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatDay } from "@/lib/format";
import { dateKey } from "@/lib/scheduling";

/**
 * The centre's term presets (R4) — "Semester 1", "Full year". Same gate and
 * same add-via-dialog surface as payment methods (R1). A term only fills a
 * class's dates when the class form picks it; the dates are copied, so
 * editing or deleting a term here never moves a class (the description says
 * so). Terms may overlap.
 */
export default async function TermsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");

  const locale = await getLocale();
  const t = await getTranslations("Settings.terms");
  const terms = await scoped(ctx).terms.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true, maxLength: 80, placeholder: t("fields.namePlaceholder") },
    { name: "startDate", kind: "date", label: t("fields.startDate"), required: true },
    { name: "endDate", kind: "date", label: t("fields.endDate"), required: true },
  ];

  const records: EntityRecord[] = terms.map((term) => ({
    id: term.id,
    active: term.active,
    values: {
      name: term.name,
      startDate: dateKey(term.startDate),
      endDate: dateKey(term.endDate),
    },
    cells: [term.name, formatDay(term.startDate, locale), formatDay(term.endDate, locale)],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <EntityManager
        fields={fields}
        records={records}
        createAction={createTermAction}
        updateAction={updateTermAction}
        toggleAction={toggleTermAction}
        deleteAction={deleteTermAction}
        addVia="dialog"
        labels={{
          addTitle: t("addTitle"),
          addDescription: t("addDescription"),
          listTitle: t("listTitle"),
          listDescription: t("listDescription"),
          empty: t("empty"),
          emptyHint: t("emptyHint"),
        }}
      />
    </div>
  );
}
