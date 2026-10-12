"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { setRoomLinksAction } from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { effectiveCapacity, linkedRoomIds, type RoomLinkPair } from "@/lib/rooms";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

export type LinkableRoom = { id: string; name: string; capacity: number };

/**
 * Joinable rooms (R3, docs/04-design-system.md §11.12): for each active
 * room, "Can be combined with" — a checkbox per other active room — and a
 * live preview of what each pairing seats ("Room 1 + Room 2 = 100 seats").
 * A link is symmetric: ticking Room 2 under Room 1 also lists Room 1 under
 * Room 2 after saving. Combinations are a star around a class's primary
 * room, never transitive, so linking A-B and B-C does not allow A+C.
 * Unlinking a pair an active class or a future session still uses is
 * refused server-side with how many.
 */
export function RoomLinksManager({
  rooms,
  links,
}: {
  rooms: LinkableRoom[];
  links: RoomLinkPair[];
}) {
  const t = useTranslations("Settings.rooms.links");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {rooms.length < 2 ? (
          <p className="text-sm text-text-muted">{t("needTwo")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rooms.map((room) => (
              <RoomLinksRow
                // Re-seed the row's ticks whenever the stored links change.
                key={`${room.id}:${[...linkedRoomIds(room.id, links)].sort().join(",")}`}
                room={room}
                others={rooms.filter((other) => other.id !== room.id)}
                linked={linkedRoomIds(room.id, links)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RoomLinksRow({
  room,
  others,
  linked,
}: {
  room: LinkableRoom;
  others: LinkableRoom[];
  linked: Set<string>;
}) {
  const t = useTranslations("Settings.rooms.links");
  const tSets = useTranslations("RoomSets");
  const tErrors = useTranslations("Settings.errors");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();
  const [state, formAction] = useActionState(setRoomLinksAction, IDLE_ACTION_STATE);
  const [selected, setSelected] = useState<string[]>(() => [...linked]);

  const seats = (rooms: LinkableRoom[]) => {
    const total = effectiveCapacity(rooms);
    return total > 0 ? tSets("seats", { count: total }) : tSets("unlimited");
  };
  const chosen = others.filter((other) => selected.includes(other.id));
  const dirty =
    selected.length !== linked.size || selected.some((id) => !linked.has(id));

  return (
    <li className="rounded-xl border border-border p-3 sm:p-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="roomId" value={room.id} />
        <input type="hidden" name="linkedRoomIds" value={selected.join(",")} />

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-text-primary">{room.name}</p>
          <p className="text-xs tabular-nums text-text-muted">{seats([room])}</p>
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-text-secondary">
            {t("combinableWith")}
          </legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {others.map((other) => (
              <label
                key={other.id}
                htmlFor={`link-${room.id}-${other.id}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-surface-hover"
              >
                <Checkbox
                  id={`link-${room.id}-${other.id}`}
                  checked={selected.includes(other.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked === true
                        ? [...current.filter((id) => id !== other.id), other.id]
                        : current.filter((id) => id !== other.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-text-primary">{other.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-muted">
                  {seats([other])}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {chosen.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-xs text-text-secondary">
            {chosen.map((other) => (
              <li key={other.id}>
                {tSets("combined", {
                  rooms: `${room.name} + ${other.name}`,
                  seats: seats([room, other]),
                })}
              </li>
            ))}
          </ul>
        ) : null}

        {state.error ? (
          <FormMessage>{tErrors(state.error, state.errorValues)}</FormMessage>
        ) : state.status === "saved" && !dirty ? (
          <FormMessage tone="success">{tCommon("saved")}</FormMessage>
        ) : null}

        <SubmitButton variant="outline" className="w-full sm:w-auto sm:self-start" disabled={!dirty}>
          {t("save")}
        </SubmitButton>
      </form>
    </li>
  );
}
