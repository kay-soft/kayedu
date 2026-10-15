"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { effectiveCapacity, linkedRoomIds, type RoomLinkPair } from "@/lib/rooms";

export type RoomOption = {
  id: string;
  name: string;
  capacity: number;
  active: boolean;
};

/**
 * The room-set control (R3, docs/04-design-system.md §11.12): the primary
 * room picker, and under it "Combine with another room" — a checkbox per
 * room the centre has set up as combinable **with the chosen primary**
 * (`RoomLink`, Settings → Rooms), nothing else. Changing the primary drops
 * any extra that is not linked to the new one. A live line shows what the
 * set seats ("Room 1 + Room 2 = 100 seats"). Posts `roomId` and a single
 * comma-separated `extraRoomIds`; the server re-validates both
 * (`lib/db/room-sets.ts`'s `resolveRoomSet`) — this only narrows the offer.
 *
 * Inactive rooms are offered only when already part of the stored set.
 */
export function RoomSetPicker({
  idPrefix,
  rooms,
  links,
  defaultRoomId,
  defaultExtraIds,
  required,
  noneLabel,
  roomError,
  extraError,
  onChange,
}: {
  idPrefix: string;
  rooms: RoomOption[];
  links: RoomLinkPair[];
  defaultRoomId: string;
  defaultExtraIds: string[];
  /** A class must have a room (R3); a session may have none. */
  required?: boolean;
  noneLabel: string;
  roomError?: string;
  extraError?: string;
  onChange?: (next: { roomId: string | null; extraRoomIds: string[] }) => void;
}) {
  const t = useTranslations("RoomSets");
  const tCommon = useTranslations("Settings.common");
  const [roomId, setRoomId] = useState(defaultRoomId);
  const [extraIds, setExtraIds] = useState<string[]>(defaultExtraIds);

  const stored = new Set([defaultRoomId, ...defaultExtraIds]);
  const offerable = (room: RoomOption) => room.active || stored.has(room.id);
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const linked = roomId ? linkedRoomIds(roomId, links) : new Set<string>();
  const combinable = rooms.filter((room) => linked.has(room.id) && offerable(room));

  function update(nextRoomId: string, nextExtras: string[]) {
    setRoomId(nextRoomId);
    setExtraIds(nextExtras);
    onChange?.({ roomId: nextRoomId || null, extraRoomIds: nextRoomId ? nextExtras : [] });
  }

  function pickPrimary(next: string) {
    const nextLinked = next ? linkedRoomIds(next, links) : new Set<string>();
    update(
      next,
      extraIds.filter((id) => id !== next && nextLinked.has(id)),
    );
  }

  function toggleExtra(id: string, checked: boolean) {
    update(
      roomId,
      checked ? [...extraIds.filter((extra) => extra !== id), id] : extraIds.filter((extra) => extra !== id),
    );
  }

  const chosen = [roomId, ...extraIds].flatMap((id) => {
    const room = id ? byId.get(id) : undefined;
    return room ? [room] : [];
  });
  const seats = effectiveCapacity(chosen);
  const roomLabel = (room: RoomOption) =>
    room.active ? room.name : `${room.name} · ${tCommon("inactive")}`;
  const seatsLabel = (room: RoomOption) =>
    room.capacity > 0 ? t("seats", { count: room.capacity }) : t("unlimited");

  return (
    <div className="flex flex-col gap-3">
      <Field id={`${idPrefix}-roomId`} label={t("room")} optional={!required} error={roomError}>
        <Select
          id={`${idPrefix}-roomId`}
          name="roomId"
          value={roomId}
          onValueChange={pickPrimary}
          required={required}
          aria-invalid={roomError ? true : undefined}
        >
          {required ? (
            <option value="" disabled>
              {t("roomPlaceholder")}
            </option>
          ) : (
            <option value="">{noneLabel}</option>
          )}
          {rooms.filter(offerable).map((room) => (
            <option key={room.id} value={room.id}>
              {`${roomLabel(room)} — ${seatsLabel(room)}`}
            </option>
          ))}
        </Select>
      </Field>

      <input type="hidden" name="extraRoomIds" value={roomId ? extraIds.join(",") : ""} />

      <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium text-text-primary">{t("combineLabel")}</legend>
        {!roomId ? (
          <p className="text-xs text-text-muted">{t("choosePrimaryFirst")}</p>
        ) : combinable.length === 0 ? (
          <p className="text-xs text-text-muted">{t("combineNone")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {combinable.map((room) => (
              <li key={room.id}>
                <label
                  htmlFor={`${idPrefix}-extra-${room.id}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-surface-hover"
                >
                  <Checkbox
                    id={`${idPrefix}-extra-${room.id}`}
                    checked={extraIds.includes(room.id)}
                    onCheckedChange={(checked) => toggleExtra(room.id, checked === true)}
                  />
                  <span className="min-w-0 flex-1 text-text-primary">{roomLabel(room)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-text-muted">
                    {seatsLabel(room)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted">{t("combineHint")}</p>
        {extraError ? <p className="text-xs text-danger-fg">{extraError}</p> : null}
      </fieldset>

      {chosen.length > 0 ? (
        <p className="text-sm text-text-secondary">
          {t("combined", {
            rooms: chosen.map((room) => room.name).join(" + "),
            seats: seats > 0 ? t("seats", { count: seats }) : t("unlimited"),
          })}
          {seats > 0 ? null : (
            <span className="block text-xs text-text-muted">{t("unlimitedHint")}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
