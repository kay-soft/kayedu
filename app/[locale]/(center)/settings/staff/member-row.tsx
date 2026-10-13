"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import {
  changeMemberRoleAction,
  setMemberActiveAction,
} from "@/app/[locale]/(center)/settings/staff/member-actions";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

// Centre staff only (R9) — a teacher never appears on this screen.
const ROLE_OPTIONS: Role[] = ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"];

export type MemberRowData = {
  membershipId: string;
  name: string;
  email: string | null;
  role: Role;
  active: boolean;
  /** The signed-in user's own membership — nobody edits their own access. */
  isSelf: boolean;
  /**
   * Assigning/changing a role is OWNER-only (M12, `membership.role.assign`) —
   * a MANAGER sees the role as a read-only badge, never an editable select.
   */
  canChangeRole: boolean;
  /** False for a manager looking at an owner: activate/deactivate is disabled. */
  canToggleActive: boolean;
};

export function MemberRow({ member }: { member: MemberRowData }) {
  const t = useTranslations("Staff");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const tRoles = useTranslations("Roles");
  const locale = useLocale();

  const [roleState, roleAction] = useActionState(
    changeMemberRoleAction,
    IDLE_ACTION_STATE,
  );
  const [activeState, activeFormAction] = useActionState(
    setMemberActiveAction,
    IDLE_ACTION_STATE,
  );

  const roleLocked = member.isSelf || !member.canChangeRole;
  const activeLocked = member.isSelf || !member.canToggleActive;
  const error = roleState.error ?? activeState.error;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.name")}
        </span>
        <span className="truncate text-sm font-medium text-text-primary">
          {member.name}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.email")}
        </span>
        <span className="truncate text-sm text-text-secondary" dir="ltr">
          {member.email ?? "—"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.role")}
        </span>
        {roleLocked ? (
          <Badge variant="brand">{tRoles(member.role)}</Badge>
        ) : (
          <form action={roleAction} className="flex items-center gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input
              type="hidden"
              name="membershipId"
              value={member.membershipId}
            />
            <Select
              name="role"
              defaultValue={member.role}
              aria-label={t("columns.role")}
              className="min-w-0 flex-1"
            >
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>
                  {tRoles(role)}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" className="h-11 px-3">
              {tCommon("save")}
            </Button>
          </form>
        )}
      </div>

      <div className="md:w-20 md:shrink-0">
        <Badge variant={member.active ? "success" : "neutral"}>
          {member.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="shrink-0 md:w-32 md:text-end">
        {activeLocked ? (
          <span className="text-xs text-text-muted">
            {member.isSelf ? t("selfRow") : t("ownerRow")}
          </span>
        ) : (
          <form action={activeFormAction}>
            <input type="hidden" name="locale" value={locale} />
            <input
              type="hidden"
              name="membershipId"
              value={member.membershipId}
            />
            {member.active ? null : (
              <input type="hidden" name="active" value="true" />
            )}
            <Button
              type="submit"
              variant={member.active ? "destructive" : "ghost"}
              className="h-11 w-full px-4"
            >
              {member.active ? tCommon("deactivate") : tCommon("activate")}
            </Button>
          </form>
        )}
      </div>

      {error ? (
        <div className="md:w-full md:basis-full">
          <FormMessage>{tErrors(error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
