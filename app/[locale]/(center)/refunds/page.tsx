import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";

/**
 * The refunds ledger (spec §4.1 item 12): every payment marked `REFUNDED` at
 * this branch, most recent first. Read-only — the write path is the Refund
 * button on a session's own roster (`app/[locale]/(center)/sessions/[id]/
 * session-roster.tsx`), at the point a refund is actually decided.
 */
export default async function RefundsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "payment.refund");
  const db = scoped(ctx);

  const t = await getTranslations("Refunds");
  const locale = await getLocale();

  const refunds = await db.refunds.list();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("registerTitle")}</CardTitle>
          <CardDescription>{t("registerDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {refunds.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            refunds.map((refund) => {
              const classGroup = refund.payment.session.classGroup;
              const studentProfile = refund.payment.studentProfile;
              return (
                <div
                  key={refund.id}
                  className="flex flex-col gap-1 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-text-primary">
                      {fullName(localName(studentProfile, studentProfile.user))}
                    </p>
                    <p className="text-sm font-medium tabular-nums text-danger">
                      -{formatMoney(refund.amount, locale)}
                    </p>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {[
                      classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
                      classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {" · "}
                    {formatDate(refund.payment.session.date, locale)}
                  </p>
                  <p className="text-xs text-text-muted">{refund.reason}</p>
                  <p className="text-xs text-text-muted">
                    {t("refundedOn", { date: formatDate(refund.refundedAt, locale) })}
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
