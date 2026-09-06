"use client";

import { useActionState, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  EntityFields,
  type EntityField,
} from "@/components/settings/entity-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IDLE_ACTION_STATE, type ActionState } from "@/lib/validation/form";

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
  labels: {
    addTitle: string;
    addDescription: string;
    listTitle: string;
    listDescription: string;
    empty: string;
  };
};

/**
 * The shared CRUD surface behind every master-data settings screen
 * (education systems, grades, subjects, branches, rooms). One field
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
  labels,
}: EntityManagerProps) {
  const t = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(createAction, IDLE_ACTION_STATE);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{labels.addTitle}</CardTitle>
          <CardDescription>{labels.addDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            // A successful create changes the row count, which remounts this
            // form with empty inputs, ready for the next entry. A rejected
            // one leaves the count — and the typed values — alone.
            key={`create-${records.length}`}
            action={formAction}
            className="flex flex-col gap-4"
            noValidate
          >
            <input type="hidden" name="locale" value={locale} />

            {state.error ? (
              <FormMessage>{tErrors(state.error)}</FormMessage>
            ) : null}

            <EntityFields
              fields={fields}
              idPrefix="create"
              fieldErrors={state.fieldErrors}
              translateError={tErrors}
            />

            <SubmitButton className="w-full sm:w-auto">
              <Plus className="size-4" />
              {t("add")}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{labels.listTitle}</CardTitle>
          <CardDescription>{labels.listDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {records.length === 0 ? (
            <p className="text-sm text-text-muted">{labels.empty}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                {fields.map((field) => (
                  <span key={field.name} className="min-w-0 flex-1">
                    {field.label}
                  </span>
                ))}
                <span className="w-20 shrink-0">{t("status")}</span>
                <span className="w-40 shrink-0 text-end">{t("actions")}</span>
              </li>

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
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
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
  const [state, formAction] = useActionState(updateAction, IDLE_ACTION_STATE);
  const [deleteState, deleteFormAction] = useActionState(
    deleteAction,
    IDLE_ACTION_STATE,
  );
  const [toggleState, toggleFormAction] = useActionState(
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
            <FormMessage>{tErrors(state.error)}</FormMessage>
          ) : null}
          {deleteState.error ? (
            <FormMessage>{tErrors(deleteState.error)}</FormMessage>
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
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      {fields.map((field, index) => (
        <div key={field.name} className="flex min-w-0 flex-1 flex-col">
          {/* The column label rides along on mobile, where headers are gone. */}
          <span className="text-xs text-text-muted md:hidden">
            {field.label}
          </span>
          <span className="truncate text-sm text-text-primary">
            {record.cells[index] || "—"}
          </span>
        </div>
      ))}

      <div className="w-20 shrink-0">
        <Badge variant={record.active ? "success" : "neutral"}>
          {record.active ? t("active") : t("inactive")}
        </Badge>
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:w-40 md:justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-4" />
          {t("edit")}
        </Button>

        <form action={toggleFormAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={record.id} />
          {/* An absent checkbox means false, so only send it when activating. */}
          {record.active ? null : (
            <input type="hidden" name="active" value="true" />
          )}
          <Button type="submit" variant="ghost" className="h-11 w-full px-4">
            {record.active ? t("deactivate") : t("activate")}
          </Button>
        </form>
      </div>

      {toggleState.error ? (
        <div className="md:w-full md:basis-full">
          <FormMessage>{tErrors(toggleState.error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
