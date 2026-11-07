"use client";

import { startTransition, useEffect, useState } from "react";
import { Check, SlidersHorizontal, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createAssistantInviteAction,
  removeAssistantAction,
  revokeAssistantInviteAction,
  updateAssistantPermissionsAction,
} from "@/app/[locale]/(teacher)/teacher/assistants/actions";
import { AssistantCodeReveal } from "@/components/assistants/assistant-code-reveal";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import {
  ASSISTANT_PERMISSIONS,
  ASSISTANT_PRESETS,
  DEFAULT_ASSISTANT_PRESET,
  PRESET_PERMISSIONS,
  detectPreset,
  isAssistantPreset,
  sortPermissions,
  type AssistantPermission,
  type AssistantPresetName,
} from "@/lib/assistant-catalog";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { cn } from "@/lib/utils";
import { IDLE_TEACHER_ASSISTANT_STATE } from "@/lib/validation/assistants";

/**
 * Teacher → Assistants' controls (W7a, D-W36, docs/04 §11.36). Every write
 * goes through `./actions.ts`, which takes the actor from the session; the
 * server decides premium, the slots and ownership.
 */

/** "Invite an assistant": pick a preset, then the code, once. */
export function InviteAssistantButton({ disabled, disabledReason }: { disabled: boolean; disabledReason: string }) {
  const t = useTranslations("Assistants.teacher");
  return (
    <div className="flex flex-col gap-1.5">
      <DialogLauncher
        button={(open) => (
          <Button
            type="button"
            onClick={open}
            disabled={disabled}
            aria-describedby={disabled ? "invite-assistant-reason" : undefined}
            className="w-full sm:w-fit"
          >
            <UserPlus className="size-4" aria-hidden />
            {t("invite")}
          </Button>
        )}
        render={(dialog) => <InviteAssistantDialog {...dialog} />}
      />
      {disabled ? (
        <p id="invite-assistant-reason" className="text-xs text-text-secondary">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The preset as three choice tiles (docs/04 §11.36): a native radio group —
 * arrow keys, one tab stop, a real `legend` — dressed as cards, the F4 intent
 * cards' recipe. The chosen tile has a check as well as the brand outline, so
 * it never depends on colour alone.
 */
function PresetTiles({ value, onChange }: { value: AssistantPresetName; onChange: (value: AssistantPresetName) => void }) {
  const t = useTranslations("Assistants.invite");
  const tPresets = useTranslations("Assistants.presets");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text-primary">{t("presetLabel")}</legend>
      <p className="text-xs text-text-secondary">{t("presetHint")}</p>
      <div className="flex flex-col gap-2">
        {ASSISTANT_PRESETS.map((preset) => (
          <label key={preset} className="block cursor-pointer">
            <input
              type="radio"
              name="preset"
              value={preset}
              checked={value === preset}
              onChange={() => onChange(preset)}
              className="peer sr-only"
            />
            <span
              className={cn(
                "flex min-h-16 items-start gap-3 rounded-xl border border-border bg-surface p-3 text-start transition-ui",
                "hover:border-border-strong hover:bg-surface-hover",
                "peer-checked:border-brand peer-checked:bg-brand/5 peer-checked:ring-2 peer-checked:ring-brand/20",
                "peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-text-primary">{tPresets(`${preset}.label`)}</span>
                <span className="block text-xs text-text-secondary">{tPresets(`${preset}.description`)}</span>
              </span>
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                  value === preset ? "border-brand bg-brand text-brand-foreground" : "border-border-strong",
                )}
              >
                {value === preset ? <Check className="size-3.5" /> : null}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function InviteAssistantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Assistants.invite");
  const tErrors = useTranslations("Assistants.errors");
  const locale = useLocale();
  const [preset, setPreset] = useState<AssistantPresetName>(DEFAULT_ASSISTANT_PRESET);
  const [state, formAction, pending] = useGuardedActionState(createAssistantInviteAction, IDLE_TEACHER_ASSISTANT_STATE);

  if (state.status === "created" && state.code && state.expiresAt) {
    return (
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={t("createdTitle")}
        description={t("createdDescription")}
        cancelLabel={t("done")}
      >
        <AssistantCodeReveal code={state.code} expiresAt={state.expiresAt} />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title")}
      description={t("description")}
      cancelLabel={t("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      formProps={{
        noValidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => formAction(formData));
        },
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        {state.fieldErrors?.preset ? <FormMessage>{tErrors(state.fieldErrors.preset)}</FormMessage> : null}
        <PresetTiles value={preset} onChange={setPreset} />
        <p className="text-xs text-text-muted">{t("expiryNote")}</p>
      </div>
    </DialogShell>
  );
}

export function RevokeInviteButton({ inviteId }: { inviteId: string }) {
  const t = useTranslations("Assistants.teacher");
  const tErrors = useTranslations("Assistants.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(revokeAssistantInviteAction, IDLE_TEACHER_ASSISTANT_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "revoked" ? tToasts("assistantInviteRevoked") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("revokeInvite")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("revokeInviteTitle")}
      description={t("revokeInviteDescription")}
      action={formAction}
      fields={{ locale, inviteId }}
    />
  );
}

export function RemoveAssistantButton({ linkId, name }: { linkId: string; name: string }) {
  const t = useTranslations("Assistants.teacher");
  const tErrors = useTranslations("Assistants.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(removeAssistantAction, IDLE_TEACHER_ASSISTANT_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "removed" ? tToasts("assistantRemoved") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("remove")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("removeTitle", { name })}
      description={t("removeDescription", { name })}
      action={formAction}
      fields={{ locale, linkId }}
    />
  );
}

/** "Edit permissions": a preset, or the toggles. Choosing a preset sets the toggles; changing a toggle reads "Custom". */
export function EditPermissionsButton({
  linkId,
  name,
  permissions,
}: {
  linkId: string;
  name: string;
  permissions: AssistantPermission[];
}) {
  const t = useTranslations("Assistants.teacher");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant="outline" onClick={open} className="w-full sm:w-auto">
          <SlidersHorizontal className="size-4" aria-hidden />
          {t("editPermissions")}
        </Button>
      )}
      render={(dialog) => <EditPermissionsDialog {...dialog} linkId={linkId} name={name} initial={permissions} />}
    />
  );
}

function EditPermissionsDialog({
  open,
  onOpenChange,
  linkId,
  name,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkId: string;
  name: string;
  initial: AssistantPermission[];
}) {
  const t = useTranslations("Assistants.edit");
  const tPresets = useTranslations("Assistants.presets");
  const tPermissions = useTranslations("Assistants.permissions");
  const tErrors = useTranslations("Assistants.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [selected, setSelected] = useState<AssistantPermission[]>(initial);
  const [state, formAction, pending] = useGuardedActionState(updateAssistantPermissionsAction, IDLE_TEACHER_ASSISTANT_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "saved" ? tToasts("assistantPermissionsSaved") : status === "unchanged" ? tToasts("assistantPermissionsUnchanged") : null),
  });
  const preset = detectPreset(selected);

  useEffect(() => {
    // Saved: the card behind shows the new grants (the page was revalidated).
    if (state.status === "saved" || state.status === "unchanged") onOpenChange(false);
  }, [state, onOpenChange]);

  const toggle = (permission: AssistantPermission, on: boolean) =>
    setSelected((current) => sortPermissions(on ? [...current, permission] : current.filter((item) => item !== permission)));

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title", { name })}
      description={t("description")}
      cancelLabel={t("cancel")}
      submitLabel={t("save")}
      submitPending={pending}
      formProps={{
        noValidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          const formData = new FormData();
          formData.set("locale", locale);
          formData.set("linkId", linkId);
          // A preset posts as a preset (the server writes exactly its grants); anything else as toggles.
          if (preset !== "CUSTOM") {
            formData.set("mode", "preset");
            formData.set("preset", preset);
          } else {
            formData.set("mode", "toggles");
            for (const permission of selected) formData.append("permission", permission);
          }
          startTransition(() => formAction(formData));
        },
      }}
    >
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        <Field id={`preset-${linkId}`} label={t("presetLabel")} hint={t("presetHint")}>
          <Select
            id={`preset-${linkId}`}
            value={preset}
            onValueChange={(value) => {
              if (isAssistantPreset(value)) setSelected([...PRESET_PERMISSIONS[value]]);
            }}
          >
            {ASSISTANT_PRESETS.map((value) => (
              <option key={value} value={value}>
                {tPresets(`${value}.label`)}
              </option>
            ))}
            <option value="CUSTOM" disabled>
              {tPresets("CUSTOM.label")}
            </option>
          </Select>
        </Field>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-medium text-text-primary">{t("togglesLabel")}</legend>
          {ASSISTANT_PERMISSIONS.map((permission) => {
            const id = `perm-${linkId}-${permission}`;
            return (
              <label
                key={permission}
                htmlFor={id}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover"
              >
                <Checkbox
                  id={id}
                  checked={selected.includes(permission)}
                  onCheckedChange={(checked) => toggle(permission, checked === true)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-text-primary">{tPermissions(`${permission}.label`)}</span>
                  <span className="text-xs text-text-secondary">{tPermissions(`${permission}.description`)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="text-xs text-text-muted">{t("phonesNote")}</p>
      </div>
    </DialogShell>
  );
}
