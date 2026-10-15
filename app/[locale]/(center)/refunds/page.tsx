import { Undo2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
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
            <EmptyState
              icon={<Undo2 />}
              title={t("empty")}
              description={t("emptyHint")}
            />
          ) : (
            refunds.map((refund) => {
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
                    {/* Money is never coloured (§11.9), and red is the void
                        colour; the locale's own minus, never a glued hyphen. */}
                    <p className="text-sm font-medium whitespace-nowrap tabular-nums text-text-primary">
                      {formatMoney(-refund.amount, locale)}
                    </p>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {sessionDisplayName(locale, refund.payment.session)}
                    {" · "}
                    {formatDate(refund.payment.session.date, locale)}
                  </p>
                  <p className="text-sm break-words text-text-secondary" dir="auto">{refund.reason}</p>
                  <p className="text-xs text-text-secondary">
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
