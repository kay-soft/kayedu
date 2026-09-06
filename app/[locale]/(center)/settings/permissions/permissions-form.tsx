"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import { savePermissionMatrixAction } from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import type { Permission } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

function actionMessageKey(action: Permission): string {
  return action.replaceAll(".", "_");
}

function Cell({
  role,
  action,
  editable,
  defaultChecked,
}: {
  role: Role;
  action: Permission;
  editable: boolean;
  defaultChecked: boolean;
}) {
  const tRoles = useTranslations("Roles");

  if (!editable) {
    return (
      <span
        aria-hidden
        className="inline-flex size-5 items-center justify-center rounded border border-dashed border-border text-text-muted"
      >
        —
      </span>
    );
  }

  return (
    <label
      className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-subtle"
      aria-label={tRoles(role)}
    >
      <input
        type="checkbox"
        name={`grant__${role}__${action}`}
        defaultChecked={defaultChecked}
        className="size-5 accent-[var(--brand)]"
      />
    </label>
  );
}

export function PermissionMatrixForm({
  roles,
  actions,
  editableByRole,
  checked,
}: {
  roles: Role[];
  actions: Permission[];
  editableByRole: Record<string, Permission[]>;
  checked: Record<string, boolean>;
}) {
  const t = useTranslations("Settings.permissions");
  const tRoles = useTranslations("Roles");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    savePermissionMatrixAction,
    IDLE_ACTION_STATE,
  );

  const editableSets = new Map(
    roles.map((role) => [role, new Set(editableByRole[role] ?? [])]),
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      {/* Table from md up (docs/04 §6). */}
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle text-xs font-medium text-text-muted">
              <th className="p-3 text-start">{t("actionColumn")}</th>
              {roles.map((role) => (
                <th key={role} className="p-3 text-center">
                  {tRoles(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {actions.map((action, index) => (
              <tr
                key={action}
                className={cn(
                  "border-b border-border last:border-0",
                  index % 2 === 1 && "bg-surface-subtle/50",
                )}
              >
                <td className="p-3 text-text-primary">
                  {t(`actions.${actionMessageKey(action)}`)}
                </td>
                {roles.map((role) => (
                  <td key={role} className="p-3 text-center">
                    <Cell
                      role={role}
                      action={action}
                      editable={editableSets.get(role)!.has(action)}
                      defaultChecked={checked[`${role}__${action}`] ?? false}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Stacked cards below md (docs/04 §6) — one per action. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {actions.map((action) => (
          <li key={action} className="rounded-xl border border-border p-3">
            <p className="mb-2 text-sm font-medium text-text-primary">
              {t(`actions.${actionMessageKey(action)}`)}
            </p>
            <div className="flex flex-wrap gap-3">
              {roles.map((role) => (
                <div key={role} className="flex items-center gap-2">
                  <Cell
                    role={role}
                    action={action}
                    editable={editableSets.get(role)!.has(action)}
                    defaultChecked={checked[`${role}__${action}`] ?? false}
                  />
                  <span className="text-xs text-text-secondary">{tRoles(role)}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <SubmitButton className="w-full sm:w-auto">{t("saveMatrix")}</SubmitButton>
    </form>
  );
}
