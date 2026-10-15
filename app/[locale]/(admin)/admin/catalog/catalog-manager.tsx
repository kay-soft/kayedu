"use client";

import { useEffect, useState } from "react";
import { Library, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { formatMoney, formatNumber } from "@/lib/format";

import {
  createCatalogEntryAction,
  deleteCatalogEntryAction,
  toggleCatalogEntryAction,
  updateCatalogEntryAction,
} from "@/app/[locale]/(admin)/admin/catalog/actions";
import {
  IDLE_CATALOG_ADMIN_ACTION_STATE,
  type CatalogAdminActionState,
} from "@/app/[locale]/(admin)/admin/catalog/action-state";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { EmptyState } from "@/components/shared/empty-state";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CATALOG_NAME_MAX, catalogLabel } from "@/lib/catalog";
import type { CatalogAdminRow, CatalogUsage } from "@/lib/db/catalog-admin";
import { piastresToInputValue } from "@/lib/money";
import { foldPickerText } from "@/lib/picker-search";
import { cn } from "@/lib/utils";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

type Kind = CatalogAdminRow["kind"];

const KINDS: Kind[] = ["EDUCATION_SYSTEM", "GRADE", "SUBJECT"];

/** `kind` → the `AdminCatalog.kinds.*` / `placeholders.*` message key. */
const KIND_KEY: Record<Kind, "educationSystem" | "grade" | "subject"> = {
  EDUCATION_SYSTEM: "educationSystem",
  GRADE: "grade",
  SUBJECT: "subject",
};

/**
 * The management surface behind `/admin/catalog` (R8): three kinds in tabs
 * (the lists are small and already loaded, so switching is instant), a
 * type-ahead search over both names and the parent, and the add-via-dialog
 * pattern (docs/04 §5) with side-by-side English and Arabic fields.
 * Responsive per docs/04 §6: tabs are an equal-width three-up control, rows
 * are stacked cards below `md`, 44px targets, the dialog a full-screen sheet
 * below `sm`.
 */
