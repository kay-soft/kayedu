import { HandCoins } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getTeacherContexts, getTenantContext } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney } from "@/lib/format";

const STATUS_BADGE = {
  DRAFT: "neutral",
  APPROVED: "info",
  PAID: "success",
} as const;

/**
 * The teacher's own read-only settlement history (spec §4.2 item 9): a union
 * of this teacher's own settlements across every center they teach at — the
 * same "one context per center, unioned in memory" shape the rest of the
 * teacher portal already uses (docs/01-data-model.md §4). Deliberately
 * outside any data-visibility window (spec §5 "Teacher settlements" —
 * carved out so a teacher can always verify they were paid).
 */
export default async function TeacherSettlementsPage() {
  const ctx = await getTenantContext("teacher");
  const contexts = await getTeacherContexts(ctx.user.id);

  const t = await getTranslations("Settlements");
  const tStatus = await getTranslations("Settlements.status");
  const locale = await getLocale();

  const perCenter = await Promise.all(
    contexts.map(async (centerCtx) => ({
      center: centerCtx.center,
      settlements: await scoped(centerCtx).settlements.list({ teacherId: ctx.user.id }),
    })),
  );

  const rows = perCenter.flatMap(({ center, settlements }) =>
    settlements.map((settlement) => ({ center, settlement })),
  );
  rows.sort((a, b) => b.settlement.createdAt.getTime() - a.settlement.createdAt.getTime());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("teacherTitle")} description={t("teacherSubtitle")} />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
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
                        class: [
                          settlement.session.classGroup.subject
                            ? catalogLabelWithSelection(locale, settlement.session.classGroup.subject)
                            : null,
                          settlement.session.classGroup.grade
                            ? catalogLabelWithSelection(locale, settlement.session.classGroup.grade)
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · "),
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
