import { getLocale, getTranslations } from "next-intl/server";
import { Building2, Check, ChevronLeft } from "lucide-react";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { AnchorButton } from "@/components/shared/link-button";
import { AuthCard } from "@/components/shared/auth-card";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { getActiveCenterId } from "@/lib/auth/active-center";
import { getCurrentUser } from "@/lib/auth/session";
import {
  getOwnerOrgGroups,
  getUserCenterRelations,
  primaryRole,
} from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";
import { cn } from "@/lib/utils";

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
  const [relations, orgGroups, activeId] = await Promise.all([
    getUserCenterRelations(user!.id),
    getOwnerOrgGroups(user!.id),
    getActiveCenterId(),
  ]);

  // Exactly one center and no "Whole Management" option → skip the hub
  // entirely (docs/02 §3). An Owner of a multi-branch organization always
  // sees the hub, even with one branch resolved today, because the roll-up
  // option lives here.
  if (relations.length === 1 && orgGroups.length === 0 && switchMode !== "1") {
    redirect({ href: homePathForRole(primaryRole(relations[0])), locale });
  }

  return (
    <div className="flex flex-col gap-4">
      <AuthCard
        title={t("title")}
        description={relations.length > 0 ? t("subtitle") : t("emptySubtitle")}
      >
        <div className="flex flex-col gap-3">
          {relations.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              tone="info"
              title={t("emptySubtitle")}
              description={t("emptyHelp")}
              action={
                /* A teacher with zero centres gets the directory, never only
                   the student Discover link (M15, spec §5.1 "Teacher
                   onboarding") — both stay offered here since a brand-new
                   sign-up's intent (student or teacher) isn't known yet. */
                <div className="flex flex-col gap-2 sm:flex-row">
                  <AnchorButton
                    href={`/${locale}${ROUTES.studentDiscover}`}
                    variant="default"
                  >
                    {t("browseClasses")}
                  </AnchorButton>
                  <AnchorButton href={`/${locale}${ROUTES.teacherCenters}`}>
                    {t("findCenterToTeach")}
                  </AnchorButton>
                </div>
              }
            />
          ) : null}

          {orgGroups.map((group) => {
            const selected = activeId === group.organizationId;
            return (
              <form key={group.organizationId} action={selectCenterAction}>
                <input type="hidden" name="locale" value={locale} />
                <input
                  type="hidden"
                  name="selectionId"
                  value={group.organizationId}
                />
                <button
                  type="submit"
                  aria-current={selected ? "true" : undefined}
                  className={cn(CHOICE_CARD, selected ? CHOICE_SELECTED : CHOICE_IDLE)}
                >
                  <span
                    aria-hidden
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground"
                  >
                    <Building2 className="size-5" />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {t("wholeManagement", { organization: group.organizationName })}
                    </span>
                    <span className="block truncate text-xs text-text-muted">
                      {t("wholeManagementHint", { count: group.branches.length })}
                    </span>
                  </span>

                  <ChoiceMark selected={selected} />
                </button>
              </form>
            );
          })}

          {relations.map((relation) => {
            const selected = activeId === relation.center.id;
            return (
              <form key={relation.center.id} action={selectCenterAction}>
                <input type="hidden" name="locale" value={locale} />
                <input
                  type="hidden"
                  name="selectionId"
                  value={relation.center.id}
                />
                <button
                  type="submit"
                  aria-current={selected ? "true" : undefined}
                  className={cn(CHOICE_CARD, selected ? CHOICE_SELECTED : CHOICE_IDLE)}
                >
                  <BrandAvatar
                    name={relation.center.name}
                    logoUrl={centerLogoSrc(relation.center)}
                    themeColor={relation.center.themeColor}
                    size="lg"
                  />

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

                  <ChoiceMark selected={selected} />
                </button>
              </form>
            );
          })}

          {user!.isPlatformAdmin ? (
            <AnchorButton
              href={`/${locale}${ROUTES.adminCenters}`}
              variant="ghost"
              className="w-full justify-start text-brand"
            >
              <Building2 className="size-4" aria-hidden />
              {t("platformAdminLink")}
            </AnchorButton>
          ) : null}
        </div>
      </AuthCard>

      <div className="rounded-xl bg-sidebar p-2">
        <SignOutButton />
      </div>
    </div>
  );
}

/** A branch / roll-up choice: one tappable card, 64px+ tall. */
const CHOICE_CARD =
  "flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-start transition-ui focus-ring active:translate-y-px sm:p-4";
const CHOICE_IDLE =
  "border-border bg-surface hover:border-border-strong hover:bg-surface-hover hover:shadow-card-hover";
// The branch you are already working in: brand outline + tint + a check, so
// "current" never depends on colour alone.
const CHOICE_SELECTED = "border-brand bg-brand/5 ring-2 ring-brand/20";

function ChoiceMark({ selected }: { selected: boolean }) {
  return selected ? (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground"
    >
      <Check className="size-3.5" />
    </span>
  ) : (
    <ChevronLeft
      aria-hidden
      className="size-4 shrink-0 text-text-muted ltr:-scale-x-100"
    />
  );
}
