"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { DialogShell } from "@/components/shared/dialog-shell";
import { Button } from "@/components/ui/button";

/**
 * The one confirmation for a destructive or irreversible verb on a row or a
 * card (docs/04-design-system.md §14.6): the trigger, then the shared narrow
 * `DialogShell` — the title names the act, the description states the
 * consequence, Keep it / the solid destructive confirm.
 *
 * It posts the caller's existing form action with the same hidden fields the
 * one-tap form did, so the Server Action, its rules and its result shape are
 * untouched; the row keeps rendering the result (its inline error, or the
 * success toast). The dialog closes as the form submits.
 */
export function ConfirmAction({
  label,
  icon,
  variant = "ghost",
  triggerClassName,
  title,
  description,
  confirmLabel,
  action,
  fields,
  disabled,
  tone = "destructive",
  iconOnly,
}: {
  /** The trigger's label (already translated). */
  label: string;
  icon?: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  triggerClassName?: string;
  title: string;
  /** The consequence, in one or two sentences. */
  description: string;
  /** Defaults to the trigger's label. */
  confirmLabel?: string;
  /** The form action the one-tap form used (`useActionState`'s, or a Server Action). */
  action: (formData: FormData) => void | Promise<void>;
  /** Hidden fields posted with it. */
  fields: Record<string, string | undefined>;
  disabled?: boolean;
  /**
   * `default` for a verb that is final but not destructive (approve, mark
   * paid): the confirm is the brand primary, not red.
   */
  tone?: "destructive" | "default";
  /** Show only the icon on the trigger; `label` becomes its accessible name. */
  iconOnly?: boolean;
}) {
  const t = useTranslations("Shared");
  const [open, setOpen] = useState(false);

  return (
    <DialogShell
      open={open}
      onOpenChange={setOpen}
      size="narrow"
      trigger={
        <Button
          type="button"
          variant={variant}
          disabled={disabled}
          className={triggerClassName}
          aria-label={iconOnly ? label : undefined}
          title={iconOnly ? label : undefined}
        >
          {icon}
          {iconOnly ? null : label}
        </Button>
      }
      title={title}
      description={description}
      cancelLabel={t("keep")}
      submitLabel={confirmLabel ?? label}
      submitVariant={tone}
      formProps={{
        action,
        onSubmit: () => setOpen(false),
      }}
    >
      {Object.entries(fields).map(([name, value]) =>
        value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
    </DialogShell>
  );
}
