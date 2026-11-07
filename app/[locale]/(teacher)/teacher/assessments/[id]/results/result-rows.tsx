import { getLocale, getTranslations } from "next-intl/server";

import { elapsedFormatter } from "@/app/[locale]/(teacher)/teacher/assessments/[id]/results/elapsed";
import { LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import { RESULT_STATUS_BADGE, type ResultRow } from "@/lib/assessment-results";
import { formatDateTime, formatNumber } from "@/lib/format";
import { TEACHER_SURFACE, assessmentRoutes, type AssessmentSurface } from "@/lib/routes";

/**
 * The per-student results (W4, docs/04 §11.35): a table from `xl`, stacked cards
 * below it, because nine columns need the width (rule 4: never horizontal-scroll
 * primary data). One shape for both, so they cannot disagree.
 */
export async function ResultRows({
  rows,
  assessmentId,
  branchName,
  zone,
  surface = TEACHER_SURFACE,
}: {
  rows: ResultRow[];
  assessmentId: string;
  branchName: string;
  zone: string;
  /** W7b: the attempt links of the teacher's pages, or an assistant's. */
  surface?: AssessmentSurface;
}) {
  const t = await getTranslations("TeacherAssessments.results");
  const locale = await getLocale();
  const elapsed = await elapsedFormatter();
  const none = t("none");

  const cells = rows.map((row) => ({
    row,
    score: row.score !== null && row.maxScore !== null ? t("score", { score: formatNumber(row.score, locale), max: formatNumber(row.maxScore, locale) }) : none,
    percent: row.percentage !== null ? t("percent", { value: formatNumber(row.percentage, locale) }) : none,
    time:
      row.timeTakenMs !== null
        ? elapsed(row.timeTakenMs)
        : row.timeLeftMs !== null
          ? t("timeLeft", { time: elapsed(row.timeLeftMs) })
          : none,
    ended: row.finalisedBy ? t(`ended.${row.finalisedBy}`) : none,
    started: row.startedAt ? formatDateTime(row.startedAt, locale, zone) : none,
    submitted: row.submittedAt ? formatDateTime(row.submittedAt, locale, zone) : none,
    link: row.attemptId
      ? {
          href: assessmentRoutes(surface).attempt(assessmentId, row.attemptId),
          label: row.status === "SUBMITTED" ? t("viewAnswers") : t("viewProgress"),
        }
      : null,
  }));

  const status = (row: ResultRow) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={RESULT_STATUS_BADGE[row.status]}>{t(`status.${row.status}`)}</Badge>
      {row.left ? <Badge variant="neutral">{t("leftClass")}</Badge> : null}
    </div>
  );

  return (
    <>
      <div className="hidden xl:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-text-secondary">
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.student")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.branch")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.status")}</th>
              <th scope="col" className="py-2 pe-3 text-end font-medium">{t("columns.score")}</th>
              <th scope="col" className="py-2 pe-3 text-end font-medium">{t("columns.percentage")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.timeTaken")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.ended")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.startedAt")}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{t("columns.submittedAt")}</th>
              <th scope="col" className="py-2 text-end font-medium">
                <span className="sr-only">{t("columns.answers")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cells.map(({ row, score, percent, time, ended, started, submitted, link }) => (
              <tr key={row.studentProfileId} data-result-row={row.studentProfileId} className="border-b border-border last:border-b-0">
                <th scope="row" className="py-3 pe-3 text-start font-medium text-text-primary"><bdi>{row.name}</bdi></th>
                <td className="py-3 pe-3 text-text-secondary">{branchName}</td>
                <td className="py-3 pe-3">{status(row)}</td>
                <td className="py-3 pe-3 text-end tabular-nums text-text-primary">{score}</td>
                <td className="py-3 pe-3 text-end tabular-nums text-text-primary">{percent}</td>
                <td className="py-3 pe-3 whitespace-nowrap tabular-nums text-text-secondary">{time}</td>
                <td className="py-3 pe-3 text-text-secondary">{ended}</td>
                <td className="py-3 pe-3 text-xs text-text-secondary">{started}</td>
                <td className="py-3 pe-3 text-xs text-text-secondary">{submitted}</td>
                <td className="py-3 text-end">
                  {link ? <LinkButton href={link.href}>{link.label}</LinkButton> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 xl:hidden">
        {cells.map(({ row, score, percent, time, ended, started, submitted, link }) => (
          <li key={row.studentProfileId} data-result-row={row.studentProfileId} className="flex flex-col gap-3 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words text-sm font-semibold text-text-primary"><bdi>{row.name}</bdi></p>
              {status(row)}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label={t("columns.branch")} value={branchName} wide />
              {/* A phone is no place for a stack of dashes: only what this student has. */}
              {score !== none ? <Field label={t("columns.score")} value={score} numeric /> : null}
              {percent !== none ? <Field label={t("columns.percentage")} value={percent} numeric /> : null}
              {time !== none ? <Field label={t("columns.timeTaken")} value={time} numeric /> : null}
              {ended !== none ? <Field label={t("columns.ended")} value={ended} /> : null}
              {started !== none ? <Field label={t("columns.startedAt")} value={started} wide /> : null}
              {submitted !== none ? <Field label={t("columns.submittedAt")} value={submitted} wide /> : null}
            </dl>
            {link ? (
              <LinkButton href={link.href} className="w-full sm:w-fit">
                {link.label}
              </LinkButton>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function Field({ label, value, numeric, wide }: { label: string; value: string; numeric?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className={numeric ? "font-medium whitespace-nowrap tabular-nums text-text-primary" : "font-medium break-words text-text-primary"}>{value}</dd>
    </div>
  );
}
