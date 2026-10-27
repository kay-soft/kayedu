"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import {
  changeMemberRoleAction,
  setMemberActiveAction,
} from "@/app/[locale]/(center)/settings/staff/member-actions";
import {
  SETTINGS_ACTION_BUTTON,
  SettingsListRow,
} from "@/components/settings/settings-list";
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

  const roleCell = roleLocked ? (
    <Badge variant="neutral" className="self-start">
      {tRoles(member.role)}
    </Badge>
  ) : (
    <form action={roleAction} className="flex items-center gap-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="membershipId" value={member.membershipId} />
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
  );

  return (
    <SettingsListRow
      actionsSize="narrow"
      cells={[
        {
          key: "name",
          label: t("columns.name"),
          content: (
            <>
              <span className="truncate text-sm font-medium text-text-primary" dir="auto">
                {member.name}
              </span>
              {/* The email under the name — two narrow columns had truncated both. */}
              <span className="sr-only">{t("columns.email")}</span>
              <span
                className="truncate text-xs text-text-secondary"
                title={member.email ?? undefined}
              >
                <Ltr>{member.email ?? "—"}</Ltr>
              </span>
            </>
          ),
        },
        {
          // A fixed width: three equal columns plus Save had squeezed the role
          // to "M…" (docs/04 §14.8).
          key: "role",
          label: t("columns.role"),
          className: "md:w-64 md:shrink-0",
          content: roleCell,
        },
      ]}
      status={
        <Badge variant={member.active ? "success" : "neutral"}>
          {member.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      }
      actions={
        activeLocked ? (
          <span className="col-span-2 text-xs text-text-muted md:col-auto">
            {member.isSelf ? t("selfRow") : t("ownerRow")}
          </span>
        ) : member.active ? (
          <ConfirmAction
            label={tCommon("deactivate")}
            variant="outline"
            triggerClassName={SETTINGS_ACTION_BUTTON}
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
            <Button type="submit" variant="outline" className={SETTINGS_ACTION_BUTTON}>
              {tCommon("activate")}
            </Button>
          </form>
        )
      }
      notice={error ? <FormMessage>{tErrors(error)}</FormMessage> : null}
    />
  );
}
