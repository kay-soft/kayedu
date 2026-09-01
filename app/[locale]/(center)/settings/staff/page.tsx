import { getLocale, getTranslations } from "next-intl/server";

import { revokeInvitationAction } from "@/app/[locale]/(center)/settings/staff/actions";
import { InviteForm } from "@/app/[locale]/(center)/settings/staff/invite-form";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";

export default async function StaffSettingsPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "staff.invite");

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Staff");
  const tRoles = await getTranslations("Roles");

  const [members, invitations] = await Promise.all([
    db.memberships.listWithUser({ active: true }),
    db.invitations.list({ status: "PENDING" }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("inviteTitle")}</CardTitle>
          <CardDescription>{t("inviteSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <InviteForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("membersTitle")}</CardTitle>
          <CardDescription>{t("membersSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-text-muted">{t("noMembers")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:grid md:grid-cols-[2fr_2fr_1fr]"
              >
                <span>{t("columns.name")}</span>
                <span>{t("columns.email")}</span>
                <span>{t("columns.role")}</span>
              </li>

              {/* Stacked cards below md, table rows from md up (docs/04 §6). */}
              {members.map((member) => (
                <li
                  key={member.id}
                  className="grid gap-2 rounded-xl border border-border p-3 md:grid-cols-[2fr_2fr_1fr] md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3"
                >
                  <span className="text-sm font-medium">
                    {member.user.firstName} {member.user.lastName}
                  </span>
                  <span
                    className="truncate text-sm text-text-secondary"
                    dir="ltr"
                  >
                    {member.user.email ?? "—"}
                  </span>
                  <span>
                    <Badge variant="brand">{tRoles(member.role)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("pendingTitle")}</CardTitle>
          <CardDescription>{t("pendingSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {invitations.length === 0 ? (
            <p className="text-sm text-text-muted">{t("noInvitations")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" dir="ltr">
                      {invitation.email}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                      <Badge variant="warning">{tRoles(invitation.role)}</Badge>
                      <span>
                        {t("expiresOn", {
                          date: formatDate(invitation.expiresAt, locale),
                        })}
                      </span>
                    </p>
                  </div>

                  <form action={revokeInvitationAction} className="shrink-0">
                    <input type="hidden" name="locale" value={locale} />
                    <input
                      type="hidden"
                      name="invitationId"
                      value={invitation.id}
                    />
                    <Button
                      type="submit"
                      variant="destructive"
                      className="h-11 w-full px-4 sm:w-auto"
                    >
                      {t("revoke")}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
