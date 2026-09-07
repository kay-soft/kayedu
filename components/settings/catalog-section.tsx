"use client";

import { useActionState, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deselectCatalogEntryAction,
  selectCatalogEntryAction,
  suggestCatalogEntryAction,
  toggleCatalogSelectionAction,
  updateCatalogSelectionAction,
} from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Field } from "@/components/shared/field";
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
import { Input } from "@/components/ui/input";
import { SelectInput } from "@/components/ui/select-input";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { piastresToInputValue } from "@/lib/money";

export type CatalogEntryKind = "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT";

export type CatalogSelectionItem = {
  selectionId: string;
  catalogId: string;
  name: string;
  displayName: string | null;
  active: boolean;
  /** Piastres — only meaningful for kind EDUCATION_SYSTEM. */
  basePrice?: number;
  /** e.g. the parent education system's name, for a grade row. */
  parentName?: string | null;
};

export type CatalogPickOption = { value: string; label: string };

/**
 * One academic-catalog section (Education Systems / Grades / Subjects, M13)
 * on `/settings/catalog`: this centre's own picks (rename-for-itself + price,
 * deactivate, deselect), a picker for anything in the global catalog not yet
 * selected, and a form to suggest something missing or wrong. Nothing here
 * ever writes to the canonical catalog row — only to this centre's own
 * `CenterCatalogSelection`/`CatalogSuggestion` rows.
 */