export function CatalogManager({
  systems,
  grades,
  subjects,
}: {
  systems: CatalogAdminRow[];
  grades: CatalogAdminRow[];
  subjects: CatalogAdminRow[];
}) {
  const t = useTranslations("AdminCatalog");
  const tabLocale = useLocale();
  const [kind, setKind] = useState<Kind>("EDUCATION_SYSTEM");
  const [query, setQuery] = useState("");

  const rowsByKind: Record<Kind, CatalogAdminRow[]> = {
    EDUCATION_SYSTEM: systems,
    GRADE: grades,
    SUBJECT: subjects,
  };
  const rows = rowsByKind[kind];

  // A short, client-side list: filtered on each render (the React compiler
  // memoises what is worth it).
  const words = foldPickerText(query).split(" ").filter(Boolean);
  const visible =
    words.length === 0
      ? rows
      : rows.filter((row) => {
          const haystack = foldPickerText(
            [row.nameEn, row.nameAr, row.parentNameEn, row.parentNameAr].filter(Boolean).join(" "),
          );
          return words.every((word) => haystack.includes(word));
        });

  const key = KIND_KEY[kind];

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={t("title")} className="grid grid-cols-3 gap-1 rounded-xl bg-surface-subtle p-1">
        {KINDS.map((tabKind) => {
          const selected = tabKind === kind;
          return (
            <button
              key={tabKind}
              type="button"
              role="tab"
              id={`catalog-tab-${tabKind}`}
              aria-selected={selected}
              aria-controls="catalog-panel"
              onClick={() => {
                setKind(tabKind);
                setQuery("");
              }}
              className={cn(
                "focus-ring flex min-h-11 min-w-0 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:flex-row sm:gap-2",
                selected
                  ? "bg-surface text-text-primary shadow-sm"
                  : "text-text-secondary hover:text-text-primary",
              )}
            >
              <span className="truncate">{t(`tabs.${KIND_KEY[tabKind]}`)}</span>
              <span className="text-xs font-normal tabular-nums text-text-secondary">
                {formatNumber(rowsByKind[tabKind].length, tabLocale)}
              </span>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t(`sections.${key}.title`)}</CardTitle>
          <CardDescription>{t(`sections.${key}.description`)}</CardDescription>
          <CardAction>
            <DialogLauncher
              button={(openDialog) => (
                <Button className="h-11 px-4" onClick={openDialog}>
                  <Plus className="size-4" />
                  {t("add")}
                </Button>
              )}
              render={(dialog) => (
                <EntryDialog {...dialog} mode="create" kind={kind} systems={systems} grades={grades} />
              )}
            />
          </CardAction>
        </CardHeader>
        <CardContent id="catalog-panel" role="tabpanel" aria-labelledby={`catalog-tab-${kind}`} className="flex flex-col gap-4">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-text-muted"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("search")}
              className="ps-9"
            />
          </div>

          {rows.length === 0 ? (
            <EmptyState compact icon={<Library />} title={t(`sections.${key}.empty`)} description={t("emptyHint")} />
          ) : visible.length === 0 ? (
            <EmptyState compact icon={<Search />} title={t("noMatches")} description={t("noMatchesHint")} />
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((row) => (
                <CatalogRow key={row.id} row={row} systems={systems} grades={grades} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── One entry ───────────────────────────────────────────────────────────────

/** The parts of a usage record worth naming — zero counts are left out. */
function usageParts(usage: CatalogUsage, t: ReturnType<typeof useTranslations>): string[] {
  return (
    [
      ["centres", usage.centres],
      ["classes", usage.classes],
      ["students", usage.students],
      ["sessions", usage.sessions],
      ["children", usage.children],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([name, count]) => t(`usage.${name}`, { count }));
}

type Confirming = "deactivate" | "delete" | null;

function CatalogRow({
  row,
  systems,
  grades,
}: {
  row: CatalogAdminRow;
  systems: CatalogAdminRow[];
  grades: CatalogAdminRow[];
}) {
  const t = useTranslations("AdminCatalog");
  const tErrors = useTranslations("AdminCatalog.errors");
  const locale = useLocale();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [toggleState, toggleAction, togglePending] = useGuardedActionState(
    toggleCatalogEntryAction,
    IDLE_CATALOG_ADMIN_ACTION_STATE,
  );
  const [deleteState, deleteAction, deletePending] = useGuardedActionState(
    deleteCatalogEntryAction,
    IDLE_CATALOG_ADMIN_ACTION_STATE,
  );

  // A finished deactivate flips `row.active` (the page revalidates), which is
  // what closes its confirmation: the panel only shows for an active entry.
  const confirmingDeactivate = confirming === "deactivate" && row.active;

  const parentLabel =
    row.parentNameAr !== null && row.parentNameEn !== null
      ? catalogLabel(locale, { nameAr: row.parentNameAr, nameEn: row.parentNameEn })
      : null;
  const meta = [
    parentLabel,
    row.defaultFixedCenterShare !== null
      ? t("defaultShareValue", { amount: formatMoney(row.defaultFixedCenterShare, locale) })
      : null,
    t("usage.summary", { centres: row.usage.centres, classes: row.usage.classes }),
  ].filter(Boolean);

  const blockers = deleteState.error === "inUse" && deleteState.usage ? usageParts(deleteState.usage, t) : [];
  const error = toggleState.error ?? (deleteState.error === "inUse" ? undefined : deleteState.error);

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border p-3 sm:p-4",
        !row.active && "bg-surface-subtle",
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-2 sm:gap-4">
          <div className="min-w-0">
            {/* The paragraph keeps the page's direction so the value starts
                under its label; the name is an isolated run in its own
                language (docs/04 §7). */}
            <p className="text-xs text-text-secondary">{t("fields.nameEn")}</p>
            <p className="truncate text-sm font-medium text-text-primary">
              <bdi dir="ltr" lang="en">{row.nameEn}</bdi>
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-text-secondary">{t("fields.nameAr")}</p>
            <p className="truncate text-sm font-medium text-text-primary">
              <bdi dir="rtl" lang="ar">{row.nameAr}</bdi>
            </p>
          </div>
          <p className="text-xs text-text-secondary sm:col-span-2">{meta.join(" · ")}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge variant={row.active ? "success" : "neutral"}>{row.active ? t("active") : t("inactive")}</Badge>
          <DialogLauncher
            button={(openDialog) => (
              <Button type="button" variant="outline" className="h-11 px-3 md:h-9" onClick={openDialog}>
                <Pencil className="size-4" />
                {t("edit")}
              </Button>
            )}
            render={(dialog) => (
              <EntryDialog {...dialog} mode="edit" kind={row.kind} row={row} systems={systems} grades={grades} />
            )}
          />
          {row.active ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-3 md:h-9"
              onClick={() => setConfirming(confirming === "deactivate" ? null : "deactivate")}
            >
              {t("deactivate")}
            </Button>
          ) : (
            <form action={toggleAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="kind" value={row.kind} />
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="active" value="true" />
              <Button type="submit" variant="ghost" className="h-11 px-3 md:h-9" disabled={togglePending}>
                {t("reactivate")}
              </Button>
            </form>
          )}
          {/* Quiet at rest — the red fill is for its confirmation panel, not
              for every row of reference data (docs/04 §14.6). */}
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-3 text-danger-fg hover:bg-danger-bg md:h-9"
            onClick={() => setConfirming(confirming === "delete" ? null : "delete")}
          >
            <Trash2 className="size-4" aria-hidden />
            {t("delete")}
          </Button>
        </div>
      </div>

      {confirmingDeactivate ? (
        <form action={toggleAction} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="kind" value={row.kind} />
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="active" value="false" />
          <p className="text-sm text-text-secondary">{t("deactivateConfirm")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" className="h-11 sm:h-9" disabled={togglePending}>
              {t("deactivateYes")}
            </Button>
            <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setConfirming(null)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {confirming === "delete" ? (
        <form action={deleteAction} className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-bg p-3">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="kind" value={row.kind} />
          <input type="hidden" name="id" value={row.id} />
          <p className="text-sm text-danger-fg">{t("deleteConfirm")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" variant="destructive" className="h-11 sm:h-9" disabled={deletePending}>
              {t("deleteYes")}
            </Button>
            <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setConfirming(null)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {blockers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <FormMessage>{t("deleteBlocked", { parts: blockers.join(" · ") })}</FormMessage>
          {row.active ? (
            <form action={toggleAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="kind" value={row.kind} />
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="active" value="false" />
              <Button type="submit" variant="outline" className="h-11 w-full sm:h-9 sm:w-auto" disabled={togglePending}>
                {t("deactivateInstead")}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}
    </li>
  );
}

// ── Add / edit dialog ───────────────────────────────────────────────────────

function EntryDialog({
  open,
  onOpenChange,
  mode,
  kind,
  row,
  systems,
  grades,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  kind: Kind;
  row?: CatalogAdminRow;
  systems: CatalogAdminRow[];
  grades: CatalogAdminRow[];
}) {
  const t = useTranslations("AdminCatalog");
  const tErrors = useTranslations("AdminCatalog.errors");
  const locale = useLocale();
  const key = KIND_KEY[kind];

  const [state, formAction, pending] = useGuardedActionState<CatalogAdminActionState>(
    mode === "create" ? createCatalogEntryAction : updateCatalogEntryAction,
    IDLE_CATALOG_ADMIN_ACTION_STATE,
  );
  useEffect(() => {
    if (state.status === "created" || state.status === "saved") onOpenChange(false);
  }, [state.status, onOpenChange]);

  // A grade's parent is an education system; a subject's is a grade (labelled
  // with its own system so two "Grade 1"s under different systems are distinct).
  const parentOptions =
    kind === "GRADE"
      ? systems.map((system) => ({
          value: system.id,
          label: catalogLabel(locale, system) + (system.active ? "" : ` · ${t("inactive")}`),
        }))
      : kind === "SUBJECT"
        ? grades.map((grade) => {
            const system =
              grade.parentNameAr !== null && grade.parentNameEn !== null
                ? catalogLabel(locale, { nameAr: grade.parentNameAr, nameEn: grade.parentNameEn })
                : null;
            return {
              value: grade.id,
              label:
                catalogLabel(locale, grade) +
                (system ? ` — ${system}` : "") +
                (grade.active ? "" : ` · ${t("inactive")}`),
            };
          })
        : [];

  const idPrefix = `catalog-${mode}-${row?.id ?? kind}`;
  const fieldErrors = state.fieldErrors ?? {};
  const fieldError = (name: string) => (fieldErrors[name] ? tErrors(fieldErrors[name]) : undefined);

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={mode === "create" ? t(`dialog.create.${key}`) : t(`dialog.edit.${key}`)}
      description={t("dialog.description")}
      formProps={{ action: formAction, noValidate: true }}
      cancelLabel={t("cancel")}
      submitLabel={mode === "create" ? t("add") : t("save")}
      submitPending={pending}
    >
      <div className="flex flex-col gap-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="kind" value={kind} />
        {row ? <input type="hidden" name="id" value={row.id} /> : null}

        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        {kind !== "EDUCATION_SYSTEM" ? (
          <Field
            id={`${idPrefix}-parent`}
            label={kind === "GRADE" ? t("fields.educationSystem") : t("fields.grade")}
            hint={kind === "GRADE" ? t("fields.educationSystemHint") : t("fields.gradeHint")}
            error={fieldError("parentId")}
            optional
          >
            <Select id={`${idPrefix}-parent`} name="parentId" defaultValue={row?.parentId ?? ""}>
              <option value="">{kind === "GRADE" ? t("noEducationSystem") : t("noGrade")}</option>
              {parentOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${idPrefix}-name-en`} label={t("fields.nameEn")} error={fieldError("nameEn")}>
            <Input
              id={`${idPrefix}-name-en`}
              name="nameEn"
              dir="ltr"
              lang="en"
              required
              maxLength={CATALOG_NAME_MAX}
              defaultValue={row?.nameEn ?? ""}
              placeholder={t(`placeholders.${key}.en`)}
              aria-invalid={fieldErrors.nameEn ? true : undefined}
            />
          </Field>
          <Field id={`${idPrefix}-name-ar`} label={t("fields.nameAr")} error={fieldError("nameAr")}>
            <Input
              id={`${idPrefix}-name-ar`}
              name="nameAr"
              dir="rtl"
              lang="ar"
              required
              maxLength={CATALOG_NAME_MAX}
              defaultValue={row?.nameAr ?? ""}
              placeholder={t(`placeholders.${key}.ar`)}
              aria-invalid={fieldErrors.nameAr ? true : undefined}
            />
          </Field>
        </div>

        {kind === "EDUCATION_SYSTEM" ? (
          <Field
            id={`${idPrefix}-share`}
            label={t("fields.defaultShare")}
            hint={t("fields.defaultShareHint")}
            error={fieldError("defaultFixedCenterShare")}
            optional
          >
            <Input
              id={`${idPrefix}-share`}
              name="defaultFixedCenterShare"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min={0}
              step="0.01"
              defaultValue={row?.defaultFixedCenterShare != null ? piastresToInputValue(row.defaultFixedCenterShare) : ""}
              placeholder="40.00"
              aria-invalid={fieldErrors.defaultFixedCenterShare ? true : undefined}
            />
          </Field>
        ) : null}
      </div>
    </DialogShell>
  );
}
