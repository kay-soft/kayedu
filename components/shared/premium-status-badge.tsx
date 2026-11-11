import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { PremiumStatus } from "@/lib/auth/premium";
import { formatDay } from "@/lib/format";
import { dayMarker } from "@/lib/scheduling";

/** The last covered day of a premium period, as the page's locale writes a day. */
export function premiumDayLabel(endDay: string, locale: string): string {
  return formatDay(dayMarker(endDay), locale);
}

/**
 * A premium status in words (W6, D-W35) — the admin's Teachers page and the
 * account's Premium card show the same three states the same way: Not premium,
 * Premium until <date>, Expired on <date>. Within `PREMIUM_ENDING_SOON_DAYS` a
 * second, amber badge says "Ends in n days". The state is always text, never
 * colour alone.
 */
export function PremiumStatusBadge({ status }: { status: PremiumStatus }) {
  const t = useTranslations("Premium.status");
  const locale = useLocale();

  if (status.kind === "none") return <Badge variant="neutral">{t("none")}</Badge>;
  if (status.kind === "expired") {
    return <Badge variant="neutral">{t("expired", { date: premiumDayLabel(status.endDay, locale) })}</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant="success">{t("active", { date: premiumDayLabel(status.endDay, locale) })}</Badge>
      {status.endingSoon ? <Badge variant="warning">{t("endsIn", { count: status.daysLeft })}</Badge> : null}
    </span>
  );
}
