import type { SignupIntent } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, Check, ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

import { switchExperienceAction } from "@/app/[locale]/(auth)/actions";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { AnchorButton } from "@/components/shared/link-button";
import { AuthCard } from "@/components/shared/auth-card";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { ExperienceGlyph } from "@/components/shell/experience-glyph";
import { ForgetStaleExperience } from "@/components/shell/forget-stale-experience";
import { Badge } from "@/components/ui/badge";
import { getActiveCenterId, getLastExperienceCookie } from "@/lib/auth/active-center";
import { resolveLastExperience, type ExperienceEntry } from "@/lib/auth/experiences";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserCenterRelations, listExperiences } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ACCOUNT_HUB_HINT, ROUTES, accountPath } from "@/lib/routes";
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
  const [relations, experiences, activeId, rememberedExperience] = await Promise.all([
    getUserCenterRelations(user!.id),
    listExperiences(user!.id),
    getActiveCenterId(),
    getLastExperienceCookie(),
  ]);

  // U7: one experience → straight into it, never the hub (a parent with no
  // branch, SYS; a student or a teacher at several branches; one staff
  // branch, which `getTenantContext` resolves on its own). An Owner of a
  // multi-branch organization always has several: each branch and the roll-up.
  if (experiences.length === 1 && switchMode !== "1") {
    redirect({ href: experiences[0].href, locale });
  }

  // D-W34: the last one used goes first, labelled, with Continue. It never
  // redirects (D-W13), and the list stays the authority: a value naming
  // anything not in it is ignored, and cleared from the browser below.
  const { entry: lastUsed, stale } = resolveLastExperience(rememberedExperience, experiences);
  const others = experiences.filter((entry) => entry.key !== lastUsed?.key);
  const hasPortal = experiences.some((entry) => entry.group.kind === "portals");
  const portals = others.filter((entry) => entry.group.kind === "portals");
  const staff = others.filter((entry) => entry.group.kind === "organization");
  const platform = others.filter((entry) => entry.group.kind === "platform");

  /** The hub's own wording for an entry; the same list the switcher renders. */
  const copyOf = (entry: ExperienceEntry): { title: string; hint: string | null } => {
    switch (entry.kind) {
      case "student":
        return { title: t("studentPortal"), hint: t("studentPortalHint") };
      case "teacher":
        return { title: t("teacherPortal"), hint: t("teacherPortalHint") };
      case "parent":
        return { title: t("parentPortal"), hint: t("parentPortalHint") };
      case "rollup":
        return {
          title: t("wholeManagement", { organization: entry.label.place ?? "" }),
          hint: t("wholeManagementHint", { count: entry.branchCount ?? 0 }),
        };
      case "staff":
        return { title: entry.label.place ?? "", hint: null };
      case "admin":
        return { title: t("platformAdminLink"), hint: null };
    }
  };

  /** One entry's form: its key only, looked up in the current list by the action. */
  const switchForm = (entry: ExperienceEntry, children: ReactNode) => (
    <form key={entry.key} action={switchExperienceAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="key" value={entry.key} />
      {children}
    </form>
  );

  const roleBadges = (entry: ExperienceEntry) =>
    entry.kind === "staff"
      ? entry.label.roles.map((role) => (
          // A role is not a status (docs/04 §14.1).
          <Badge key={role} variant="neutral">
            {tRoles(role)}
          </Badge>
        ))
      : null;

  const choiceCard = (entry: ExperienceEntry) => {
    const { title, hint } = copyOf(entry);
    // The active staff branch keeps its mark until "Last used" takes that job.
    const selected = !lastUsed && (activeId === entry.centerId || (entry.kind === "rollup" && activeId === entry.organizationId));
    return switchForm(
      entry,
      <button
        type="submit"
        aria-current={selected ? "true" : undefined}
        className={cn(CHOICE_CARD, selected ? CHOICE_SELECTED : CHOICE_IDLE)}
      >
        <EntryMark entry={entry} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{title}</span>
          {hint ? <span className="block truncate text-xs text-text-secondary">{hint}</span> : null}
          {entry.kind === "staff" ? <span className="mt-1 flex flex-wrap gap-1">{roleBadges(entry)}</span> : null}
        </span>
        <ChoiceMark selected={selected} />
      </button>,
    );
  };

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
      {stale ? <ForgetStaleExperience /> : null}
      <AuthCard
        // With nothing to choose, the title says so (DES, docs/04 §12).
        title={relations.length > 0 ? (hasPortal ? t("titleExperiences") : t("title")) : t("emptyTitle")}
        // The empty state below carries its own title — not said twice.
        description={relations.length > 0 ? (hasPortal ? t("subtitleExperiences") : t("subtitle")) : undefined}
      >
        <div className="flex flex-col gap-3">
          {lastUsed ? (
            <div className={cn("flex flex-col gap-3 rounded-xl border p-3 sm:p-4", CHOICE_SELECTED)}>
              <div className="flex items-center gap-3">
                <EntryMark entry={lastUsed} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{copyOf(lastUsed).title}</span>
                  {copyOf(lastUsed).hint ? (
                    <span className="block truncate text-xs text-text-secondary">{copyOf(lastUsed).hint}</span>
                  ) : null}
                  {/* Text, never colour alone. */}
                  <span className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="neutral">{t("lastUsed")}</Badge>
                    {roleBadges(lastUsed)}
                  </span>
                </span>
              </div>
              {switchForm(
                lastUsed,
                <SubmitButton className="w-full">
                  {t("continue")}
                  <span className="sr-only">: {copyOf(lastUsed).title}</span>
                </SubmitButton>,
              )}
            </div>
          ) : null}

          {portals.length > 0 ? (
            <nav aria-label={t("portalsLabel")} className="flex flex-col gap-3">
              {portals.map((entry) => choiceCard(entry))}
            </nav>
          ) : null}

          {hasPortal && staff.length > 0 ? (
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

          {staff.map((entry) => choiceCard(entry))}

          {platform.map((entry) =>
            switchForm(
              entry,
              <SubmitButton variant="ghost" className="w-full justify-start text-brand">
                <ExperienceGlyph icon={entry.icon} className="size-4" />
                {copyOf(entry).title}
              </SubmitButton>,
            ),
          )}
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

function EntryMark({ entry }: { entry: ExperienceEntry }) {
  if (entry.brand) {
    return (
      <BrandAvatar
        name={entry.brand.name}
        logoUrl={entry.brand.logoUrl}
        themeColor={entry.brand.themeColor}
        size="lg"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-lg",
        entry.kind === "rollup" ? "bg-brand text-brand-foreground" : "bg-brand/10 text-brand",
      )}
    >
      <ExperienceGlyph icon={entry.icon} className="size-5" />
    </span>
  );
}

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
