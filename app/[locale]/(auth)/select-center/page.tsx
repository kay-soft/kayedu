import { getLocale, getTranslations } from "next-intl/server";
import { Building2, ChevronLeft } from "lucide-react";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserCenterRelations, primaryRole } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

export default async function SelectCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ switch?: string }>;
}) {
  const locale = await getLocale();
  const user = await getCurrentUser();
  if (!user) redirect({ href: ROUTES.login, locale });

  const t = await getTranslations("Auth.selectCenter");
  const tRoles = await getTranslations("Roles");

  const { switch: switchMode } = await searchParams;
  const relations = await getUserCenterRelations(user!.id);

  // Exactly one center → skip the hub entirely (docs/02 §3).
  if (relations.length === 1 && switchMode !== "1") {
    redirect({ href: homePathForRole(primaryRole(relations[0])), locale });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-2 sm:p-4">
        <CardHeader>
          <CardTitle className="text-xl font-bold">{t("title")}</CardTitle>
          <CardDescription>
            {relations.length > 0 ? t("subtitle") : t("emptySubtitle")}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {relations.length === 0 ? (
            <>
              <FormMessage tone="info">{t("emptyHelp")}</FormMessage>
              <a
                href={`/${locale}${ROUTES.studentDiscover}`}
                className="flex min-h-11 items-center justify-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-foreground hover:opacity-90"
              >
                {t("browseClasses")}
              </a>
            </>
          ) : null}

          {relations.map((relation) => (
            <form key={relation.center.id} action={selectCenterAction}>
              <input type="hidden" name="locale" value={locale} />
              <input
                type="hidden"
                name="centerId"
                value={relation.center.id}
              />
              <button
                type="submit"
                className="flex w-full min-h-16 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-start transition-shadow hover:shadow-card-hover sm:p-4"
              >
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg text-base font-bold text-brand-foreground"
                  style={{ backgroundColor: relation.center.themeColor }}
                >
                  {relation.center.name.trim().charAt(0)}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {relation.center.name}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {relation.roles.map((role) => (
                      <Badge key={role} variant="brand">
                        {tRoles(role)}
                      </Badge>
                    ))}
                  </span>
                </span>

                <ChevronLeft
                  aria-hidden
                  className="size-4 shrink-0 text-text-muted ltr:-scale-x-100"
                />
              </button>
            </form>
          ))}

          {user!.isPlatformAdmin ? (
            <a
              href={`/${locale}${ROUTES.adminCenters}`}
              className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-brand hover:bg-surface-subtle"
            >
              <Building2 className="size-4" />
              {t("platformAdminLink")}
            </a>
          ) : null}
        </CardContent>
      </Card>

      <div className="rounded-xl bg-sidebar p-2">
        <SignOutButton />
      </div>
    </div>
  );
}
