import type { User } from "@prisma/client";
import { Baby, Check, GraduationCap, KeyRound, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  CancelInvitationButton,
  InviteParentButton,
  RegenerateInvitationButton,
  UnlinkChildButton,
} from "@/app/[locale]/account/family-controls";
import { LeaveAssistantButton } from "@/app/[locale]/account/assistant-controls";
import { StudyDetailsForm } from "@/app/[locale]/account/study-details-form";
import { TeacherHistoryForm } from "@/app/[locale]/account/teacher-history-form";
import { AssistantPermissionList } from "@/components/assistants/assistant-permission-list";
import { JoinAssistantForm } from "@/components/assistants/join-assistant-form";
import { JoinFamilyForm } from "@/components/family/join-family-form";
import { EmptyState } from "@/components/shared/empty-state";
import { Ltr } from "@/components/shared/ltr";
import { LinkButton } from "@/components/shared/link-button";
import { PageSection } from "@/components/shared/page-section";
import { PremiumStatusBadge, premiumDayLabel } from "@/components/shared/premium-status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { premiumStatus } from "@/lib/auth/premium";
import { hasTeacherMembership } from "@/lib/db/account";
import { effectiveAssistantLinks } from "@/lib/db/assistants";
import { showsStudyDetails } from "@/lib/db/account-study";
import { listCatalogGrades } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { FAMILY_LIMITS, familyForAccount } from "@/lib/db/parents";
import { gradePickerData } from "@/lib/student-grade-options";
import { formatDate } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

/**
 * Account settings' two named extension points (F2). Each renders **nothing**
 * until the prompt that owns it fills it in — no heading, no empty card:
 *
 * - `StudyDetailsSection` — a student's own study details (F4, filled: the
 *   account grade);
 * - `FamilySection` — family links (F3, filled: parent onboarding, OD-6).
 *
 * They take the signed-in `User` and live on the page between Profile and
 * Sign-in & security, so a later section slots in without moving the others.
 */
export type AccountSectionProps = { user: User };

/**
 * Account → Study details (F4, docs/04 §11.23): the student's own grade, for an
 * account that signed up as a student or holds a profile at any branch —
 * nothing for anyone else. It says plainly that it never changes a branch's
 * record: each branch keeps its own grade on file.
 */
export async function StudyDetailsSection({ user }: AccountSectionProps) {
  if (!(await showsStudyDetails(prisma, user))) return null;

  const [t, tPicker, tCommon, locale, grades] = await Promise.all([
    getTranslations("Account.study"),
    getTranslations("Account.study.picker"),
    getTranslations("Settings.common"),
    getLocale(),
    listCatalogGrades(prisma, undefined, false),
  ]);
  const data = gradePickerData(locale, grades, user.gradeId, {
    noSystem: tPicker("noSystem"),
    inactive: tCommon("inactive"),
  });

  return (
    <PageSection title={t("title")} description={t("description")}>
      <Card>
        <CardHeader>
          <CardTitle as="h3">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StudyDetailsForm data={data} gradeId={user.gradeId ?? ""} />
        </CardContent>
      </Card>
    </PageSection>
  );
}

/**
 * Account → Family (F3, docs/04 §11.22). A student sees their linked parents
 * (no remove — a minor can't cut off a parent), their pending codes and
 * "Invite a parent"; a parent (or a staff member or teacher, who may be one)
 * sees their children, Unlink and "Link another child"; a brand-new account
 * with no relation anywhere sees both, since nothing says yet which it is. A
 * platform admin sees nothing (`familyForAccount`).
 */
