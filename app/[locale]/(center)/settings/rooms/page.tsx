import { getTranslations } from "next-intl/server";

import { RoomsManager } from "@/app/[locale]/(center)/settings/rooms/rooms-manager";
import { SectionHeader } from "@/components/shared/section-header";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { linkedRoomIds } from "@/lib/rooms";

/**
 * Rooms (centre-authored master data) and, R3, which of them can be combined
 * into one bigger room — edited in the Add / Edit room dialogs, not in a
 * section of its own. Deactivating or deleting a room that a combined room
 * set still relies on is refused with how many classes/sessions use it.
 */
export default async function RoomsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");

  const db = scoped(ctx);
  const t = await getTranslations("Settings.rooms");
  const [rooms, links] = await Promise.all([db.rooms.list(), db.roomLinks.list()]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <RoomsManager
        // Every link, including ones to a deactivated room: the dialog keeps
        // those as removable chips and never silently unlinks them.
        rooms={rooms.map((room) => ({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          active: room.active,
          linkedRoomIds: [...linkedRoomIds(room.id, links)],
        }))}
      />
    </div>
  );
}
