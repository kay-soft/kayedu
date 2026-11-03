import { getLocale, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { sessionZone, type TeacherAssessmentListRow } from "@/lib/db/assessments";
import { formatDateTime } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

export type AssessmentListEntry = {
  row: TeacherAssessmentListRow;
  branchName: string;
  /** The branch's zone — an exam with no session shows its times in it. */
  branchZone: string;
};

/**
 * A teacher's exams and homework as stacked link cards (docs/04 §11.33): the
 * type and status as neutral/info badges with text, the class, the branch
 * under All branches, the window or deadline in its own timezone, and the
 * question count. One list for the Exams & homework page, a class page and a
 * session page.
 */
export async function AssessmentList({
  entries,
  showBranch,
  showClass = true,
}: {
  entries: AssessmentListEntry[];
  showBranch: boolean;
  showClass?: boolean;
}) {
  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();

  return (
    <ul className="flex flex-col gap-3">
      {entries.map(({ row, branchName, branchZone }) => {
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
          <li key={row.id}>
            <Link
              href={ROUTES.teacherAssessment(row.id)}
              className="flex min-h-11 flex-col gap-2 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p dir="auto" className="min-w-0 break-words text-sm font-semibold text-text-primary">
                  {row.title || t("untitled")}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                  {showClass ? (
                    <span className="font-medium text-text-secondary">{sessionDisplayName(locale, { classGroup: row.classGroup })}</span>
                  ) : null}
                  {showBranch ? <span>{branchName}</span> : null}
                  <span>{timing}</span>
                  <span>{t("questionCount", { count: row._count.questions })}</span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge variant="neutral">{t(`type.${row.type}`)}</Badge>
                <Badge variant={row.status === "PUBLISHED" ? "info" : "neutral"}>{t(`status.${row.status}`)}</Badge>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