export async function FamilySection({ user }: AccountSectionProps) {
  const family = await familyForAccount(prisma, user.id);
  if (!family.showParentView && !family.showStudentView) return null;

  const [t, tStudent, tParent, locale] = await Promise.all([
    getTranslations("Family.section"),
    getTranslations("Family.student"),
    getTranslations("Family.parent"),
    getLocale(),
  ]);
  const studentName = fullName(user);
  const slotsFull = family.slotsUsed >= FAMILY_LIMITS.slotsPerStudent;

  return (
    <PageSection title={t("title")} description={t("description")}>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {family.showStudentView ? (
          <Card>
            <CardHeader>
              <CardTitle as="h3">{tStudent("title")}</CardTitle>
              <CardDescription>{tStudent("description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-text-secondary">
                {tStudent("slots", { used: family.slotsUsed, max: FAMILY_LIMITS.slotsPerStudent })}
              </p>

              {family.parents.length === 0 ? (
                <EmptyState compact icon={<Users />} title={tStudent("noParents")} description={tStudent("noParentsHint")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {family.parents.map((parent) => (
                    <li key={parent.linkId} className="flex flex-col gap-0.5 rounded-xl border border-border p-3">
                      <span className="text-sm font-medium break-words text-text-primary">{fullName(parent)}</span>
                      <span className="text-xs text-text-secondary">
                        {tStudent("since", { date: formatDate(parent.since, locale) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {family.parents.length > 0 ? (
                <p className="text-xs text-text-muted">{tStudent("cannotRemove")}</p>
              ) : null}

              {family.invitations.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold text-text-primary">{tStudent("pendingTitle")}</h4>
                  <ul className="flex flex-col gap-2">
                    {family.invitations.map((invitation) => (
                      <li key={invitation.id} className="flex flex-col gap-3 rounded-xl border border-border p-3">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm font-medium break-words text-text-primary">
                            {invitation.source === "STUDENT_INVITE"
                              ? tStudent("pendingFor", { name: invitation.declaredParentName ?? "—" })
                              : tStudent("pendingBranch", { branch: invitation.branchName ?? "—" })}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                            <KeyRound className="size-3.5 shrink-0" aria-hidden />
                            <span>
                              {tStudent.rich("pendingMeta", {
                                hint: invitation.hint,
                                date: formatDate(invitation.createdAt, locale),
                                code: (chunks) => <Ltr className="font-mono">{chunks}</Ltr>,
                              })}
                            </span>
                          </span>
                        </div>
                        {invitation.source === "STUDENT_INVITE" ? (
                          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                            <RegenerateInvitationButton invitationId={invitation.id} studentName={studentName} />
                            <CancelInvitationButton invitationId={invitation.id} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <InviteParentButton
                disabled={slotsFull}
                disabledReason={tStudent("slotsFull", { max: FAMILY_LIMITS.slotsPerStudent })}
                studentName={studentName}
              />
            </CardContent>
          </Card>
        ) : null}

        {family.showParentView ? (
          <Card>
            <CardHeader>
              <CardTitle as="h3">{tParent("title")}</CardTitle>
              <CardDescription>{tParent("description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {family.children.length === 0 ? (
                <EmptyState compact icon={<Baby />} title={tParent("noChildren")} description={tParent("noChildrenHint")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {family.children.map((child) => (
                    <li
                      key={child.linkId}
                      className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium break-words text-text-primary">{fullName(child)}</span>
                        <span className="text-xs text-text-secondary">
                          {child.branches.length > 0 ? child.branches.join(" · ") : tParent("noBranch")}
                        </span>
                        <span className="text-xs text-text-muted">
                          {tParent("since", { date: formatDate(child.since, locale) })}
                        </span>
                      </div>
                      <UnlinkChildButton linkId={child.linkId} childName={fullName(child)} />
                    </li>
                  ))}
                </ul>
              )}
              {family.children.length > 0 ? (
                <LinkButton href={ROUTES.parentHome} className="w-full sm:w-fit">
                  {tParent("openPortal")}
                </LinkButton>
              ) : null}

              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <h4 className="text-sm font-semibold text-text-primary">
                  {family.children.length > 0 ? tParent("linkAnother") : tParent("linkFirst")}
                </h4>
                <JoinFamilyForm mode="account" signedIn />
                <p className="text-xs text-text-muted">{tParent("howToGet")}</p>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </PageSection>
  );
}

/**
 * Account → "History shown in my teacher portal" (U6, docs/04 §11.27): how
 * far back this person's own teacher portal shows — only for someone with an
 * active teacher membership, nothing for anyone else.
 */
export async function TeacherHistorySection({ user }: AccountSectionProps) {
  if (!(await hasTeacherMembership(prisma, user.id))) return null;
  const tHistory = await getTranslations("Account.teacherHistory");

  return (
    <PageSection title={tHistory("title")} description={tHistory("description")}>
      <Card>
        <CardContent>
          <TeacherHistoryForm teacherHistoryDays={user.teacherHistoryDays} />
        </CardContent>
      </Card>
    </PageSection>
  );
}

/**
 * Account → Premium (W6, D-W35, docs/04 §11.36): every account, whatever its
 * role — premium belongs to the person, not a branch. The status (Not premium,
 * Premium until <date>, Expired on <date>, and "Ends in n days" within
 * `PREMIUM_ENDING_SOON_DAYS`), what premium adds, and how to get it: by
 * contacting KayEdu. No payment and no self-serve in v1. Worked out from
 * `User.premiumUntil` on this request (`premiumStatus`), never stored.
 */
export async function PremiumSection({ user }: AccountSectionProps) {
  const [t, locale] = await Promise.all([getTranslations("Account.premium"), getLocale()]);
  const status = premiumStatus(user.premiumUntil, new Date());
  const features = ["assistants", "workspaces", "assessments"] as const;

  return (
    <PageSection title={t("title")} description={t("description")}>
      <Card>
        <CardHeader>
          <CardTitle as="h3" className="flex flex-wrap items-center gap-2">
            <span>{t("cardTitle")}</span>
            <PremiumStatusBadge status={status} />
          </CardTitle>
          <CardDescription>
            {status.kind === "active"
              ? t("activeNote", { date: premiumDayLabel(status.endDay, locale) })
              : status.kind === "expired"
                ? t("expiredNote", { date: premiumDayLabel(status.endDay, locale) })
                : t("noneNote")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-text-primary">{t("addsTitle")}</p>
            <ul className="flex flex-col gap-2">
              {features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                  <span>{t(`adds.${feature}`)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-text-secondary">{t("contact")}</p>
        </CardContent>
      </Card>
    </PageSection>
  );
}

/**
 * Account → Private classes (W10, D-W43, docs/04 §11.37): every account. One
 * card, "Join a private class", opening `/workspace-join`, where a teacher's
 * share code is redeemed after a confirmation. It lists nothing: a linked
 * private class is on the student's Sessions and Calendar, and its record is
 * among the records on file above.
 */
export async function PrivateClassSection() {
  const tPrivate = await getTranslations("Account.privateClass");
  return (
    <PageSection title={tPrivate("title")} description={tPrivate("description")}>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle as="h3">{tPrivate("joinTitle")}</CardTitle>
            <CardDescription>{tPrivate("joinDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <LinkButton href={ROUTES.workspaceJoin} className="w-full sm:w-auto">
              <GraduationCap className="size-4" aria-hidden />
              {tPrivate("open")}
            </LinkButton>
          </CardContent>
        </Card>
      </div>
    </PageSection>
  );
}

/**
 * Account → Assistant roles (W7a, D-W36, docs/04 §11.36): every account. Each
 * **effective** link reads "Assistant of <teacher>" — the teacher's name only
 * through a live link whose teacher is premium now, so a lapsed or removed
 * link (and the name with it) is not listed — with the granted permissions,
 * Open and Leave (confirmed, audited). Below them, "Join as an assistant":
 * the same two-step redemption as `/assistant-join`. A teacher may redeem
 * another teacher's code; their own is refused by the server.
 */
export async function AssistantSection({ user }: AccountSectionProps) {
  const [t, links] = await Promise.all([getTranslations("Account.assistant"), effectiveAssistantLinks(prisma, user.id)]);

  return (
    <PageSection title={t("title")} description={t("description")}>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {links.map((link) => (
          <Card key={link.linkId} size="sm">
            <CardHeader>
              <CardTitle as="h3" className="break-words">
                {t("roleTitle", { teacher: link.teacherName })}
              </CardTitle>
              <CardDescription>{t("roleDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <AssistantPermissionList permissions={link.permissions} compact />
              <div className="grid gap-2 sm:flex sm:justify-end">
                <LinkButton href={ROUTES.assistantHome(link.teacherUserId)} className="w-full sm:w-auto">
                  {t("open")}
                </LinkButton>
                <LeaveAssistantButton linkId={link.linkId} teacherName={link.teacherName} />
              </div>
            </CardContent>
          </Card>
        ))}
        <Card size="sm">
          <CardHeader>
            <CardTitle as="h3">{t("joinTitle")}</CardTitle>
            <CardDescription>{t("joinDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <JoinAssistantForm mode="account" signedIn />
          </CardContent>
        </Card>
      </div>
    </PageSection>
  );
}
