import { getLocale, getTranslations } from "next-intl/server";
import { MailPlus, Users } from "lucide-react";

import { BranchGrants, type BranchGrantMember } from "@/app/[locale]/(center)/settings/staff/branch-grants";
import { InviteForm } from "@/app/[locale]/(center)/settings/staff/invite-form";
import { RevokeInvitationButton } from "@/app/[locale]/(center)/settings/staff/staff-result-actions";
import {
  MemberRow,
  type MemberRowData,
} from "@/app/[locale]/(center)/settings/staff/member-row";
import {
  SettingsList,
  SettingsListHeader,
} from "@/components/settings/settings-list";
import { Ltr } from "@/components/shared/ltr";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { branchesWithPermission, ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { isBranchGrantableRole } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/client";
import { organizationBranches } from "@/lib/db/organizations";
import { membershipBranchGrantsFor } from "@/lib/db/permissions";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

export default async function StaffSettingsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "staff.invite");

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Staff");
  const tCommon = await getTranslations("Settings.common");
  const tRoles = await getTranslations("Roles");

  // Inactive memberships are listed too — deactivation is reversible, and a
  // hidden former member is how a center loses track of who has access.
  // Centre staff only (R9): teachers — members or pending invitations — are
  // managed on the Teachers page and filtered out here in the data layer.
  const [members, invitations, inviteBranches] = await Promise.all([
    db.memberships.listStaffWithUser(),
    db.invitations.listStaff({ status: "PENDING" }),
    // F1: every branch where this actor may invite — the same permission the
    // action checks, resolved per branch.
    branchesWithPermission("membership.role.assign"),
  ]);

  const canManage = ctxCan(ctx, "staff.manage");
  const canManageOwners = ctxCan(ctx, "center.ownership.manage");
  // Assigning/changing a role is OWNER-only (M12) — a MANAGER's staff.manage
  // still lets them activate/deactivate, never touch the role itself.
  const canAssignRole = ctxCan(ctx, "membership.role.assign");

  const rows: MemberRowData[] = members.map((member) => ({
    membershipId: member.id,
    name: `${member.user.firstName} ${member.user.lastName}`.trim(),
    email: member.user.email,
    role: member.role,
    active: member.active,
    isSelf: member.userId === ctx.user.id,
    canChangeRole: canAssignRole,
    // Only an owner may suspend another owner (docs/02 §3).
    canToggleActive:
      canManage &&
      (member.role !== "OWNER" || canManageOwners) &&
      // D-09 (a): reactivating is OWNER-only; a manager may only deactivate.
      (member.active || canAssignRole),
  }));

  // Cross-branch grants (M12) — OWNER only, and only meaningful when this
  // organization actually has a second branch to grant.
  const canGrantBranch = ctxCan(ctx, "membership.branch.grant");
  let branchGrantMembers: BranchGrantMember[] = [];
  let siblingBranches: { id: string; name: string }[] = [];
  if (canGrantBranch) {
    const eligible = members.filter(
      (member) => member.active && isBranchGrantableRole(member.role),
    );
    const [siblings, grantsByMembership] = await Promise.all([
      organizationBranches(prisma, ctx.center.organizationId),
      membershipBranchGrantsFor(prisma, eligible.map((member) => member.id)),
    ]);
    siblingBranches = siblings.filter((branch) => branch.id !== ctx.center.id);
    branchGrantMembers = eligible.map((member) => ({
      membershipId: member.id,
      name: `${member.user.firstName} ${member.user.lastName}`.trim(),
      role: member.role,
      grantedBranches: (grantsByMembership.get(member.id) ?? []).map((branch) => ({
        id: branch.id,
        name: branch.name,
      })),
    }));
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("subtitle")} />

      {canAssignRole ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("inviteTitle")}</CardTitle>
            <CardDescription>{t("inviteSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm branches={inviteBranches} activeBranchId={ctx.center.id} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("membersTitle")}</CardTitle>
          <CardDescription>{t("membersSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              compact
              icon={<Users />}
              title={t("noMembers")}
              description={t("noMembersHint")}
            />
          ) : (
            <SettingsList>
              <SettingsListHeader
                columns={[
                  { key: "name", label: t("columns.name") },
                  { key: "role", label: t("columns.role"), className: "w-64 shrink-0" },
                ]}
                statusLabel={tCommon("status")}
                actionsLabel={tCommon("actions")}
                actionsSize="narrow"
              />

              {/* Stacked cards below md, table rows from md up (docs/04 §6). */}
              {rows.map((member) => (
                <MemberRow key={member.membershipId} member={member} />
              ))}
            </SettingsList>
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
            <EmptyState
              compact
              icon={<MailPlus />}
              title={t("noInvitations")}
              description={t("noInvitationsHint")}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      <Ltr>{invitation.email}</Ltr>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      {/* A role is not a status (docs/04 §14.1). */}
                      <Badge variant="neutral">
                        {tRoles(invitation.role)}
                      </Badge>
                      <span>
                        {t("expiresOn", {
                          date: formatDate(invitation.expiresAt, locale),
                        })}
                      </span>
                    </p>
                  </div>

                  {/* D-22 (a): revoking is OWNER-only, like creating. */}
                  {/* DES: revoking asks first, like every other destructive
                      action — the link dies at once (docs/04 §14.6). */}
                  {canAssignRole ? (
                    <RevokeInvitationButton
                      locale={locale}
                      invitationId={invitation.id}
                      email={invitation.email}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canGrantBranch ? (
        <BranchGrants
          locale={locale}
          members={branchGrantMembers}
          branches={siblingBranches}
        />
      ) : null}
    </div>
  );
}
