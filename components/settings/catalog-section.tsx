"use client";

import { useActionState, useState } from "react";
import { Inbox, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deselectCatalogEntryAction,
  selectCatalogEntryAction,
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
import { Select } from "@/components/ui/select";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { CATALOG_NAME_MAX } from "@/lib/catalog";
import { piastresToInputValue } from "@/lib/money";
import { EmptyState } from "@/components/shared/empty-state";

export type CatalogEntryKind = "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT";

export type CatalogSelectionItem = {
  selectionId: string;
  catalogId: string;
  /** What the centre sees in this language: its own rename if it set one, else the catalog name (`catalogLabel`). */
  name: string;
  /** The catalog's own name in this language, shown beside a rename so staff see what it overrides. */
  canonicalName: string;
  /** The catalog's names in both languages: the placeholders of the two rename fields. */
  nameAr: string;
  nameEn: string;
  /** The centre's own optional renames, one per language. */
  displayNameAr: string | null;
  displayNameEn: string | null;
  /** The centre's own switch for this pick. */
  active: boolean;
  /** False once the platform has deactivated the entry: it keeps resolving in history but cannot be picked again. */
  catalogActive: boolean;
  /** Piastres — only meaningful for kind EDUCATION_SYSTEM. */
  basePrice?: number;
  /** e.g. the parent education system's name, for a grade row. */
  parentName?: string | null;
};

export type CatalogPickOption = { value: string; label: string };

/**
 * One academic-catalog section (Education Systems / Grades / Subjects, M13)
 * on `/settings/catalog`: this centre's own picks (rename-for-itself in both
 * languages + price, deactivate, deselect) and a picker for anything active in
 * the global catalog not yet selected. Nothing here ever writes to the
 * canonical catalog row, only to this centre's own `CenterCatalogSelection`
 * rows. There is no "suggest" control (R8): a centre that needs an entry the
 * catalog lacks contacts the platform, who adds it.
 */
export function CatalogSection({
  kind,
  hasPricing,
  items,
  pickOptions,
  labels,
}: {
  kind: CatalogEntryKind;
  hasPricing: boolean;
  items: CatalogSelectionItem[];
  pickOptions: CatalogPickOption[];
  labels: {
    title: string;
    description: string;
    pickTitle: string;
    pickPlaceholder: string;
    empty: string;
  };
}) {
  const t = useTranslations("Settings.catalog");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();

  const [pickState, pickFormAction] = useActionState(selectCatalogEntryAction, IDLE_ACTION_STATE);

  return (
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
              <Select id={`${kind}-pick`} name="catalogId" required defaultValue="">
                <option value="" disabled>
                  {labels.pickPlaceholder}
                </option>
                {pickOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
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
                  placeholder="1500.00"
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
        <p className="text-xs text-text-muted">{t("contactUs")}</p>

        {items.length === 0 ? (
          <EmptyState compact icon={<Inbox />} title={labels.empty} description={t("emptyHint")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <CatalogRow key={item.selectionId} hasPricing={hasPricing} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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

          <div className="grid gap-3 sm:basis-full sm:grid-cols-2">
            <Field
              id={`edit-${item.selectionId}-name-ar`}
              label={t("fields.displayNameAr")}
              hint={t("fields.displayNameHint")}
              optional
            >
              <Input
                id={`edit-${item.selectionId}-name-ar`}
                name="displayNameAr"
                dir="rtl"
                lang="ar"
                defaultValue={item.displayNameAr ?? ""}
                placeholder={item.nameAr}
                maxLength={CATALOG_NAME_MAX}
              />
            </Field>
            <Field
              id={`edit-${item.selectionId}-name-en`}
              label={t("fields.displayNameEn")}
              hint={t("fields.displayNameHint")}
              optional
            >
              <Input
                id={`edit-${item.selectionId}-name-en`}
                name="displayNameEn"
                dir="ltr"
                lang="en"
                defaultValue={item.displayNameEn ?? ""}
                placeholder={item.nameEn}
                maxLength={CATALOG_NAME_MAX}
              />
            </Field>
          </div>

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
          {item.name}
          {item.name !== item.canonicalName ? (
            <span className="ms-2 text-xs font-normal text-text-muted">({item.canonicalName})</span>
          ) : null}
        </p>
        <p className="text-xs text-text-muted">
          {[item.parentName, hasPricing ? `${piastresToInputValue(item.basePrice ?? 0)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {item.catalogActive ? null : <Badge variant="warning">{t("retired")}</Badge>}
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
