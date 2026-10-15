"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import {
  changeMemberRoleAction,
  setMemberActiveAction,
} from "@/app/[locale]/(center)/settings/staff/member-actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Ltr } from "@/components/shared/ltr";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

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

  const [roleState, roleAction] = useGuardedActionState(
    changeMemberRoleAction,
    IDLE_ACTION_STATE,
  );
  const [activeState, activeFormAction] = useGuardedActionState(
    setMemberActiveAction,
    IDLE_ACTION_STATE,
  );
  const tToast = useTranslations("Toasts");
  useActionFeedback(roleState, { success: tToast("memberRoleChanged") });
  useActionFeedback(activeState, {
    success: () => tToast(member.active ? "memberActivated" : "memberDeactivated"),
  });

  const roleLocked = member.isSelf || !member.canChangeRole;
  const activeLocked = member.isSelf || !member.canToggleActive;
  const error = roleState.error ?? activeState.error;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.name")}
        </span>
        <span className="truncate text-sm font-medium text-text-primary" dir="auto">
          {member.name}
        </span>
        {/* The email under the name — two narrow columns had truncated both. */}
        <span className="sr-only">{t("columns.email")}</span>
        <span className="truncate text-xs text-text-secondary" title={member.email ?? undefined}>
          <Ltr>{member.email ?? "—"}</Ltr>
        </span>
      </div>

      {/* A fixed width: three equal columns plus Save had squeezed the role
          to "M…" (docs/04 §14.8). */}
      <div className="flex min-w-0 flex-col gap-1.5 md:w-64 md:shrink-0">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.role")}
        </span>
        {roleLocked ? (
          <Badge variant="neutral">{tRoles(member.role)}</Badge>
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
          member.active ? (
            <ConfirmAction
              label={tCommon("deactivate")}
              variant="destructive"
              triggerClassName="h-11 w-full px-4"
              title={t("deactivateConfirm.title", { name: member.name })}
              description={t("deactivateConfirm.body")}
              action={activeFormAction}
              fields={{ locale, membershipId: member.membershipId }}
            />
          ) : (
            <form action={activeFormAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="membershipId" value={member.membershipId} />
              <input type="hidden" name="active" value="true" />
              <Button type="submit" variant="ghost" className="h-11 w-full px-4">
                {tCommon("activate")}
              </Button>
            </form>
          )
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
