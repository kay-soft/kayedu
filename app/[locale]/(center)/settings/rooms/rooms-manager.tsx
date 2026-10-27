"use client";

import { startTransition, useEffect, useState } from "react";
import { Inbox, Pencil, Plus, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createRoomAction,
  deleteRoomAction,
  toggleRoomAction,
  updateRoomAction,
} from "@/app/[locale]/(center)/settings/actions";
import {
  SETTINGS_ACTION_BUTTON,
  SettingsList,
  SettingsListHeader,
  SettingsListRow,
} from "@/components/settings/settings-list";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { EmptyState } from "@/components/shared/empty-state";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

export type RoomRecord = {
  id: string;
  name: string;
  capacity: number;
  active: boolean;
  /** Every room this one is linked to — either side of the stored pair. */
  linkedRoomIds: string[];
};

type RoomOption = { id: string; name: string; capacity: number; active: boolean };

/**
 * Settings → Rooms (R3, docs/04-design-system.md §11.12, §14.8): the room
 * list and the **only** place a room's "Can be combined with" is edited — in
 * the Add room and Edit room dialogs, next to the name and capacity. A link is
 * stored once and shows on both rooms, so linking Room 1 → Room 2 here lists
 * Room 1 in Room 2's dialog and in its "Combines with" column with no second
 * write. Rows are the shared settings list (cards below `md`).
 */
export function RoomsManager({ rooms }: { rooms: RoomRecord[] }) {
  const t = useTranslations("Settings.rooms");
  const tCommon = useTranslations("Settings.common");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("listTitle")}</CardTitle>
        <CardDescription>{t("listDescription")}</CardDescription>
        <CardAction>
          <DialogLauncher
            button={(openDialog) => (
              <Button className="h-11 px-4" onClick={openDialog}>
                <Plus className="size-4" aria-hidden />
                {t("addButton")}
              </Button>
            )}
            render={(dialog) => <RoomDialog {...dialog} room={null} rooms={rooms} />}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {rooms.length === 0 ? (
          <EmptyState
            compact
            icon={<Inbox />}
            title={t("empty")}
            description={t("emptyHint")}
          />
        ) : (
          <SettingsList>
            <SettingsListHeader
              columns={[
                { key: "name", label: t("fields.name") },
                { key: "capacity", label: t("fields.capacity") },
                { key: "combines", label: t("fields.combinesWith") },
              ]}
              statusLabel={tCommon("status")}
              actionsLabel={tCommon("actions")}
              actionsSize="wide"
            />
            {rooms.map((room) => (
              <RoomRow key={room.id} room={room} rooms={rooms} />
            ))}
          </SettingsList>
        )}
      </CardContent>
    </Card>
  );
}

