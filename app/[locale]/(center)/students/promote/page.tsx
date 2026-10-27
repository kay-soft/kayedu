import { getLocale, getTranslations } from "next-intl/server";
import { History } from "lucide-react";

import { PromoteSelectors } from "@/app/[locale]/(center)/students/promote/promote-selectors";
import {
  PromotionPreview,
  type PreviewStudent,
} from "@/app/[locale]/(center)/students/promote/promotion-preview";
import { UndoPromotionButton } from "@/app/[locale]/(center)/students/promote/undo-promotion-button";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { catalogGradeById } from "@/lib/db/account-study";
import { prisma } from "@/lib/db/client";
import { promotionActorNames, promotionPreview } from "@/lib/db/promotion";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { PROMOTION_UNDO_DAYS, isWithinUndoWindow } from "@/lib/promotion";
import { ROUTES } from "@/lib/routes";

/**
 * Promote students (F4, docs/00 §4.1 item 4, docs/04 §11.23) — a bulk grade
 * promotion you can see before it happens, leave people out of, and undo.
 * `student.promote` (Manager baseline; Owner always). The preview is plain URL
 * state (`?from=&to=`); the only writes are the confirm and the undo actions.
 * It moves this branch's grade on file for the ticked students and nothing
 * else — never enrolments, classes, sessions, money, other branches or a
 * student's own account grade.
 */
export default async function PromoteStudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "student.promote");

  const { from: fromParam, to: toParam } = await searchParams;
  const db = scoped(ctx);
  const [t, tCommon, locale, grades, batches, latestOpen] = await Promise.all([
    getTranslations("Students.promote"),
    getTranslations("Settings.common"),
    getLocale(),
    db.grades.list(),
    db.gradePromotions.recent(10),
    db.gradePromotions.latestOpen(),
  ]);

  const label = (grade: (typeof grades)[number]) =>
    grade.active && grade.catalogActive ? grade.name : `${grade.name} · ${tCommon("inactive")}`;
  // From: any grade the branch holds students in (even one the platform has
  // since deactivated). To: only grades still on offer (R8).
  const fromGrades = grades.map((grade) => ({ value: grade.id, label: label(grade) }));
  const toGrades = grades
    .filter((grade) => grade.active && grade.catalogActive)
    .map((grade) => ({ value: grade.id, label: grade.name }));

  const from = grades.find((grade) => grade.id === fromParam);
  const to = toGrades.find((grade) => grade.value === toParam);
  const same = Boolean(from && to && from.id === to.value);
  const ready = Boolean(from && to && !same);

  const rows = ready ? await promotionPreview(prisma, ctx.center.id, from!.id) : [];
  // The account grade shown beside a student whose own account says otherwise
  // — this branch's rename when it offers that grade, the catalog name when not.
  const accountGradeIds = [...new Set(rows.map((row) => row.accountGradeId).filter((id): id is string => id !== null))];
  const accountGrades = new Map<string, string>();
  await Promise.all(
    accountGradeIds.map(async (id) => {
      const offered = grades.find((grade) => grade.id === id);
      if (offered) return void accountGrades.set(id, offered.name);
      const global = await catalogGradeById(prisma, id);
      if (global) accountGrades.set(id, catalogLabel(locale, global));
    }),
  );
  const students: PreviewStudent[] = rows.map((row) => ({
    id: row.id,
    code: row.studentCode,
    name: fullName(localName(row, row.user)),
    accountGrade: row.accountGradeId ? (accountGrades.get(row.accountGradeId) ?? null) : null,
    activeEnrollments: row.activeEnrollments,
  }));

  const actors = await promotionActorNames(
    prisma,
    batches.flatMap((batch) => [batch.createdBy, ...(batch.undoneBy ? [batch.undoneBy] : [])]),
  );
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description", { days: PROMOTION_UNDO_DAYS })}
        back={{ href: ROUTES.centerStudents, label: t("backToStudents") }}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("chooseTitle")}</CardTitle>
          <CardDescription>{t("chooseDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {toGrades.length < 1 || grades.length < 2 ? (
            <FormMessage tone="info">{t("needsGrades")}</FormMessage>
          ) : (
            <PromoteSelectors
              from={from?.id ?? ""}
              to={to?.value ?? ""}
              fromGrades={fromGrades}
              toGrades={toGrades}
            />
          )}
          {same ? <FormMessage tone="warning">{t("sameGrade")}</FormMessage> : null}
        </CardContent>
      </Card>

      {ready ? (
        <ResultsRegion>
          <Card>
            <CardHeader>
              <CardTitle>{t("previewTitle", { from: from!.name, to: to!.label })}</CardTitle>
              <CardDescription>{t("previewDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PromotionPreview
                students={students}
                fromId={from!.id}
                toId={to!.value}
                fromLabel={from!.name}
                toLabel={to!.label}
              />
            </CardContent>
          </Card>
        </ResultsRegion>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("historyTitle")}</CardTitle>
          <CardDescription>{t("historyDescription", { days: PROMOTION_UNDO_DAYS })}</CardDescription>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <EmptyState compact icon={<History />} title={t("historyEmpty")} description={t("historyEmptyHint")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {batches.map((batch) => {
                const fromName = catalogLabelWithSelection(locale, batch.fromGrade) ?? "";
                const toName = catalogLabelWithSelection(locale, batch.toGrade) ?? "";
                const undoable =
                  latestOpen?.id === batch.id && !batch.undoneAt && isWithinUndoWindow(batch.createdAt, now);
                return (
                  <li
                    key={batch.id}
                    className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-sm font-medium break-words text-text-primary">
                        {t("historyRoute", { from: fromName, to: toName })}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {t("historyMeta", {
                          date: formatDate(batch.createdAt, locale),
                          count: batch._count.items,
                          by: actors.get(batch.createdBy) ?? "—",
                        })}
                      </p>
                      {batch.undoneAt ? (
                        <p className="text-xs text-text-muted">
                          {t("historyUndone", {
                            date: formatDate(batch.undoneAt, locale),
                            by: (batch.undoneBy && actors.get(batch.undoneBy)) || "—",
                          })}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {batch.undoneAt ? <Badge variant="neutral">{t("statusUndone")}</Badge> : null}
                      {undoable ? (
                        <UndoPromotionButton batchId={batch.id} fromLabel={fromName} toLabel={toName} />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
