import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { adminShell } from "@/app/[locale]/(admin)/admin-shell";
import { centerShell } from "@/app/[locale]/(center)/center-shell";
import { parentShell } from "@/app/[locale]/(parent)/parent-shell";
import { studentShell } from "@/app/[locale]/(student)/student-shell";
import { teacherShell } from "@/app/[locale]/(teacher)/teacher-shell";
import { AccountEmailForm, AccountPasswordForm, AccountProfileForm } from "@/app/[locale]/account/account-forms";
import { FamilySection, StudyDetailsSection, TeacherHistorySection } from "@/app/[locale]/account/extension-points";
import { ProfilePhotoForm } from "@/app/[locale]/account/photo-form";
import { Ltr } from "@/components/shared/ltr";
import { AppShell } from "@/components/shell/app-shell";
import type { ShellFrame } from "@/components/shell/from-context";
import { PageHeader } from "@/components/shared/page-header";
import { PageSection } from "@/components/shared/page-section";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { emailChangeMode } from "@/lib/auth/auth-config";
import { getAuthUser, getCurrentUser } from "@/lib/auth/session";
import { resolveAccountExperience } from "@/lib/auth/tenant";
import { recordsOnFile, type RecordOnFile } from "@/lib/db/account";
import { prisma } from "@/lib/db/client";
import { fullName, localName } from "@/lib/identity";
import { personInitials } from "@/lib/initials";
import { formatPhone } from "@/lib/phone";
import { HubShell } from "@/components/shell/hub-shell";
import type { ShellUser } from "@/components/shell/app-shell";
import { ACCOUNT_HUB_HINT, type ShellExperience } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Account");
  return { title: t("title") };
}

/**
 * The experience's own shell — the same frame its route group's layout
 * renders. Not the student portal itself: no completion gate, no rating
 * pop-up, so only `props` is used.
 */
function shellFrame(experience: ShellExperience): Promise<ShellFrame> {
  switch (experience) {
    case "center":
      return centerShell();
    case "teacher":
      return teacherShell();
    case "student":
      return studentShell({ interruptions: false });
    case "parent":
      return parentShell();
    case "admin":
      return adminShell();
  }
}

/**
 * Account settings (F2) — every signed-in person, every role, one route,
 * rendered inside the shell they came from (`?from=`, re-checked by
 * `resolveAccountExperience`). Reads and writes only the caller's own `User`;
 * each branch's record of them is shown read-only (rule 4).
 */
export default async function AccountPage({ searchParams }: PageProps<"/[locale]/account">) {
  const { from } = await searchParams;
  const experience = await resolveAccountExperience(typeof from === "string" ? from : undefined);
  const [frame, user, authUser] = await Promise.all([
    experience === ACCOUNT_HUB_HINT ? null : shellFrame(experience),
    getCurrentUser(),
    getAuthUser(),
  ]);
  // resolveAccountExperience already redirected a signed-out visitor.
  if (!user) return null;

  const [t, tOnFile, tRoles, records] = await Promise.all([
    getTranslations("Account"),
    getTranslations("Account.onFile"),
    getTranslations("Roles"),
    recordsOnFile(prisma, user.id),
  ]);
  const pendingEmail = authUser?.new_email && authUser.new_email !== authUser.email ? authUser.new_email : null;

  const body = (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("title")} description={t("description")} />

        <PageSection title={t("profileSection")} description={t("profileSectionDescription")}>
          {/* F8: the preview always shows the photo; no storage destination yet, so photoSrc is null. */}
          <ProfilePhotoForm initials={personInitials(user.firstName, user.lastName)} photoSrc={null} />

          <AccountProfileForm
            firstName={user.firstName}
            lastName={user.lastName}
            contactPhone={user.contactPhone ?? ""}
            preferredLocale={user.locale === "en" ? "en" : "ar"}
          />

          {records.length === 0 ? (
            <p className="text-sm text-text-muted">{tOnFile("empty")}</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {records.map((record) => (
                <li key={`${record.kind}-${record.id}`}>
                  <RecordCard
                    record={record}
                    title={tOnFile("title", { branch: record.centerName })}
                    labels={{
                      role: tOnFile("role"),
                      name: tOnFile("name"),
                      phone: tOnFile("phone"),
                      askBranch: tOnFile("askBranch"),
                    }}
                    roleLabel={tRoles(record.role)}
                    name={fullName(localName(record, user))}
                  />
                </li>
              ))}
            </ul>
          )}
        </PageSection>

        {/* Extension points (F4 Study details, F3 Family) — each renders nothing for an account it does not apply to. */}
        <StudyDetailsSection user={user} />
        <FamilySection user={user} />
        <TeacherHistorySection user={user} />

        <PageSection title={t("securitySection")} description={t("securitySectionDescription")}>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <AccountEmailForm
              currentEmail={authUser?.email ?? user.email}
              pendingEmail={pendingEmail}
              mode={emailChangeMode()}
            />
            <AccountPasswordForm />
          </div>
        </PageSection>
      </div>
  );

  // U1: from the branch hub there is no branch, so a neutral shell — no sidebar.
  if (!frame) {
    const hubUser: ShellUser = {
      name: fullName(user),
      email: user.email,
      initials: personInitials(user.firstName, user.lastName),
      roleKey: "",
    };
    return <HubShell user={hubUser}>{body}</HubShell>;
  }

  return <AppShell {...frame.props}>{body}</AppShell>;
}

/** One branch's record of this person — read-only; the branch owns it (rule 4). */
function RecordCard({
  record,
  title,
  labels,
  roleLabel,
  name,
}: {
  record: RecordOnFile;
  title: string;
  labels: { role: string; name: string; phone: string; askBranch: string };
  roleLabel: string;
  name: string;
}) {
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle as="h3">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="text-xs font-medium text-text-secondary sm:w-20 sm:shrink-0">{labels.role}</dt>
            <dd className="text-text-primary">{roleLabel}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="text-xs font-medium text-text-secondary sm:w-20 sm:shrink-0">{labels.name}</dt>
            <dd className="min-w-0 break-words text-text-primary">{name}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="text-xs font-medium text-text-secondary sm:w-20 sm:shrink-0">{labels.phone}</dt>
            <dd className="text-text-primary">{record.phone ? <Ltr>{formatPhone(record.phone)}</Ltr> : "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-text-muted">{labels.askBranch}</p>
      </CardContent>
    </Card>
  );
}