function RoomRow({ room, rooms }: { room: RoomRecord; rooms: RoomRecord[] }) {
  const t = useTranslations("Settings.rooms");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [toggleState, toggleFormAction] = useGuardedActionState(toggleRoomAction, IDLE_ACTION_STATE);
  const [deleteState, deleteFormAction] = useGuardedActionState(deleteRoomAction, IDLE_ACTION_STATE);

  const byId = new Map(rooms.map((other) => [other.id, other]));
  const combinesWith = room.linkedRoomIds
    .map((id) => byId.get(id)?.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b, locale));
  const combinesText = combinesWith.length
    ? new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(combinesWith)
    : "";
  const error = toggleState.error
    ? { key: toggleState.error, values: toggleState.errorValues }
    : deleteState.error
      ? { key: deleteState.error, values: deleteState.errorValues }
      : null;

  return (
    <SettingsListRow
      actionsSize="wide"
      cells={[
        {
          key: "name",
          label: t("fields.name"),
          content: (
            <span className="truncate text-sm font-medium text-text-primary" title={room.name}>
              {room.name}
            </span>
          ),
        },
        {
          key: "capacity",
          label: t("fields.capacity"),
          content: (
            <span className="truncate text-sm tabular-nums text-text-primary">
              {formatNumber(room.capacity, locale)}
            </span>
          ),
        },
        {
          key: "combines",
          label: t("fields.combinesWith"),
          content: (
            // Wraps, never truncates: this is the one place the links show.
            <span className="text-sm text-text-primary">{combinesText || "—"}</span>
          ),
        },
      ]}
      status={
        <Badge variant={room.active ? "success" : "neutral"}>
          {room.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      }
      actions={
        <>
          <DialogLauncher
            button={(openDialog) => (
              <Button
                type="button"
                variant="outline"
                className={SETTINGS_ACTION_BUTTON}
                onClick={openDialog}
              >
                <Pencil className="size-4" aria-hidden />
                {tCommon("edit")}
              </Button>
            )}
            render={(dialog) => <RoomDialog {...dialog} room={room} rooms={rooms} />}
          />

          {/* Deactivating asks first; activating is one tap (docs/04 §14.6). */}
          {room.active ? (
            <ConfirmAction
              label={tCommon("deactivate")}
              variant="outline"
              triggerClassName={SETTINGS_ACTION_BUTTON}
              title={tCommon("deactivateConfirm.title")}
              description={tCommon("deactivateConfirm.body")}
              action={toggleFormAction}
              fields={{ locale, id: room.id }}
            />
          ) : (
            <form action={toggleFormAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="id" value={room.id} />
              <input type="hidden" name="active" value="true" />
              <Button type="submit" variant="outline" className={SETTINGS_ACTION_BUTTON}>
                {tCommon("activate")}
              </Button>
            </form>
          )}

          <ConfirmAction
            label={tCommon("delete")}
            icon={<Trash2 className="size-4" aria-hidden />}
            variant="destructive"
            triggerClassName={SETTINGS_ACTION_BUTTON}
            title={t("deleteConfirm.title")}
            description={tCommon("deleteConfirm")}
            confirmLabel={tCommon("deleteYes")}
            action={deleteFormAction}
            fields={{ locale, id: room.id }}
          />
        </>
      }
      notice={error ? <FormMessage>{tErrors(error.key, error.values)}</FormMessage> : null}
    />
  );
}

/**
 * Add room / Edit room — one dialog, one save: name, capacity and the rooms
 * it can be combined with go through a single action in a single transaction
 * (`lib/db/room-sets.ts`'s `saveRoomWithLinks`), so a refused unlink saves
 * nothing, not even the new name. Submits through `startTransition` so a
 * refusal keeps what was typed; a successful save closes it.
 */
function RoomDialog({
  open,
  onOpenChange,
  room,
  rooms,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = add. */
  room: RoomRecord | null;
  rooms: RoomRecord[];
}) {
  const t = useTranslations("Settings.rooms");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const action = room ? updateRoomAction : createRoomAction;
  const [state, formAction, pending] = useGuardedActionState(action, IDLE_ACTION_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "created" || status === "saved" ? tCommon(status === "created" ? "created" : "saved") : null),
  });

  useEffect(() => {
    if (state.status === "created" || state.status === "saved") onOpenChange(false);
  }, [state, onOpenChange]);

  const idPrefix = room ? `edit-${room.id}` : "create";
  const others = rooms.filter((other) => other.id !== room?.id);

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={room ? t("editTitle") : t("addTitle")}
      description={room ? t("editDescription") : t("addDescription")}
      cancelLabel={tCommon("cancel")}
      submitLabel={room ? tCommon("save") : tCommon("add")}
      submitPending={pending}
      formProps={{
        noValidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => formAction(formData));
        },
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      {room ? <input type="hidden" name="id" value={room.id} /> : null}
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error, state.errorValues)}</FormMessage> : null}

        <Field
          id={`${idPrefix}-name`}
          label={t("fields.name")}
          error={state.fieldErrors?.name ? tErrors(state.fieldErrors.name) : undefined}
        >
          <Input
            id={`${idPrefix}-name`}
            name="name"
            type="text"
            required
            maxLength={80}
            defaultValue={room?.name ?? ""}
            aria-invalid={state.fieldErrors?.name ? true : undefined}
          />
        </Field>

        <Field
          id={`${idPrefix}-capacity`}
          label={t("fields.capacity")}
          hint={t("fields.capacityHint")}
          error={state.fieldErrors?.capacity ? tErrors(state.fieldErrors.capacity) : undefined}
        >
          <Input
            id={`${idPrefix}-capacity`}
            name="capacity"
            type="number"
            // Numerals stay LTR in both locales (docs/04 §7).
            dir="ltr"
            inputMode="decimal"
            min={0}
            max={10_000}
            step={1}
            defaultValue={room ? String(room.capacity) : ""}
            aria-invalid={state.fieldErrors?.capacity ? true : undefined}
          />
        </Field>

        <RoomLinkPicker
          idPrefix={idPrefix}
          options={others}
          defaultIds={room?.linkedRoomIds ?? []}
          error={state.fieldErrors?.linkedRoomIds ? tErrors(state.fieldErrors.linkedRoomIds) : undefined}
        />
      </div>
    </DialogShell>
  );
}

