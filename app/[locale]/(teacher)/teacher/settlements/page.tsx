import { HandCoins } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { branchesInView, getTeacherScope, showsBranches } from "@/lib/auth/teacher-scope";
import { BranchFilter } from "@/components/teacher/branch-filter";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney } from "@/lib/format";
import { sessionDisplayName } from "@/lib/session-label";

const STATUS_BADGE = {
  DRAFT: "neutral",
  APPROVED: "info",
  PAID: "success",
  CANCELLED: "danger",
} as const;

/**
 * The teacher's own read-only settlement history (spec §4.2 item 9): a union
 * of this teacher's own settlements across every center they teach at — the
 * same "one context per center, unioned in memory" shape the rest of the
 * teacher portal already uses (docs/01-data-model.md §4). Deliberately
 * outside any data-visibility window (spec §5 "Teacher settlements" —
 * carved out so a teacher can always verify they were paid).
 *
 * U7: the branches in view (All branches by default), each card naming its
 * branch, and a Branch filter under All branches.
 */
export default async function TeacherSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const rawParams = await searchParams;
  const contexts = branchesInView(scope, rawParams.branch);
  const withBranch = showsBranches(scope);
  const branchFilter = withBranch && contexts.length === 1 ? contexts[0].center.id : null;

  const t = await getTranslations("Settlements");
  const tStatus = await getTranslations("Settlements.status");
  const locale = await getLocale();

  const perCenter = await Promise.all(
    contexts.map(async (centerCtx) => ({
      center: centerCtx.center,
      settlements: await scoped(centerCtx).settlements.list({ teacherId: centerCtx.user.id }),
    })),
  );

  const rows = perCenter.flatMap(({ center, settlements }) =>
    settlements.map((settlement) => ({ center, settlement })),
  );
  rows.sort((a, b) => b.settlement.createdAt.getTime() - a.settlement.createdAt.getTime());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("teacherTitle")} description={t("teacherSubtitle")} />

      {withBranch ? (
        <BranchFilter
          branches={scope.inView.map((centerCtx) => ({ id: centerCtx.center.id, name: centerCtx.center.name }))}
          value={branchFilter ?? ""}
        />
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-3">
          {rows.length === 0 ? (
            <EmptyState
              icon={<HandCoins />}
              title={t("teacherEmpty")}
              description={t("teacherEmptyHint")}
            />
          ) : (
            rows.map(({ center, settlement }) => (
              <div
                key={settlement.id}
                className="flex flex-col gap-1 rounded-xl border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text-primary">{center.name}</p>
                  <Badge variant={STATUS_BADGE[settlement.status]}>
                    {tStatus(settlement.status)}
                  </Badge>
                </div>
                <p className="text-xs text-text-secondary">
                  {settlement.session
                    ? t("scopeSession", {
                        date: formatDate(settlement.session.date, locale),
                        class: sessionDisplayName(locale, settlement.session),
                      })
                    : t("scopePeriod", {
                        from: formatDate(settlement.periodFrom!, locale),
                        to: formatDate(settlement.periodTo!, locale),
                      })}
                </p>
                <p className="text-sm font-medium tabular-nums text-text-primary">
                  {formatMoney(settlement.totalAmount, locale)}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
