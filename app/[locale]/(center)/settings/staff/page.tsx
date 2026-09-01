import { getLocale, getTranslations } from "next-intl/server";

import { revokeInvitationAction } from "@/app/[locale]/(center)/settings/staff/actions";
import { InviteForm } from "@/app/[locale]/(center)/settings/staff/invite-form";
import {
  MemberRow,
  type MemberRowData,
} from "@/app/[locale]/(center)/settings/staff/member-row";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";

export default async function StaffSettingsPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "staff.invite");

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Staff");
  const tCommon = await getTranslations("Settings.common");
  const tRoles = await getTranslations("Roles");

  // Inactive memberships are listed too — deactivation is reversible, and a
  // hidden former member is how a center loses track of who has access.
  const [members, invitations] = await Promise.all([
    db.memberships.listWithUser(),
    db.invitations.list({ status: "PENDING" }),
  ]);

  const canManage = ctxCan(ctx, "staff.manage");
  const canManageOwners = ctxCan(ctx, "center.ownership.manage");

  const rows: MemberRowData[] = members.map((member) => ({
    membershipId: member.id,
    name: `${member.user.firstName} ${member.user.lastName}`.trim(),
    email: member.user.email,
    role: member.role,
    active: member.active,
    isSelf: member.userId === ctx.user.id,
    // Only an owner may retitle or suspend another owner (docs/02 §3).
    canEdit: canManage && (member.role !== "OWNER" || canManageOwners),
  }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("subtitle")} />

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
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">{t("noMembers")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="min-w-0 flex-1">{t("columns.name")}</span>
                <span className="min-w-0 flex-1">{t("columns.email")}</span>
                <span className="min-w-0 flex-1">{t("columns.role")}</span>
                <span className="w-20 shrink-0">{tCommon("status")}</span>
                <span className="w-32 shrink-0 text-end">
                  {tCommon("actions")}
                </span>
              </li>

              {/* Stacked cards below md, table rows from md up (docs/04 §6). */}
              {rows.map((member) => (
                <MemberRow key={member.membershipId} member={member} />
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
                      <Badge variant="warning">
                        {tRoles(invitation.role)}
                      </Badge>
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