/**
 * "Can be combined with" — zero or more of this branch's **other active**
 * rooms. What is chosen shows as removable chips (a link to a room that has
 * since been deactivated is not offered again, but is kept as a chip until
 * someone removes it — never silently dropped); the checklist under them
 * offers the active rooms. Posts the whole set as one comma-separated
 * `linkedRoomIds`; the server re-validates every id (`saveRoomWithLinks`).
 */
function RoomLinkPicker({
  idPrefix,
  options,
  defaultIds,
  error,
}: {
  idPrefix: string;
  options: RoomOption[];
  defaultIds: string[];
  error?: string;
}) {
  const t = useTranslations("Settings.rooms");
  const tSets = useTranslations("RoomSets");
  const tCommon = useTranslations("Settings.common");
  const [selected, setSelected] = useState<string[]>(defaultIds);

  const byId = new Map(options.map((option) => [option.id, option]));
  const chips = selected.flatMap((id) => {
    const option = byId.get(id);
    return option ? [option] : [];
  });
  const offered = options.filter((option) => option.active);
  const seats = (option: RoomOption) =>
    option.capacity > 0 ? tSets("seats", { count: option.capacity }) : tSets("unlimited");

  function toggle(id: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...current.filter((existing) => existing !== id), id] : current.filter((existing) => existing !== id),
    );
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-text-primary">{t("fields.combinableWith")}</legend>
      <input type="hidden" name="linkedRoomIds" value={selected.join(",")} />

      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("fields.combinableWith")}>
          {chips.map((option) => (
            <li
              key={option.id}
              className="flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-hover ps-3 text-sm text-text-primary"
            >
              <span className="min-w-0 truncate">
                {option.active ? option.name : `${option.name} · ${tCommon("inactive")}`}
              </span>
              <button
                type="button"
                aria-label={t("fields.removeLink", { room: option.name })}
                onClick={() => toggle(option.id, false)}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-ui-fast focus-ring hover:text-text-primary"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {offered.length === 0 ? (
        <p className="text-xs text-text-muted">{t("fields.combineNone")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {offered.map((option) => (
            <li key={option.id}>
              <label
                htmlFor={`${idPrefix}-link-${option.id}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-surface-hover"
              >
                <Checkbox
                  id={`${idPrefix}-link-${option.id}`}
                  checked={selected.includes(option.id)}
                  onCheckedChange={(checked) => toggle(option.id, checked === true)}
                />
                <span className="min-w-0 flex-1 truncate text-text-primary">{option.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-muted">{seats(option)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-text-muted">{t("fields.combineHint")}</p>
      {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
    </fieldset>
  );
}
