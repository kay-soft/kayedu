import type { User } from "@prisma/client";
import { Baby, KeyRound, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  CancelInvitationButton,
  InviteParentButton,
  RegenerateInvitationButton,
  UnlinkChildButton,
} from "@/app/[locale]/account/family-controls";
import { StudyDetailsForm } from "@/app/[locale]/account/study-details-form";
import { JoinFamilyForm } from "@/components/family/join-family-form";
import { EmptyState } from "@/components/shared/empty-state";
import { Ltr } from "@/components/shared/ltr";
import { LinkButton } from "@/components/shared/link-button";
import { PageSection } from "@/components/shared/page-section";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
