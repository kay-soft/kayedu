import { Layers } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { SubmitButton } from "@/components/shared/submit-button";
import { NextPathInput } from "@/components/shell/next-path-input";
import { Card, CardContent } from "@/components/ui/card";
import { getOwnerOrgGroups, type TenantContext } from "@/lib/auth/tenant";
import { ROUTES } from "@/lib/routes";

/**
 * What every centre page except Analytics renders under "Whole Management"
 * (T6, docs/04-design-system.md §11.1). The page returns this before reading
 * anything — a roll-up context still holds one representative branch, and a
 * page that read it would show that branch's data under the organization's
 * name. One button per branch submits the same `selectCenterAction` as the
 * switcher, with this page as `next`, so the pick lands back here.
 */
export async function PickBranchScreen({ ctx }: { ctx: TenantContext }) {
  const [t, locale, orgGroups] = await Promise.all([
    getTranslations("Shell.pickBranch"),
    getLocale(),
    getOwnerOrgGroups(ctx.user.id),
  ]);
  // `getTenantContext` only sets `rollupOrganizationId` after finding it here.
  const group = orgGroups.find((item) => item.organizationId === ctx.rollupOrganizationId);
  const organization = group?.organizationName ?? "";

  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={<Layers />}
          tone="info"
          title={t("title")}
          description={t("description", { organization })}
          action={
            <div className="flex flex-col gap-4">
              <ul
                aria-label={t("branchesLabel", { organization })}
                className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center"
              >
                {(group?.branches ?? []).map((branch) => (
                  <li key={branch.id}>
                    <form action={selectCenterAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="selectionId" value={branch.id} />
                      <NextPathInput />
                      <SubmitButton variant="outline" className="w-full min-w-0 sm:w-auto">
                        <span className="truncate">{branch.name}</span>
                      </SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
              <LinkButton href={ROUTES.centerAnalytics} variant="ghost" className="w-full sm:w-auto sm:self-center">
                {t("backToAnalytics")}
              </LinkButton>
            </div>
          }
        />
      </CardContent>
    </Card>
  );
}
