"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Role } from "@prisma/client";

import { savePermissionMatrixAction } from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import type { Permission } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

function actionMessageKey(action: Permission): string {
  return action.replaceAll(".", "_");
}

/**
 * One cell. The checkbox carries no `name`: the form posts the shared state
 * once (below), so the table and the phone cards can never disagree. Each had
 * rendered its own uncontrolled, named checkbox — and a CSS-hidden checkbox
 * still submits, so unticking the visible copy left the hidden one posting
 * "on" and every revoke was silently dropped (DES, docs/09 §3a F6).
 */
function Cell({
  role,
  actionLabel,
  editable,
  checked,
  onCheckedChange,
}: {
  role: Role;
  actionLabel: string;
  editable: boolean;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const t = useTranslations("Settings.permissions");
  const tRoles = useTranslations("Roles");

  if (!editable) {
    // Not grantable at all (the platform ceiling, docs/02 §6.1) — a dash with
    // its reason, never a box, which would read as one an Owner could tick.
    return (
      <span
        title={t("notGrantable")}
        className="inline-flex min-h-11 min-w-11 items-center justify-center text-text-muted"
      >
        <span aria-hidden>—</span>
        <span className="sr-only">{t("notGrantable")}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-ui-fast hover:bg-surface-hover">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
        aria-label={t("cellLabel", { action: actionLabel, role: tRoles(role) })}
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
  const [state, formAction] = useGuardedActionState(
    savePermissionMatrixAction,
    IDLE_ACTION_STATE,
  );
  useActionFeedback(state, { success: tCommon("saved") });

  const editableSets = new Map(
    roles.map((role) => [role, new Set(editableByRole[role] ?? [])]),
  );
  const editableKeys = roles.flatMap((role) =>
    actions
      .filter((action) => editableSets.get(role)!.has(action))
      .map((action) => `${role}__${action}`),
  );

  // One state for the whole grid, shown by both layouts; `baseline` is what
  // was last saved, so the button can say how many changes it would apply.
  const [grants, setGrants] = useState<Record<string, boolean>>(checked);
  const [baseline, setBaseline] = useState<Record<string, boolean>>(checked);
  const submitted = useRef<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (state.status === "saved" && submitted.current) {
      setBaseline(submitted.current);
      submitted.current = null;
    }
  }, [state]);
  const changes = editableKeys.filter(
    (key) => (grants[key] ?? false) !== (baseline[key] ?? false),
  ).length;
  const setter = (key: string) => (next: boolean) =>
    setGrants((current) => ({ ...current, [key]: next }));

  return (
    <form
      action={formAction}
      onSubmit={() => {
        submitted.current = grants;
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />
      {/* Exactly one field per granted, editable cell — the same
          `grant__<role>__<action>` = "on" the action has always read. */}
      {editableKeys
        .filter((key) => grants[key])
        .map((key) => (
          <input key={key} type="hidden" name={`grant__${key}`} value="on" />
        ))}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <p className="text-xs text-text-secondary">{t("lockedNote")}</p>

      {/* Table from md up (docs/04 §6). The header row and the action column
          are both sticky (docs/04 §11.2): this is the densest grid in the
          product, and a matrix you scroll blind is a matrix that gets
          misconfigured. Sticky needs an explicit scroll box, hence the
          max-height rather than letting the page scroll it. */}
      <div className="hidden max-h-[70vh] overflow-auto rounded-xl border border-border bg-surface md:block">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20">
            <tr className="bg-surface-subtle text-xs font-medium text-text-secondary [&>th]:border-b [&>th]:border-border">
              <th scope="col" className="sticky start-0 z-10 bg-surface-subtle p-3 text-start">
                {t("actionColumn")}
              </th>
              {roles.map((role) => (
                <th key={role} scope="col" className="p-3 text-center">
                  {tRoles(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {actions.map((action, index) => {
              const label = t(`actions.${actionMessageKey(action)}`);
              return (
                <tr
                  key={action}
                  className={cn(
                    "group/row border-b border-border last:border-0 hover:bg-surface-hover",
                    index % 2 === 1 && "bg-surface-subtle/50",
                  )}
                >
                  <th
                    scope="row"
                    className={cn(
                      "sticky start-0 z-10 p-3 text-start font-normal text-text-primary group-hover/row:bg-surface-hover",
                      // The sticky cell has to be opaque, so it takes the
                      // striping as a solid token rather than the row's alpha.
                      index % 2 === 1 ? "bg-surface-subtle" : "bg-surface",
                    )}
                  >
                    {label}
                  </th>
                  {roles.map((role) => {
                    const key = `${role}__${action}`;
                    return (
                      <td key={role} className="p-1 text-center">
                        <Cell
                          role={role}
                          actionLabel={label}
                          editable={editableSets.get(role)!.has(action)}
                          checked={grants[key] ?? false}
                          onCheckedChange={setter(key)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Stacked cards below md (docs/04 §6, §11.2) — one per action, each role
          a labelled row, two per line. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {actions.map((action) => {
          const label = t(`actions.${actionMessageKey(action)}`);
          return (
            <li key={action} className="rounded-xl border border-border bg-surface p-3">
              <p className="mb-1 text-sm font-medium text-text-primary">{label}</p>
              <div className="grid grid-cols-2 gap-x-3">
                {roles.map((role) => {
                  const key = `${role}__${action}`;
                  return (
                    <div key={role} className="flex min-h-11 items-center gap-1">
                      <Cell
                        role={role}
                        actionLabel={label}
                        editable={editableSets.get(role)!.has(action)}
                        checked={grants[key] ?? false}
                        onCheckedChange={setter(key)}
                      />
                      <span className="text-sm text-text-secondary">{tRoles(role)}</span>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Explicit save with the number of changes (docs/04 §11.2) — a grid
          that wrote on every tick would turn a mis-click into a privilege
          change. It stays in view at the foot of a long matrix. */}
      <div className="sticky bottom-0 z-10 flex flex-col gap-2 bg-canvas/95 py-2 backdrop-blur sm:flex-row sm:items-center sm:justify-end">
        <SubmitButton className="w-full sm:w-auto" disabled={changes === 0}>
          {changes > 0 ? t("saveMatrixCount", { count: changes }) : t("saveMatrix")}
        </SubmitButton>
      </div>
    </form>
  );
}
