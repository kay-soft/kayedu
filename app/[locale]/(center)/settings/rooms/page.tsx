import { getLocale, getTranslations } from "next-intl/server";

import {
  createRoomAction,
  deleteRoomAction,
  toggleRoomAction,
  updateRoomAction,
} from "@/app/[locale]/(center)/settings/actions";
import { RoomLinksManager } from "@/app/[locale]/(center)/settings/rooms/room-links-manager";
import type { EntityField } from "@/components/settings/entity-fields";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatNumber } from "@/lib/format";

/**
 * Rooms (centre-authored master data) and, R3, which of them can be combined
 * into one bigger room. Deactivating or deleting a room that a combined room
 * set still relies on is refused with how many classes/sessions use it.
 */
export default async function RoomsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Settings.rooms");
  const [rooms, links] = await Promise.all([db.rooms.list(), db.roomLinks.list()]);

  const fields: EntityField[] = [
    { name: "name", kind: "text", label: t("fields.name"), required: true },
    {
      name: "capacity",
      kind: "number",
      label: t("fields.capacity"),
      max: 10_000,
      hint: t("fields.capacityHint"),
    },
  ];

  const records: EntityRecord[] = rooms.map((room) => ({
    id: room.id,
    active: room.active,
    values: {
      name: room.name,
      capacity: String(room.capacity),
    },
    cells: [room.name, formatNumber(room.capacity, locale)],
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

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

      <RoomLinksManager
        rooms={rooms
          .filter((room) => room.active)
          .map((room) => ({ id: room.id, name: room.name, capacity: room.capacity }))}
        // Every link, including ones to a deactivated room: those are not
        // offered as checkboxes but are kept (re-posted) on save, never
        // silently unlinked.
        links={links}
      />
    </div>
  );
}
