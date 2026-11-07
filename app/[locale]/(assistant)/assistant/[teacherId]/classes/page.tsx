import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantScope, scopeBranches } from "@/lib/auth/assistant-context";
import { assistantClassList } from "@/lib/db/assistant-reads";
import { prisma } from "@/lib/db/client";
import { formatDayRange, formatNumber, formatTimeRange } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.classes");
  return { title: t("title") };
}

/**
 * The teacher's classes, for their assistant (W7b, D-W37 item 4; docs/04
 * §11.36) — read-only: every class the teacher teaches at each branch where
 * `assistantCan` grants `classes.view`, one scoped read per branch (U7), each
 * opening its sessions and roster. Nothing here writes; `classes.view` never
 * allows a write.
 */
export default async function AssistantClassesPage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const branches = scopeBranches(scope, "classes.view");
  if (branches.length === 0) notFound();

  const t = await getTranslations("Assistants.work.classes");
  const tDays = await getTranslations("Classes");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];
  const several = branches.length > 1;

  const perBranch = await Promise.all(
    branches.map(async (branch) => ({
      branch,
      classes: await assistantClassList(prisma, { centerId: branch.centerId, teacherUserId: teacherId }),
    })),
  );
  const rows = perBranch.flatMap(({ branch, classes }) => classes.map((classGroup) => ({ branch, classGroup })));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { teacher: scope.link.teacherName })} />
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("listTitle")}</CardTitle>
          <CardDescription>{t("readOnly")}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map(({ branch, classGroup }) => (
                <li key={classGroup.id}>
                  <Link
                    href={ROUTES.assistantClass(teacherId, classGroup.id)}
                    className="flex min-h-11 flex-col gap-2 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-semibold text-text-primary">{sessionDisplayName(locale, { classGroup })}</span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                        {several ? <span className="font-medium text-text-secondary">{branch.centerName}</span> : null}
                        {classGroup.schedules.map((slot) => (
                          <span key={slot.id}>
                            {dayNames[slot.dayOfWeek]} · <span dir="ltr">{formatTimeRange(slot.startTime, slot.endTime, locale)}</span>
                          </span>
                        ))}
                        <span>{formatDayRange(classGroup.startDate, classGroup.endDate, locale)}</span>
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="text-xs tabular-nums text-text-secondary">
                        {t("students", { count: classGroup._count.enrollments, n: formatNumber(classGroup._count.enrollments, locale) })}
                      </span>
                      {classGroup.active ? null : <Badge variant="neutral">{t("inactive")}</Badge>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
