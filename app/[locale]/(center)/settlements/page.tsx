import { HandCoins } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PeriodSettlementForm } from "@/app/[locale]/(center)/settlements/period-settlement-form";
import { SettlementTransitionActions } from "@/app/[locale]/(center)/settlements/settlement-transition-actions";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { sessionDisplayName } from "@/lib/session-label";

const STATUS_BADGE = {
  DRAFT: "neutral",
  APPROVED: "info",
  PAID: "success",
} as const;

/**
 * The centre-side settlement register (spec §4.1 item 11): create a
 * settlement (a session's own payout, from the session detail page, or a
 * period roll-up here), then approve/pay it. `/teacher/settlements` is this
 * screen's read-only teacher-side mirror.
 */
export default async function SettlementsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "settlement.manage");
  const db = scoped(ctx);

  const t = await getTranslations("Settlements");
  const tStatus = await getTranslations("Settlements.status");
  const locale = await getLocale();

  const [settlements, teacherMemberships] = await Promise.all([
    db.settlements.list(),
    db.teachers.list({ active: true }),
  ]);

  const teacherOptions = teacherMemberships
    .map((membership) => ({
      id: membership.userId,
      name: fullName(localName(membership, membership.user)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teacherNameById = new Map(teacherOptions.map((teacher) => [teacher.id, teacher.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("createPeriodTitle")}</CardTitle>
          <CardDescription>{t("createPeriodDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {teacherOptions.length === 0 ? (
            <p className="text-sm text-text-muted">{t("noTeachers")}</p>
          ) : (
            <PeriodSettlementForm teachers={teacherOptions} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("registerTitle")}</CardTitle>
          <CardDescription>{t("registerDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {settlements.length === 0 ? (
            <EmptyState
              icon={<HandCoins />}
              title={t("empty")}
              description={t("emptyHint")}
            />
          ) : (
            settlements.map((settlement) => (
              <div
                key={settlement.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                    {teacherNameById.get(settlement.teacherId) ?? t("unknownTeacher")}
                    <Badge variant={STATUS_BADGE[settlement.status]}>
                      {tStatus(settlement.status)}
                    </Badge>
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
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
                  <p className="mt-1 text-sm font-medium tabular-nums text-text-primary">
                    {formatMoney(settlement.totalAmount, locale)}
                  </p>
                </div>
                <SettlementTransitionActions id={settlement.id} status={settlement.status} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
