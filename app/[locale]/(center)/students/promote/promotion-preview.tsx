"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { confirmPromotionAction } from "@/app/[locale]/(center)/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PROMOTION_UNDO_DAYS } from "@/lib/promotion";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export type PreviewStudent = {
  id: string;
  code: string;
  name: string;
  /** The student's own account grade, only when it differs from the branch's. */
  accountGrade: string | null;
  activeEnrollments: number;
};

/**
 * Steps 2 and 3 — the preview and the confirm (docs/04 §11.23). Every active
 * student at this branch in the From grade, all ticked; untick to leave
 * someone out; search narrows the list, and Select all / none act on what the
 * search shows. Nothing is written until the one confirm button, which posts
 * exactly the ticked ids — the server then re-checks each is still active and
 * still in the From grade.
 *
 * It states what promotion never touches. The rows say enrolments are kept
 * because they are: only this branch's grade on file moves.
 */
export function PromotionPreview({
  students,
  fromId,
  toId,
  fromLabel,
  toLabel,
}: {
  students: PreviewStudent[];
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
}) {
  const t = useTranslations("Students.promote");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(confirmPromotionAction, IDLE_PEOPLE_STATE);
  // Unticked rather than ticked: a fresh preview is "everyone", and a row that
  // vanishes after a promotion simply stops mattering.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return students;
    return students.filter(
      (student) => student.name.toLowerCase().includes(needle) || student.code.toLowerCase().includes(needle),
    );
  }, [students, query]);

  const ticked = students.filter((student) => !unticked.has(student.id));

  function setMany(ids: string[], checked: boolean) {
    setUnticked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="fromGradeId" value={fromId} />
      <input type="hidden" name="toGradeId" value={toId} />
      {ticked.map((student) => (
        <input key={student.id} type="hidden" name="studentIds" value={student.id} />
      ))}

      {state.error ? <FormMessage>{tErrors.has(state.error) ? tErrors(state.error) : tErrors("generic")}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">
          {t("done", { count: state.count ?? 0, days: PROMOTION_UNDO_DAYS })}
          {state.skipped ? ` ${t("doneSkipped", { skipped: state.skipped })}` : ""}
        </FormMessage>
      ) : null}

      {students.length === 0 ? (
        <FormMessage tone="info">{t("noStudents", { from: fromLabel })}</FormMessage>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="relative sm:max-w-xs sm:flex-1">
              <label htmlFor="promote-search" className="sr-only">
                {t("searchLabel")}
              </label>
              <Search
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
                aria-hidden
              />
              <Input
                id="promote-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchPlaceholder")}
                autoComplete="off"
                className="ps-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => setMany(visible.map((student) => student.id), true)}
              >
                {t("selectAll")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => setMany(visible.map((student) => student.id), false)}
              >
                {t("selectNone")}
              </Button>
            </div>
          </div>

          <p className="text-sm text-text-secondary" aria-live="polite">
            {t("selectedCount", { selected: ticked.length, total: students.length })}
          </p>

          {visible.length === 0 ? (
            <FormMessage tone="info">{t("noSearchMatches")}</FormMessage>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((student) => {
                const checked = !unticked.has(student.id);
                return (
                  <li key={student.id}>
                    <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-ui-fast hover:bg-surface-hover has-[[data-checked]]:border-brand/40 has-[[data-checked]]:bg-brand/5">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => setMany([student.id], next === true)}
                        aria-label={t("tick", { name: student.name })}
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4">
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <Badge variant="brand">
                            <Ltr>{student.code}</Ltr>
                          </Badge>
                          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{student.name}</span>
                        </span>
                        {student.accountGrade ? (
                          <Badge variant="warning" className="w-fit">
                            {t("accountSays", { grade: student.accountGrade })}
                          </Badge>
                        ) : null}
                        <span className="text-xs text-text-secondary md:w-60 md:text-end">
                          {student.activeEnrollments > 0
                            ? t("enrollments", { count: student.activeEnrollments })
                            : t("noEnrollments")}
                          {" · "}
                          {t("enrollmentKept")}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-xs text-text-secondary">{t("confirmNote", { days: PROMOTION_UNDO_DAYS })}</p>
            <SubmitButton className="w-full sm:w-fit" disabled={ticked.length === 0}>
              <ArrowUpRight className="size-4" aria-hidden />
              {t("confirm", { count: ticked.length, from: fromLabel, to: toLabel })}
            </SubmitButton>
          </div>
        </>
      )}
    </form>
  );
}
