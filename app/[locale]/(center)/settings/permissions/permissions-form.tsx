"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import { savePermissionMatrixAction } from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Checkbox } from "@/components/ui/checkbox";
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
      // Not grantable at all (the platform ceiling, docs/02 §6.1) — a dimmed
      // dash, never an unchecked box, which would imply an Owner could tick it.
      <span
        aria-hidden
        className="inline-flex size-5 items-center justify-center rounded-md border border-dashed border-border-strong text-text-muted"
      >
        —
      </span>
    );
  }

  return (
    <span className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-ui-fast hover:bg-surface-hover">
      <Checkbox
        name={`grant__${role}__${action}`}
        defaultChecked={defaultChecked}
        aria-label={tRoles(role)}
      />
    </span>
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

      {/* Table from md up (docs/04 §6). The header row and the action column
          are both sticky (docs/04 §11.2): this is the densest grid in the
          product, and a matrix you scroll blind is a matrix that gets
          misconfigured. Sticky needs an explicit scroll box, hence the
          max-height rather than letting the page scroll it. */}
      <div className="hidden max-h-[70vh] overflow-auto rounded-xl border border-border md:block">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20">
            <tr className="bg-surface-subtle text-xs font-medium text-text-muted [&>th]:border-b [&>th]:border-border">
              <th className="sticky start-0 z-10 bg-surface-subtle p-3 text-start">
                {t("actionColumn")}
              </th>
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
                <td
                  className={cn(
                    "sticky start-0 z-10 p-3 text-text-primary",
                    // The sticky cell has to be opaque, so it takes the
                    // striping as a solid token rather than the row's alpha.
                    index % 2 === 1 ? "bg-surface-subtle" : "bg-surface",
                  )}
                >
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
