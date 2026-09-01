import { getLocale, getTranslations } from "next-intl/server";

import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { formatNumber } from "@/lib/format";

export default async function AdminCentersPage() {
  await requirePlatformAdmin();

  const locale = await getLocale();
  const t = await getTranslations("AdminCenters");

  // Platform scope: intentionally not tenant-scoped — this is the one
  // experience that spans centers, and it only reads tenant *metadata*.
  const centers = await prisma.center.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      active: true,
      themeColor: true,
      _count: { select: { memberships: true, studentProfiles: true } },
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      {centers.length === 0 ? (
        <FormMessage tone="info">{t("empty")}</FormMessage>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {centers.map((center) => (
            <Card key={center.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                    style={{ backgroundColor: center.themeColor }}
                  >
                    {center.name.trim().charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{center.name}</span>
                  <Badge variant={center.active ? "success" : "danger"}>
                    {center.active ? t("active") : t("suspended")}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-4 text-sm text-text-secondary">
                <span dir="ltr" className="text-text-muted">
                  /{center.slug}
                </span>
                <span>
                  {t("members", {
                    count: formatNumber(center._count.memberships, locale),
                  })}
                </span>
                <span>
                  {t("students", {
                    count: formatNumber(center._count.studentProfiles, locale),
                  })}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <FormMessage tone="info">{t("milestoneNote")}</FormMessage>
    </div>
  );
}
