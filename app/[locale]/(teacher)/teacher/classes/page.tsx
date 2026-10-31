import { getLocale, getTranslations } from "next-intl/server";
import { BookOpen } from "lucide-react";

import { ClassRequestForm } from "@/app/[locale]/(teacher)/teacher/classes/class-request-form";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, requirePermission } from "@/lib/auth/tenant";
import { branchesInView, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { BranchFilter } from "@/components/teacher/branch-filter";
import { scoped } from "@/lib/db/scoped";
import { buildCatalogPicker } from "@/lib/catalog-picker";
import { formatDate, formatTimeRange } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

const STATUS_BADGE = {
  PENDING: "warning",
  APPROVED: "success",
  DECLINED: "danger",
} as const;

type RequestPayload = {
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  // R3: pre-R3 requests may still carry `capacity` in their JSON — ignored.
  lateThresholdMinutes: number;
  note?: string | null;
};

/**
 * "Request a new class at a center where they're a trusted teacher" (spec
 * §4.2 item 4). Writes a `ChangeRequest` and lists the teacher's own — a
 * center manager reviews it at `/approvals`. The form is hidden (and the
 * action refuses) when this center has not marked the teacher trusted
 * (M10, `Membership.isTrustedTeacher`).
 *
 * U7: the page opens when any branch in view grants `changeRequest.create`.
 * The form's Branch select lists only the branches that grant it **and**
 * trust this teacher, each with its own catalog picks; the list is the
 * teacher's own requests at every granting branch in view, each naming its
 * branch — one scoped read per branch, unioned.
 */
export default async function TeacherClassesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "changeRequest.create");
  await requirePermission(ctx, "changeRequest.create");
  const rawParams = await searchParams;
  const granting = scope.inView.filter((branch) => ctxCan(branch, "changeRequest.create"));
  const withBranch = granting.length > 1;
  const listed = branchesInView({ ...scope, inView: granting }, rawParams.branch);
  const branchFilter = withBranch && listed.length === 1 ? listed[0].center.id : null;

  const t = await getTranslations("TeacherClasses");
  const tDays = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const perBranch = await Promise.all(
    granting.map(async (branch) => {
      const db = scoped(branch);
      const [systems, subjects, grades, requests] = await Promise.all([
        db.educationSystems.list(),
        db.subjects.list(),
        db.grades.list(),
        listed.includes(branch) ? db.changeRequests.list({ requestedBy: branch.user.id, type: "NEW_CLASS" }) : [],
      ]);
      // The form offers only entries still on offer — system → grade → subject, a
      // subject only under a grade it links to (U3); a past request keeps naming
      // the entry it asked for even if the platform has since deactivated it (R8),
      // so the history lookup reads the full lists — each branch's own names.
      return {
        branch,
        catalog: buildCatalogPicker({ systems, grades, subjects }, (name) => `${name} · ${tCommon("inactive")}`),
        subjectNameById: new Map(subjects.map((subject) => [subject.id, subject.name])),
        gradeNameById: new Map(grades.map((grade) => [grade.id, grade.name])),
        requests,
      };
    }),
  );
  const dayNames = tDays.raw("dayNames") as string[];

  const requestBranches = perBranch
    .filter((entry) => entry.branch.membership?.isTrustedTeacher ?? false)
    .map((entry) => ({ id: entry.branch.center.id, name: entry.branch.center.name, catalog: entry.catalog }));
  const requests = perBranch
    .flatMap((entry) => entry.requests.map((request) => ({ request, entry })))
    .sort((a, b) => b.request.createdAt.getTime() - a.request.createdAt.getTime());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={withBranch ? t("subtitleAll") : t("subtitle", { center: ctx.center.name })}
      />

      {requestBranches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("request.title")}</CardTitle>
            <CardDescription>{t("request.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ClassRequestForm branches={requestBranches} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {withBranch ? (
            <BranchFilter
              branches={granting.map((branch) => ({ id: branch.center.id, name: branch.center.name }))}
              value={branchFilter ?? ""}
            />
          ) : null}
          {requests.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={t("empty")} description={t("emptyHint")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {requests.map(({ request, entry }) => {
                const payload = request.payload as unknown as RequestPayload;
                const subject = payload.subjectId ? entry.subjectNameById.get(payload.subjectId) : undefined;
                const grade = payload.gradeId ? entry.gradeNameById.get(payload.gradeId) : undefined;
                return (
                  <li
                    key={request.id}
                    className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">
                        {[subject, grade].filter(Boolean).join(" · ") ||
                          tCommon("none")}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        {withBranch ? <span className="font-medium text-text-secondary">{entry.branch.center.name}</span> : null}
                        <span>{dayNames[payload.dayOfWeek]}</span>
                        <span>{formatTimeRange(payload.startTime, payload.endTime, locale)}</span>
                        <span>{formatDate(request.createdAt, locale)}</span>
                      </p>
                    </div>
                    <Badge variant={STATUS_BADGE[request.status]}>
                      {t(`status.${request.status}`)}
                    </Badge>
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
