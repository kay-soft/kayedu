import { getTranslations } from "next-intl/server";

import {
  GrantBranchForm,
  RevokeBranchButton,
} from "@/app/[locale]/(center)/settings/staff/staff-result-actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type BranchGrantMember = {
  membershipId: string;
  name: string;
  role: string;
  grantedBranches: { id: string; name: string }[];
};

/**
 * Widening a branch-scoped member's reach to another branch (M12) — rendered
 * only for OWNER (the page gates this whole section on
 * `membership.branch.grant`) and only when the organization actually has more
 * than one branch, since otherwise there is nothing to grant.
 */
export async function BranchGrants({
  locale,
  members,
  branches,
}: {
  locale: string;
  members: BranchGrantMember[];
  branches: { id: string; name: string }[];
}) {
  const t = await getTranslations("Staff.branchGrants");
  const tRoles = await getTranslations("Roles");

  if (branches.length === 0 || members.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {members.map((member) => {
          const grantedIds = new Set(member.grantedBranches.map((b) => b.id));
          const available = branches.filter((branch) => !grantedIds.has(branch.id));

          return (
            <div
              key={member.membershipId}
              className="flex flex-col gap-3 rounded-xl border border-border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text-primary">
                  {member.name}
                </span>
                <Badge variant="neutral">{tRoles(member.role)}</Badge>
              </div>

              {member.grantedBranches.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {member.grantedBranches.map((branch) => (
                    <li key={branch.id}>
                      {/* Revoking cross-branch access asks first, and the
                          target is 44px — it had been a one-tap 24px "×". */}
                      <span className="inline-flex items-center gap-0.5 rounded-full border border-border py-0.5 ps-3 pe-0.5 text-xs">
                        <span>{branch.name}</span>
                        <RevokeBranchButton
                          locale={locale}
                          membershipId={member.membershipId}
                          branch={branch}
                          memberName={member.name}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-text-secondary">{t("noBranches")}</p>
              )}

              {available.length > 0 ? (
                <GrantBranchForm
                  locale={locale}
                  membershipId={member.membershipId}
                  branches={available}
                />
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
