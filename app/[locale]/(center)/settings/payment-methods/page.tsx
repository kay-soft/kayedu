import { getTranslations } from "next-intl/server";

import {
  createPaymentMethodAction,
  deletePaymentMethodAction,
  togglePaymentMethodAction,
  updatePaymentMethodAction,
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

/**
 * The centre's own payment methods (R1). Same gate and same CRUD surface as
 * rooms, with the add form in the standard dialog. The rules that can refuse
 * a change — the last active method, and a method payments already use
 * (deactivated instead of deleted) — are enforced server-side in
 * lib/db/payment-methods.ts and surface here as the row's own message.
 */
export default async function PaymentMethodsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");

  const t = await getTranslations("Settings.paymentMethods");
  const methods = await scoped(ctx).paymentMethods.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true, maxLength: 80 },
  ];

  const records: EntityRecord[] = methods.map((method) => ({
    id: method.id,
    active: method.active,
    values: { name: method.name },
    cells: [method.name],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <EntityManager
        fields={fields}
        records={records}
        createAction={createPaymentMethodAction}
        updateAction={updatePaymentMethodAction}
        toggleAction={togglePaymentMethodAction}
        deleteAction={deletePaymentMethodAction}
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
