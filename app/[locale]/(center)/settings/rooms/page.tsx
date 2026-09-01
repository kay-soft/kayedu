import { getLocale, getTranslations } from "next-intl/server";

import {
  createRoomAction,
  deleteRoomAction,
  toggleRoomAction,
  updateRoomAction,
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
import { formatNumber } from "@/lib/format";

export default async function RoomsPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "center.settings.edit");

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Settings.rooms");
  const tCommon = await getTranslations("Settings.common");
  const branches = await db.branches.list();
  const rooms = await db.rooms.list();

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "capacity",
      kind: "number",
      label: t("fields.capacity"),
      max: 10_000,
      hint: t("fields.capacityHint"),
    },
    {
      name: "branchId",
      kind: "select",
      label: t("fields.branch"),
      emptyLabel: tCommon("none"),
      options: branches.map((branch) => ({
        value: branch.id,
        label: branch.active
          ? branch.name
          : `${branch.name} · ${tCommon("inactive")}`,
      })),
    },
  ];

  const records: EntityRecord[] = rooms.map((room) => ({
    id: room.id,
    active: room.active,
    values: {
      name: room.name,
      capacity: String(room.capacity),
      branchId: room.branchId ?? "",
    },
    cells: [
      room.name,
      formatNumber(room.capacity, locale),
      room.branch?.name ?? tCommon("none"),
    ],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      {branches.length === 0 ? (
        <FormMessage tone="info">{t("noBranchesHint")}</FormMessage>
      ) : null}

      <EntityManager
        fields={fields}
        records={records}
        createAction={createRoomAction}
        updateAction={updateRoomAction}
        toggleAction={toggleRoomAction}
        deleteAction={deleteRoomAction}
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
