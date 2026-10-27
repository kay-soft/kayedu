import { getLocale, getTranslations } from "next-intl/server";

import { OnboardingFlow } from "@/app/[locale]/(student)/student/onboarding/onboarding-flow";
import { PageHeader } from "@/components/shared/page-header";
import { getCurrentUser } from "@/lib/auth/session";
import { listCatalogGrades } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { FAMILY_LIMITS, familyForAccount } from "@/lib/db/parents";
import { redirect } from "@/lib/i18n/navigation";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { gradePickerData } from "@/lib/student-grade-options";

/**
 * "Your studies" (F4, docs/00 §4.3 item 0, docs/04 §11.23) — where a person who
 * signed up as a student lands while they have no branch and no account
 * grade: their education system and grade, then an optional "Invite a parent"
 * (F3's own action, skippable), then Discover. It is an ordinary page of the
 * student portal — the sidebar is there, nothing is gated behind it — and it
 * writes `User.gradeId` only; no branch record exists yet to touch.
 */
export default async function StudentOnboardingPage() {
  const locale = await getLocale();
  const user = await getCurrentUser();
  if (!user) redirect({ href: ROUTES.login, locale });

  const [t, tPicker, tCommon, grades, family] = await Promise.all([
    getTranslations("Onboarding.student"),
    getTranslations("Account.study.picker"),
    getTranslations("Settings.common"),
    listCatalogGrades(prisma, undefined, false),
    familyForAccount(prisma, user!.id),
  ]);

  const data = gradePickerData(locale, grades, user!.gradeId, {
    noSystem: tPicker("noSystem"),
    inactive: tCommon("inactive"),
  });
  // Step 2 is offered only where F3's "Invite a parent" would work: the
  // student view applies and a slot is free.
  const canInviteParent =
    family.showStudentView && family.slotsUsed < FAMILY_LIMITS.slotsPerStudent;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <OnboardingFlow
        data={data}
        gradeId={user!.gradeId ?? ""}
        canInviteParent={canInviteParent}
        studentName={fullName(user!)}
      />
    </div>
  );
}
