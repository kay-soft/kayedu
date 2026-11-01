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
import { Select } from "@/components/ui/select";
import { CATALOG_NAME_MAX, catalogLabel } from "@/lib/catalog";
import type { CatalogAdminRow, CatalogLinkInUse, CatalogUsage } from "@/lib/db/catalog-admin";
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

/** A grade's label with its education system, so two "Grade 1"s under different systems are distinct. */
function gradeWithSystem(locale: string, grade: CatalogAdminRow): string {
  const system =
    grade.parentNameAr !== null && grade.parentNameEn !== null
      ? catalogLabel(locale, { nameAr: grade.parentNameAr, nameEn: grade.parentNameEn })
      : null;
  return catalogLabel(locale, grade) + (system ? ` — ${system}` : "");
}

/**
 * The management surface behind `/admin/catalog` (R8): three kinds in tabs
 * (the lists are small and already loaded, so switching is instant), a
 * type-ahead search over both names and the parent (a subject's grades, U3),
 * a grade filter on the subject tab, and the add-via-dialog
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
  // U3 — the subject tab narrows to one grade's subjects.
  const [gradeFilter, setGradeFilter] = useState("");
  const gradeById = new Map(grades.map((grade) => [grade.id, grade]));
  const gradeNames = (row: CatalogAdminRow) =>
    row.gradeIds.flatMap((id) => {
      const grade = gradeById.get(id);
      return grade ? [grade.nameEn, grade.nameAr] : [];
    });

  const rowsByKind: Record<Kind, CatalogAdminRow[]> = {
    EDUCATION_SYSTEM: systems,
    GRADE: grades,
    SUBJECT: subjects,
  };
  const rows = rowsByKind[kind];

  // A short, client-side list: filtered on each render (the React compiler
  // memoises what is worth it).
  const words = foldPickerText(query).split(" ").filter(Boolean);
  const inGrade = kind === "SUBJECT" && gradeFilter ? rows.filter((row) => row.gradeIds.includes(gradeFilter)) : rows;
  const visible =
    words.length === 0
      ? inGrade
      : inGrade.filter((row) => {
          const haystack = foldPickerText(
            [row.nameEn, row.nameAr, row.parentNameEn, row.parentNameAr, ...gradeNames(row)]
              .filter(Boolean)
              .join(" "),
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
                setGradeFilter("");
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
          <div className={cn("grid gap-3", kind === "SUBJECT" && "sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]")}>
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
            {kind === "SUBJECT" ? (
              <Select
                id="catalog-grade-filter"
                aria-label={t("gradeFilter")}
                value={gradeFilter}
                onValueChange={setGradeFilter}
              >
                <option value="">{t("allGrades")}</option>
                {grades.map((grade) => (
                  <option key={grade.id} value={grade.id}>
                    {gradeWithSystem(tabLocale, grade)}
                  </option>
                ))}
              </Select>
            ) : null}
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

/** The parts of a usage record worth naming — zero counts are left out. A grade's children are its subject links (U3). */
function usageParts(kind: Kind, usage: CatalogUsage, t: ReturnType<typeof useTranslations>): string[] {
  return (
    [
      ["centres", usage.centres],
      ["classes", usage.classes],
      ["students", usage.students],
      ["sessions", usage.sessions],
      [kind === "GRADE" ? "linkedSubjects" : "children", usage.children],
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
  // U3 — a subject's grades, as chips (each with its system).
  const linkedGrades =
    row.kind === "SUBJECT"
      ? grades.filter((grade) => row.gradeIds.includes(grade.id)).map((grade) => ({
          id: grade.id,
          label: gradeWithSystem(locale, grade),
          active: grade.active,
        }))
      : [];
  const meta = [
    parentLabel,
    row.defaultFixedCenterShare !== null
      ? t("defaultShareValue", { amount: formatMoney(row.defaultFixedCenterShare, locale) })
      : null,
    t("usage.summary", { centres: row.usage.centres, classes: row.usage.classes }),
  ].filter(Boolean);

  const blockers = deleteState.error === "inUse" && deleteState.usage ? usageParts(row.kind, deleteState.usage, t) : [];
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
          {row.kind === "SUBJECT" ? (
            <div className="flex flex-wrap gap-1.5 sm:col-span-2" aria-label={t("fields.grades")}>
              {linkedGrades.length === 0 ? (
                <span className="text-xs text-text-muted">{t("noGrades")}</span>
              ) : (
                linkedGrades.map((grade) => (
                  <Badge key={grade.id} variant="neutral" className={cn(!grade.active && "opacity-60")}>
                    {grade.active ? grade.label : `${grade.label} · ${t("inactive")}`}
                  </Badge>
                ))
              )}
            </div>
          ) : null}
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

  // A grade's parent is an education system. A subject has no parent since
  // U3: it links to any number of grades (GradeLinksField below).
  const parentOptions =
    kind === "GRADE"
      ? systems.map((system) => ({
          value: system.id,
          label: catalogLabel(locale, system) + (system.active ? "" : ` · ${t("inactive")}`),
        }))
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

        {state.error === "linkInUse" && state.linksInUse ? (
          <LinksInUseMessage linksInUse={state.linksInUse} grades={grades} />
        ) : state.error ? (
          <FormMessage>{tErrors(state.error)}</FormMessage>
        ) : null}

        {kind === "GRADE" ? (
          <Field
            id={`${idPrefix}-parent`}
            label={t("fields.educationSystem")}
            hint={t("fields.educationSystemHint")}
            error={fieldError("parentId")}
            optional
          >
            <Select id={`${idPrefix}-parent`} name="parentId" defaultValue={row?.parentId ?? ""}>
              <option value="">{t("noEducationSystem")}</option>
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

        {kind === "SUBJECT" ? (
          <GradeLinksField
            idPrefix={idPrefix}
            systems={systems}
            grades={grades}
            defaultGradeIds={row?.gradeIds ?? []}
            error={fieldError("gradeIds")}
          />
        ) : null}

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

// ── A subject's grades (U3) ─────────────────────────────────────────────────

/**
 * The grades a subject is taught in: a checkbox list grouped by education
 * system (then the systemless grades), posted as repeated `gradeIds` fields.
 * Active grades are offered; a deactivated one shows only while it is
 * already linked, so an edit never drops it silently.
 */
function GradeLinksField({
  idPrefix,
  systems,
  grades,
  defaultGradeIds,
  error,
}: {
  idPrefix: string;
  systems: CatalogAdminRow[];
  grades: CatalogAdminRow[];
  defaultGradeIds: string[];
  error?: string;
}) {
  const t = useTranslations("AdminCatalog");
  const locale = useLocale();
  const [chosen, setChosen] = useState<string[]>(defaultGradeIds);

  const offered = grades.filter((grade) => grade.active || defaultGradeIds.includes(grade.id));
  const groups = [
    ...systems.map((system) => ({
      id: system.id,
      label: catalogLabel(locale, system),
      grades: offered.filter((grade) => grade.parentId === system.id),
    })),
    { id: "none", label: t("noEducationSystem"), grades: offered.filter((grade) => grade.parentId === null) },
  ].filter((group) => group.grades.length > 0);

  function toggle(gradeId: string, on: boolean) {
    setChosen((current) => (on ? [...current, gradeId] : current.filter((id) => id !== gradeId)));
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-text-primary">{t("fields.grades")}</legend>
      <p className="text-xs text-text-muted">{t("fields.gradesHint")}</p>
      {chosen.map((gradeId) => (
        <input key={gradeId} type="hidden" name="gradeIds" value={gradeId} />
      ))}
      {groups.length === 0 ? (
        <p className="text-xs text-text-muted">{t("noGradesYet")}</p>
      ) : (
        groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-1">
            <p className="text-xs font-semibold text-text-secondary">{group.label}</p>
            <ul className="grid gap-x-3 sm:grid-cols-2">
              {group.grades.map((grade) => (
                <li key={grade.id}>
                  <label
                    htmlFor={`${idPrefix}-grade-${grade.id}`}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-surface-hover"
                  >
                    <Checkbox
                      id={`${idPrefix}-grade-${grade.id}`}
                      checked={chosen.includes(grade.id)}
                      onCheckedChange={(checked) => toggle(grade.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 text-text-primary">
                      {catalogLabel(locale, grade)}
                      {grade.active ? null : <span className="text-text-muted"> · {t("inactive")}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
    </fieldset>
  );
}

/** "Can't remove Grade 10 — 3 active classes teach it", one line per refused link (U3). */
function LinksInUseMessage({
  linksInUse,
  grades,
}: {
  linksInUse: CatalogLinkInUse[];
  grades: CatalogAdminRow[];
}) {
  const t = useTranslations("AdminCatalog");
  const locale = useLocale();
  const gradeById = new Map(grades.map((grade) => [grade.id, grade]));
  const rows = linksInUse.map((link) => {
    const grade = gradeById.get(link.gradeId);
    return t("linkInUseRow", {
      grade: grade ? gradeWithSystem(locale, grade) : link.gradeId,
      count: link.classes,
    });
  });
  return <FormMessage>{`${t("errors.linkInUse")} ${rows.join(" · ")}`}</FormMessage>;
}
