import type { SignupIntent } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, Check, ChevronLeft, GraduationCap, Presentation, Users } from "lucide-react";
import type { ReactNode } from "react";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { AnchorButton } from "@/components/shared/link-button";
import { AuthCard } from "@/components/shared/auth-card";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { getActiveCenterId } from "@/lib/auth/active-center";
import { isCenterStaffRole } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import {
  experienceHomes,
  getOwnerOrgGroups,
  getUserCenterRelations,
  getParentChildren,
} from "@/lib/auth/tenant";
import { Link, redirect } from "@/lib/i18n/navigation";
import { ACCOUNT_HUB_HINT, ROUTES, accountPath } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";
import { cn } from "@/lib/utils";

/** The student's own start: onboarding while their grade is unset, else Discover (F4). */
function onboardingStart(user: { signupIntent: SignupIntent | null; gradeId: string | null }): string {
  return user.signupIntent === "STUDENT" && !user.gradeId ? ROUTES.studentOnboarding : ROUTES.studentDiscover;
}

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
  const tShell = await getTranslations("Shell");

  const { switch: switchMode } = await searchParams;
  const [relations, orgGroups, activeId, children, homes] = await Promise.all([
    getUserCenterRelations(user!.id),
    getOwnerOrgGroups(user!.id),
    getActiveCenterId(),
    getParentChildren(user!.id),
    experienceHomes(user!),
  ]);

  // U7: one experience → straight into it, never the hub (a parent with no
  // branch, SYS; a student or a teacher at several branches; one staff
  // branch, which `getTenantContext` resolves on its own). An Owner of a
  // multi-branch organization always has several: each branch and the roll-up.
  if (homes.length === 1 && switchMode !== "1") {
    redirect({ href: homes[0].href, locale });
  }

  // The hub offers experiences (U7): the student, teacher and parent portals —
  // each spans every branch, so none is a branch card — then the branches this
  // person works at as staff, as before.
  const staffRelations = relations.filter((relation) => relation.roles.some((role) => isCenterStaffRole(role)));
  const portals: { key: string; href: string; icon: ReactNode; title: string; hint: string }[] = [
    ...(relations.some((relation) => relation.roles.includes("STUDENT"))
      ? [{ key: "student", href: ROUTES.studentSchedule, icon: <GraduationCap className="size-5" />, title: t("studentPortal"), hint: t("studentPortalHint") }]
      : []),
    ...(relations.some((relation) => relation.roles.includes("TEACHER"))
      ? [{ key: "teacher", href: ROUTES.teacherDashboard, icon: <Presentation className="size-5" />, title: t("teacherPortal"), hint: t("teacherPortalHint") }]
      : []),
    ...(children.linked.length > 0
      ? [{ key: "parent", href: ROUTES.parentHome, icon: <Users className="size-5" />, title: t("parentPortal"), hint: t("parentPortalHint") }]
      : []),
  ];

  // F4: the three starting points, the person's declared sign-up intent first
  // (and highlighted). A null intent keeps today's order and emphasis. All three
  // stay offered — the intent routes, it never restricts.
  const startActions = [
    { intent: "STUDENT", href: `/${locale}${onboardingStart(user!)}`, label: t("browseClasses") },
    { intent: "TEACHER", href: `/${locale}${ROUTES.teacherCenters}`, label: t("findCenterToTeach") },
    { intent: "PARENT", href: `/${locale}${ROUTES.familyJoin}`, label: t("linkMyChild") },
  ] as const;
  const orderedStart = user!.signupIntent
    ? [...startActions].sort(
        (a, b) => Number(b.intent === user!.signupIntent) - Number(a.intent === user!.signupIntent),
      )
    : startActions;

  return (
    <div className="flex flex-col gap-4">
      <AuthCard
        // With nothing to choose, the title says so (DES, docs/04 §12).
        title={relations.length > 0 ? (portals.length > 0 ? t("titleExperiences") : t("title")) : t("emptyTitle")}
        // The empty state below carries its own title — not said twice.
        description={relations.length > 0 ? (portals.length > 0 ? t("subtitleExperiences") : t("subtitle")) : undefined}
      >
        <div className="flex flex-col gap-3">
          {portals.length > 0 ? (
            <nav aria-label={t("portalsLabel")} className="flex flex-col gap-3">
              {portals.map((portal) => (
                <Link key={portal.key} href={portal.href} className={cn(CHOICE_CARD, CHOICE_IDLE)}>
                  <span
                    aria-hidden
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
                  >
                    {portal.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{portal.title}</span>
                    <span className="block truncate text-xs text-text-secondary">{portal.hint}</span>
                  </span>
                  <ChoiceMark selected={false} />
                </Link>
              ))}
            </nav>
          ) : null}

          {portals.length > 0 && (staffRelations.length > 0 || orgGroups.length > 0) ? (
            <p className="pt-1 text-xs font-medium text-text-muted">{t("branchesHeading")}</p>
          ) : null}

          {relations.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              tone="info"
              title={t("emptySubtitle")}
              description={t("emptyHelp")}
              className="px-0 py-4 sm:py-6"
              action={
                /* A teacher with zero centres gets the directory, never only
                   the student Discover link (M15, spec §5.1 "Teacher
                   onboarding") — both stay offered here since a brand-new
                   sign-up's intent (student, teacher or parent) isn't known
                   yet. F3: a parent links a child with a code. */
                <div className="grid w-full gap-2 sm:flex sm:flex-wrap">
                  {orderedStart.map((action, index) => (
                    <AnchorButton
                      key={action.intent}
                      href={action.href}
                      variant={index === 0 ? "default" : undefined}
                      className="w-full sm:w-auto"
                    >
                      {action.label}
                    </AnchorButton>
                  ))}
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
                    <span className="block truncate text-xs text-text-secondary">
                      {t("wholeManagementHint", { count: group.branches.length })}
                    </span>
                  </span>

                  <ChoiceMark selected={selected} />
                </button>
              </form>
            );
          })}

          {staffRelations.map((relation) => {
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
                      {relation.roles.filter((role) => isCenterStaffRole(role)).map((role) => (
                        // A role is not a status (docs/04 §14.1).
                        <Badge key={role} variant="neutral">
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

      {/* F2: the hub has no user menu, so its account link sits here. */}
      <AnchorButton
        href={`/${locale}${accountPath(ACCOUNT_HUB_HINT)}`}
        variant="ghost"
        className="w-full font-medium text-text-secondary hover:text-text-primary"
      >
        {tShell("accountSettings")}
      </AnchorButton>

      {/* The light sign-out (docs/04 §14.3) — the navy slab it used to be was
          the heaviest thing on the screen. */}
      <SignOutButton variant="light" />
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
