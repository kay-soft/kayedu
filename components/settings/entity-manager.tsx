"use client";

import { startTransition, useEffect, useState } from "react";
import { Inbox, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  EntityFields,
  type EntityField,
} from "@/components/settings/entity-fields";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  SETTINGS_ACTION_BUTTON,
  SettingsList,
  SettingsListHeader,
  SettingsListRow,
} from "@/components/settings/settings-list";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { cn } from "@/lib/utils";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ACTION_STATE, type ActionState } from "@/lib/validation/form";
import { EmptyState } from "@/components/shared/empty-state";

export type EntityRecord = {
  id: string;
  active: boolean;
  /** Prefills the edit form, keyed by field name. */
  values: Record<string, string>;
  /** What the row displays; one entry per field, in field order. */
  cells: string[];
};

export type EntityAction = (
  state: ActionState,
  formData: FormData,
) => Promise<ActionState>;

type EntityManagerProps = {
  fields: EntityField[];
  records: EntityRecord[];
  createAction: EntityAction;
  updateAction: EntityAction;
  toggleAction: EntityAction;
  deleteAction: EntityAction;
  /**
   * Where the create form lives: an always-open card above the list (the M2
   * default the rooms screen uses), or behind an "Add" button that opens the
   * standard add dialog (docs/04 §5 "Dialog") — a centered card from `sm` up,
   * a full-screen sheet below it.
   */
  addVia?: "card" | "dialog";
  labels: {
    addTitle: string;
    addDescription: string;
    listTitle: string;
    listDescription: string;
    empty: string;
    /** Replaces the generic "use the form above" hint under the empty state. */
    emptyHint?: string;
  };
};

/**
 * The shared CRUD surface behind every master-data settings screen
 * (rooms, payment methods). One field
 * descriptor list drives the create form, the row display and the edit form,
 * so adding a screen is a page file — not another table implementation.
 *
 * Responsive per docs/04 §6: rows are stacked label/value cards below `md`
 * and a bordered table from `md` up — a primary list is never side-scrolled.
 * Editing expands inline instead of opening a modal, so a phone behaves the
 * same as a desktop.
 */
export function EntityManager({
  fields,
  records,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
  addVia = "card",
  labels,
}: EntityManagerProps) {
  const t = useTranslations("Settings.common");

  return (
    <div className="flex flex-col gap-6">
      {addVia === "card" ? (
        <Card>
          <CardHeader>
            <CardTitle>{labels.addTitle}</CardTitle>
            <CardDescription>{labels.addDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <EntityCreateForm
              // A successful create changes the row count, which remounts this
              // form with empty inputs, ready for the next entry. A rejected
              // one leaves the count — and the typed values — alone.
              key={`create-${records.length}`}
              fields={fields}
              createAction={createAction}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{labels.listTitle}</CardTitle>
          <CardDescription>{labels.listDescription}</CardDescription>
          {addVia === "dialog" ? (
            <CardAction>
              <AddEntityDialog
                fields={fields}
                createAction={createAction}
                title={labels.addTitle}
                description={labels.addDescription}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {records.length === 0 ? (
            <EmptyState
              compact
              icon={<Inbox />}
              title={labels.empty}
              description={labels.emptyHint ?? t("emptyHint")}
            />
          ) : (
            <SettingsList>
              <SettingsListHeader
                columns={fields.map((field) => ({ key: field.name, label: field.label }))}
                statusLabel={t("status")}
                actionsLabel={t("actions")}
              />

              {records.map((record) => (
                <EntityRow
                  key={record.id}
                  record={record}
                  fields={fields}
                  updateAction={updateAction}
                  toggleAction={toggleAction}
                  deleteAction={deleteAction}
                />
              ))}
            </SettingsList>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The inline create form (Settings → Rooms keeps it on the page). It submits
 * through `startTransition` with the form's own `FormData` rather than a
 * `<form action>`, which React 19 resets once the action returns — a refused
 * create (a duplicate name) had cleared what was typed (DES, docs/04 §14.7).
 */
function EntityCreateForm({
  fields,
  createAction,
}: {
  fields: EntityField[];
  createAction: EntityAction;
}) {
  const t = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(createAction, IDLE_ACTION_STATE);
  useActionFeedback(state, { success: (status) => (status === "created" ? t("created") : null) });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error, state.errorValues)}</FormMessage> : null}

      <EntityFields
        fields={fields}
        idPrefix="create"
        fieldErrors={state.fieldErrors}
        translateError={tErrors}
      />

      <SubmitButton className="w-full sm:w-auto sm:self-start">
        <Plus className="size-4" aria-hidden />
        {t("add")}
      </SubmitButton>
    </form>
  );
}

/**
 * The list-first "Add X" dialog (docs/04 §5) on the shared `DialogShell`
 * (DES, docs/04 §14.7): the fixed header, the body, and the footer's Cancel +
 * primary — it had no footer and no Cancel, with a full-width "Add" floating
 * in the body. A fresh instance on every open (`DialogLauncher`); it submits
 * through `startTransition`, so a refused create keeps what was typed, and a
 * successful one closes it and says so.
 */
function AddEntityDialog({
  fields,
  createAction,
  title,
  description,
}: {
  fields: EntityField[];
  createAction: EntityAction;
  title: string;
  description: string;
}) {
  const t = useTranslations("Settings.common");

  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button className="h-11 px-4" onClick={openDialog}>
          <Plus className="size-4" aria-hidden />
          {t("add")}
        </Button>
      )}
      render={(dialog) => (
        <AddEntityDialogBody
          {...dialog}
          fields={fields}
          createAction={createAction}
          title={title}
          description={description}
        />
      )}
    />
  );
}

function AddEntityDialogBody({
  open,
  onOpenChange,
  fields,
  createAction,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: EntityField[];
  createAction: EntityAction;
  title: string;
  description: string;
}) {
  const t = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(createAction, IDLE_ACTION_STATE);
  useActionFeedback(state, { success: (status) => (status === "created" ? t("created") : null) });

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state, onOpenChange]);

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={title}
      description={description}
      cancelLabel={t("cancel")}
      submitLabel={t("add")}
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
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error, state.errorValues)}</FormMessage> : null}
        <EntityFields
          fields={fields}
          idPrefix="create"
          fieldErrors={state.fieldErrors}
          translateError={tErrors}
        />
      </div>
    </DialogShell>
  );
}