export function CatalogSection({
  kind,
  hasPricing,
  items,
  pickOptions,
  parentOptions,
  labels,
}: {
  kind: CatalogEntryKind;
  hasPricing: boolean;
  items: CatalogSelectionItem[];
  pickOptions: CatalogPickOption[];
  /** Parent picker for a NEW suggestion — grades pick a system, subjects pick a grade. */
  parentOptions: CatalogPickOption[];
  labels: {
    title: string;
    description: string;
    pickTitle: string;
    pickPlaceholder: string;
    empty: string;
    suggestTitle: string;
    suggestDescription: string;
  };
}) {
  const t = useTranslations("Settings.catalog");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();

  const [pickState, pickFormAction] = useActionState(selectCatalogEntryAction, IDLE_ACTION_STATE);
  const [suggestState, suggestFormAction] = useActionState(
    suggestCatalogEntryAction,
    IDLE_ACTION_STATE,
  );
  const [correcting, setCorrecting] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{labels.title}</CardTitle>
          <CardDescription>{labels.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {pickOptions.length > 0 ? (
            <form
              key={`pick-${items.length}`}
              action={pickFormAction}
              className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-end sm:gap-3"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="kind" value={kind} />

              <Field id={`${kind}-pick`} label={labels.pickTitle} className="flex-1">
                <SelectInput id={`${kind}-pick`} name="catalogId" required defaultValue="">
                  <option value="" disabled>
                    {labels.pickPlaceholder}
                  </option>
                  {pickOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              {hasPricing ? (
                <Field id={`${kind}-pick-price`} label={t("fields.basePrice")} className="sm:w-40">
                  <Input
                    id={`${kind}-pick-price`}
                    name="basePrice"
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    defaultValue="0.00"
                  />
                </Field>
              ) : null}

              <SubmitButton className="sm:w-auto">
                <Plus className="size-4" />
                {t("select")}
              </SubmitButton>
            </form>
          ) : (
            <FormMessage tone="info">{t("nothingLeftToPick")}</FormMessage>
          )}
          {pickState.error ? <FormMessage>{tErrors(pickState.error)}</FormMessage> : null}

          {items.length === 0 ? (
            <p className="text-sm text-text-muted">{labels.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <CatalogRow key={item.selectionId} hasPricing={hasPricing} item={item} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{labels.suggestTitle}</CardTitle>
          <CardDescription>{labels.suggestDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            key={`suggest-${correcting}`}
            action={suggestFormAction}
            className="flex flex-col gap-4"
            noValidate
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="kind" value={kind} />

            {suggestState.error ? <FormMessage>{tErrors(suggestState.error)}</FormMessage> : null}
            {suggestState.status === "created" ? (
              <FormMessage tone="success">{t("suggestionSubmitted")}</FormMessage>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={correcting ? "outline" : "default"}
                className="h-9 px-3 text-xs"
                onClick={() => setCorrecting(false)}
              >
                {t("suggestNew")}
              </Button>
              <Button
                type="button"
                variant={correcting ? "default" : "outline"}
                className="h-9 px-3 text-xs"
                onClick={() => setCorrecting(true)}
                disabled={items.length === 0}
              >
                {t("suggestCorrection")}
              </Button>
            </div>

            {correcting ? (
              <Field id={`${kind}-suggest-target`} label={t("fields.existingEntry")}>
                <SelectInput id={`${kind}-suggest-target`} name="targetId" required defaultValue="">
                  <option value="" disabled>
                    {labels.pickPlaceholder}
                  </option>
                  {items.map((item) => (
                    <option key={item.catalogId} value={item.catalogId}>
                      {item.displayName ?? item.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            ) : parentOptions.length > 0 ? (
              <Field
                id={`${kind}-suggest-parent`}
                label={kind === "GRADE" ? t("fields.educationSystem") : t("fields.grade")}
                optional
              >
                <SelectInput id={`${kind}-suggest-parent`} name="parentId" defaultValue="">
                  <option value="">{t("noParent")}</option>
                  {parentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${kind}-suggest-ar`} label={t("fields.nameAr")}>
                <Input id={`${kind}-suggest-ar`} name="proposedNameAr" dir="rtl" required maxLength={120} />
              </Field>
              <Field id={`${kind}-suggest-en`} label={t("fields.nameEn")}>
                <Input id={`${kind}-suggest-en`} name="proposedNameEn" dir="ltr" required maxLength={120} />
              </Field>
            </div>

            <Field id={`${kind}-suggest-note`} label={t("fields.note")} optional>
              <Input id={`${kind}-suggest-note`} name="note" maxLength={400} />
            </Field>

            <SubmitButton className="w-full sm:w-auto">{t("submitSuggestion")}</SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function CatalogRow({
  hasPricing,
  item,
}: {
  hasPricing: boolean;
  item: CatalogSelectionItem;
}) {
  const t = useTranslations("Settings.catalog");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [updateState, updateFormAction] = useActionState(
    updateCatalogSelectionAction,
    IDLE_ACTION_STATE,
  );
  const [deselectState, deselectFormAction] = useActionState(
    deselectCatalogEntryAction,
    IDLE_ACTION_STATE,
  );
  const [toggleState, toggleFormAction] = useActionState(
    toggleCatalogSelectionAction,
    IDLE_ACTION_STATE,
  );

  if (editing) {
    return (
      <li className="rounded-xl border border-brand/30 bg-surface-subtle p-3">
        <form action={updateFormAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="selectionId" value={item.selectionId} />

          {updateState.error ? (
            <div className="sm:basis-full">
              <FormMessage>{tErrors(updateState.error)}</FormMessage>
            </div>
          ) : null}

          <Field
            id={`edit-${item.selectionId}-name`}
            label={t("fields.displayName")}
            hint={t("fields.displayNameHint", { name: item.name })}
            className="flex-1"
          >
            <Input
              id={`edit-${item.selectionId}-name`}
              name="displayName"
              defaultValue={item.displayName ?? ""}
              maxLength={80}
            />
          </Field>

          {hasPricing ? (
            <Field id={`edit-${item.selectionId}-price`} label={t("fields.basePrice")} className="sm:w-40">
              <Input
                id={`edit-${item.selectionId}-price`}
                name="basePrice"
                type="number"
                dir="ltr"
                inputMode="decimal"
                min={0}
                step="0.01"
                defaultValue={piastresToInputValue(item.basePrice ?? 0)}
              />
            </Field>
          ) : null}

          <div className="flex gap-2">
            <SubmitButton>{tCommon("save")}</SubmitButton>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {tCommon("cancel")}
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">
          {item.displayName ?? item.name}
          {item.displayName ? (
            <span className="ms-2 text-xs font-normal text-text-muted">({item.name})</span>
          ) : null}
        </p>
        <p className="text-xs text-text-muted">
          {[item.parentName, hasPricing ? `${piastresToInputValue(item.basePrice ?? 0)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Badge variant={item.active ? "success" : "neutral"}>
          {item.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
        <Button type="button" variant="outline" className="h-9 px-3" onClick={() => setEditing(true)}>
          <Pencil className="size-4" />
          {tCommon("edit")}
        </Button>
        <form action={toggleFormAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="selectionId" value={item.selectionId} />
          {item.active ? null : <input type="hidden" name="active" value="true" />}
          <Button type="submit" variant="ghost" className="h-9 px-3">
            {item.active ? tCommon("deactivate") : tCommon("activate")}
          </Button>
        </form>
        <form action={deselectFormAction} className="flex items-center gap-2">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="selectionId" value={item.selectionId} />
          {confirmingDelete ? (
            <>
              <Button type="submit" variant="destructive" className="h-9 px-3">
                {tCommon("deleteYes")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 px-3"
                onClick={() => setConfirmingDelete(false)}
              >
                {tCommon("cancel")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              className="h-9 px-3"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-4" />
              {t("deselect")}
            </Button>
          )}
        </form>
      </div>
      {deselectState.error ? (
        <div className="sm:basis-full">
          <FormMessage>{tErrors(deselectState.error)}</FormMessage>
        </div>
      ) : null}
      {toggleState.error ? (
        <div className="sm:basis-full">
          <FormMessage>{tErrors(toggleState.error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
