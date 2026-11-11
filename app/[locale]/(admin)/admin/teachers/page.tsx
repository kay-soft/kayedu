import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { PremiumConsole } from "@/app/[locale]/(admin)/admin/teachers/premium-console";
import { PageHeader } from "@/components/shared/page-header";
import { premiumLatestEndDay, premiumToday } from "@/lib/auth/premium";
import { requirePlatformAdmin } from "@/lib/auth/tenant";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AdminPremium");
  return { title: t("title") };
}

/**
 * Teachers (W6, D-W35) — premium for one account at a time, found by its exact
 * email. Platform admin only (the layout's gate, this page's, and every action
 * and `lib/db/premium.ts` function again). Nothing is listed: there is no
 * browsing of users and no list of premium accounts in v1 (backlog).
 */
export default async function AdminTeachersPage() {
  await requirePlatformAdmin();
  const t = await getTranslations("AdminPremium");
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <PremiumConsole todayIso={premiumToday(now)} latestIso={premiumLatestEndDay(now)} />
    </div>
  );
}