function EntityRow({
  record,
  fields,
  updateAction,
  toggleAction,
  deleteAction,
}: {
  record: EntityRecord;
  fields: EntityField[];
  updateAction: EntityAction;
  toggleAction: EntityAction;
  deleteAction: EntityAction;
}) {
  const t = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [state, formAction] = useGuardedActionState(updateAction, IDLE_ACTION_STATE);
  const [deleteState, deleteFormAction] = useGuardedActionState(
    deleteAction,
    IDLE_ACTION_STATE,
  );
  const [toggleState, toggleFormAction] = useGuardedActionState(
    toggleAction,
    IDLE_ACTION_STATE,
  );

  if (editing) {
    return (
      <li className="rounded-xl border border-brand/30 bg-surface-subtle p-3 md:my-2">
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={record.id} />

          {state.error ? (
            <FormMessage>{tErrors(state.error, state.errorValues)}</FormMessage>
          ) : null}
          {deleteState.error ? (
            <FormMessage>{tErrors(deleteState.error, deleteState.errorValues)}</FormMessage>
          ) : null}
          {deleteState.status === "deactivated" ? (
            <FormMessage tone="info">{t("deactivatedInstead")}</FormMessage>
          ) : null}

          <EntityFields
            fields={fields}
            values={record.values}
            idPrefix={`edit-${record.id}`}
            fieldErrors={state.fieldErrors}
            translateError={tErrors}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SubmitButton className="w-full sm:w-auto">
              {t("save")}
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full px-4 sm:w-auto"
              onClick={() => {
                setEditing(false);
                setConfirmingDelete(false);
              }}
            >
              {t("cancel")}
            </Button>

            <div className="sm:ms-auto">
              {confirmingDelete ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="text-xs text-text-secondary">
                    {t("deleteConfirm")}
                  </span>
                  {/* formAction re-targets this one submit — no nested form. */}
                  <Button
                    type="submit"
                    variant="destructive"
                    formAction={deleteFormAction}
                    formNoValidate
                    className="h-11 w-full px-4 sm:w-auto"
                  >
                    {t("deleteYes")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full px-4 sm:w-auto"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t("cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  className="h-11 w-full px-4 sm:w-auto"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="size-4" />
                  {t("delete")}
                </Button>
              )}
            </div>
          </div>
        </form>
      </li>
    );
  }

  return (
    <SettingsListRow
      cells={fields.map((field, index) => ({
        key: field.name,
        label: field.label,
        content: (
          <span
            className={cn(
              "truncate text-sm text-text-primary",
              index === 0 && "font-medium",
            )}
            title={record.cells[index] || undefined}
          >
            {record.cells[index] || "—"}
          </span>
        ),
      }))}
      status={
        <Badge variant={record.active ? "success" : "neutral"}>
          {record.active ? t("active") : t("inactive")}
        </Badge>
      }
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            className={SETTINGS_ACTION_BUTTON}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-4" aria-hidden />
            {t("edit")}
          </Button>

          {/* Deactivating takes the entry out of every picker at once (a
              payment method out of Reception) — it asks first; activating is
              one tap (docs/04 §14.6). An absent field means false, so only
              activating sends `active`. */}
          {record.active ? (
            <ConfirmAction
              label={t("deactivate")}
              variant="outline"
              triggerClassName={SETTINGS_ACTION_BUTTON}
              title={t("deactivateConfirm.title")}
              description={t("deactivateConfirm.body")}
              action={toggleFormAction}
              fields={{ locale, id: record.id }}
            />
          ) : (
            <form action={toggleFormAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="id" value={record.id} />
              <input type="hidden" name="active" value="true" />
              <Button type="submit" variant="outline" className={SETTINGS_ACTION_BUTTON}>
                {t("activate")}
              </Button>
            </form>
          )}
        </>
      }
      notice={
        toggleState.error ? (
          <FormMessage>{tErrors(toggleState.error, toggleState.errorValues)}</FormMessage>
        ) : null
      }
    />
  );
}
