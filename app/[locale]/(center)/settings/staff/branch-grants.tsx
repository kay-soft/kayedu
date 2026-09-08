import { getTranslations } from "next-intl/server";

import {
  grantMembershipBranchAction,
  revokeMembershipBranchAction,
} from "@/app/[locale]/(center)/settings/staff/member-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
                      <form
                        action={revokeMembershipBranchAction}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border py-1 ps-3 pe-1.5 text-xs"
                      >
                        <input type="hidden" name="locale" value={locale} />
                        <input
                          type="hidden"
                          name="membershipId"
                          value={member.membershipId}
                        />
                        <input type="hidden" name="centerId" value={branch.id} />
                        <span>{branch.name}</span>
                        <button
                          type="submit"
                          aria-label={t("revoke", { branch: branch.name })}
                          className="flex size-6 items-center justify-center rounded-full text-text-muted transition-ui-fast focus-ring hover:bg-danger-bg hover:text-danger"
                        >
                          ×
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-text-muted">{t("noBranches")}</p>
              )}

              {available.length > 0 ? (
                <form
                  action={grantMembershipBranchAction}
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input
                    type="hidden"
                    name="membershipId"
                    value={member.membershipId}
                  />
                  <Select
                    name="centerId"
                    aria-label={t("grantLabel")}
                    className="min-w-0 flex-1"
                  >
                    {available.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit" variant="outline" className="h-11 shrink-0 px-3">
                    {t("grant")}
                  </Button>
                </form>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
