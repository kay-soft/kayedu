import { getLocale, getTranslations } from "next-intl/server";

import { BarChart3 } from "lucide-react";

import { LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import type { ResultProgress } from "@/lib/db/assessment-results";
import { sessionZone, type TeacherAssessmentListRow } from "@/lib/db/assessments";
import { formatDateTime, formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { TEACHER_SURFACE, assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

export type AssessmentListEntry = {
  row: TeacherAssessmentListRow;
  branchName: string;
  /** The branch's zone — an exam with no session shows its times in it. */
  branchZone: string;
  /** "submitted / eligible" (W4); only a published row has it. */
  progress?: ResultProgress;
  /** W9 (D-W42 item 7): a PERSONAL workspace's row — always named, tagged "Private". */
  isPrivate?: boolean;
};

/**
 * A teacher's exams and homework as stacked link cards (docs/04 §11.33): the
 * type and status as neutral/info badges with text, the class, the branch
 * under All branches, the window or deadline in its own timezone, and the
 * question count. A published row adds "submitted / eligible" and its Results
 * action beside the row's own link (W4). One list for the Exams & homework page,
 * a class page and a session page.
 */
export async function AssessmentList({
  entries,
  showBranch,
  showClass = true,
  surface = TEACHER_SURFACE,
}: {
  entries: AssessmentListEntry[];
  showBranch: boolean;
  showClass?: boolean;
  /** W7b: the teacher's own pages, or an assistant's for one teacher. */
  surface?: AssessmentSurface;
}) {
  const routes = assessmentRoutes(surface);
  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();

  return (
    <ul className="flex flex-col gap-3">
      {entries.map(({ row, branchName, branchZone, progress, isPrivate }) => {
        const zone = row.session ? sessionZone(row.session, branchZone) : branchZone;
        const timing =
          row.type === "HOMEWORK"
            ? row.deadline
              ? t("deadlineValue", { date: formatDateTime(row.deadline, locale, zone) })
              : t("deadlineNotSet")
            : row.windowStart && row.windowEnd
              ? t("windowValue", {
                  start: formatDateTime(row.windowStart, locale, zone),
                  end: formatDateTime(row.windowEnd, locale, zone),
                })
              : t("windowNotSet");
        return (
          <li
            key={row.id}
            className="flex flex-col gap-3 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
          >
            <Link href={routes.detail(row.id)} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center">
              <p dir="auto" className="min-w-0 break-words text-sm font-semibold text-text-primary">
                {row.title || t("untitled")}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                {showClass ? (
                  <span className="font-medium text-text-secondary">{sessionDisplayName(locale, { classGroup: row.classGroup })}</span>
                ) : null}
                {showBranch || isPrivate ? <span dir="auto">{branchName}</span> : null}
                <span>{timing}</span>
                <span>{t("questionCount", { count: row._count.questions })}</span>
              </p>
            </Link>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge variant="neutral">{t(`type.${row.type}`)}</Badge>
              <Badge variant={row.status === "PUBLISHED" ? "info" : "neutral"}>{t(`status.${row.status}`)}</Badge>
              {isPrivate ? <Badge variant="neutral">{t("privateTag")}</Badge> : null}
              {progress ? (
                <span data-result-progress className="text-xs font-medium tabular-nums text-text-secondary">
                  {t("results.progress", { submitted: formatNumber(progress.submitted, locale), eligible: formatNumber(progress.eligible, locale) })}
                </span>
              ) : null}
              {row.status === "PUBLISHED" ? (
                <LinkButton href={routes.results(row.id)}>
                  <BarChart3 className="size-4" aria-hidden />
                  {t("results.action")}
                </LinkButton>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
