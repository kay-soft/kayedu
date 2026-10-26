"use client";

import { startTransition, useEffect, useState, type FormEvent } from "react";
import { Building2, Copy, Palette, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { addBranchAction, type AddBranchState } from "@/app/[locale]/(center)/settings/branches/actions";
import { DialogLauncher, DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { ErrorSummary } from "@/components/shared/error-summary";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  BRANCH_COPY_KEYS,
  BRANCH_THEME_SWATCHES,
  CENTER_TIMEZONES,
  type BranchCopyKey,
} from "@/lib/branch-setup";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { cn } from "@/lib/utils";

const IDLE: AddBranchState = {};

type Props = {
  /** At the organization's limit — the button stays, disabled, with its reason beside it. */
  disabled: boolean;
  sources: { id: string; name: string }[];
  defaultSourceId: string;
  defaultTimezone: (typeof CENTER_TIMEZONES)[number];
};

/**
 * Add branch (F1, OD-12 (b)) — the shared `DialogShell`, mounted fresh on
 * every open. Name (Arabic, required), name (English, optional), theme
 * colour, timezone, and "Copy setup from <branch>" with every part ticked by
 * default. What is never copied is said in the dialog, not left to guess.
 */
export function AddBranchDialog(props: Props) {
  const t = useTranslations("Settings.branches");
  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button
          className="h-11 w-full px-4 sm:w-auto sm:self-start"
          onClick={openDialog}
          disabled={props.disabled}
          aria-describedby={props.disabled ? "add-branch-disabled-reason" : undefined}
        >
          <Plus className="size-4" />
          {t("add")}
        </Button>
      )}
      render={(dialog) => <AddBranchForm {...props} {...dialog} />}
    />
  );
}

function AddBranchForm({
  open,
  onOpenChange,
  sources,
  defaultSourceId,
  defaultTimezone,
}: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Settings.branches");
  const tErrors = useTranslations("Settings.branches.errors");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(addBranchAction, IDLE);
  const [color, setColor] = useState<string>(BRANCH_THEME_SWATCHES[0]);
  const [copy, setCopy] = useState<Set<BranchCopyKey>>(() => new Set(BRANCH_COPY_KEYS));
  const fieldErrors = state.fieldErrors;

  useActionFeedback(state, {
    success: (_status, result) => t("created", { branch: result.branchName ?? "" }),
  });

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state.status, onOpenChange]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  function toggle(key: BranchCopyKey, on: boolean) {
    setCopy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("dialogTitle")}
      description={t("dialogDescription")}
      formProps={{ onSubmit, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("add")}
      submitPending={pending}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="themeColor" value={color} />
      {[...copy].map((key) => (
        <input key={key} type="hidden" name={`copy_${key}`} value="on" />
      ))}

      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        <ErrorSummary fieldErrors={fieldErrors} />

        <DialogSections>
          <FormSection title={t("sections.branch")} icon={<Building2 />}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-branch-name">{t("fields.name")}</Label>
              <Input
                id="add-branch-name"
                name="name"
                dir="rtl"
                required
                maxLength={120}
                aria-invalid={fieldErrors?.name ? true : undefined}
              />
              {fieldErrors?.name ? <FieldError>{tErrors(fieldErrors.name)}</FieldError> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-branch-name-en">{t("fields.nameEn")}</Label>
              <Input
                id="add-branch-name-en"
                name="nameEn"
                dir="ltr"
                maxLength={120}
                aria-describedby="add-branch-name-en-hint"
                aria-invalid={fieldErrors?.nameEn ? true : undefined}
              />
              <p id="add-branch-name-en-hint" className="text-xs text-text-muted">
                {t("fields.nameEnHint")}
              </p>
              {fieldErrors?.nameEn ? <FieldError>{tErrors(fieldErrors.nameEn)}</FieldError> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-branch-timezone">{t("fields.timezone")}</Label>
              <Select
                id="add-branch-timezone"
                name="timezone"
                defaultValue={defaultTimezone}
                options={CENTER_TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
              />
              {fieldErrors?.timezone ? <FieldError>{tErrors(fieldErrors.timezone)}</FieldError> : null}
            </div>
          </FormSection>

          <FormSection title={t("sections.theme")} icon={<Palette />}>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">{t("fields.themeColor")}</span>
              <div className="flex flex-wrap items-center gap-1">
                <input
                  type="color"
                  aria-label={t("fields.themeColor")}
                  value={color}
                  onChange={(event) => setColor(event.currentTarget.value)}
                  className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1"
                />
                <span dir="ltr" className="px-1 font-mono text-xs text-text-muted">
                  {color}
                </span>
                {BRANCH_THEME_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    title={swatch}
                    aria-label={t("fields.useColor", { color: swatch })}
                    aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
                    onClick={() => setColor(swatch)}
                    className="inline-flex size-11 items-center justify-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-brand/25"
                  >
                    <span
                      className={cn(
                        "size-6 rounded-full border border-border-strong",
                        color.toLowerCase() === swatch.toLowerCase() &&
                          "ring-2 ring-brand ring-offset-2 ring-offset-background",
                      )}
                      style={{ backgroundColor: swatch }}
                    />
                  </button>
                ))}
              </div>
              {fieldErrors?.themeColor ? <FieldError>{tErrors(fieldErrors.themeColor)}</FieldError> : null}
            </div>
          </FormSection>

          <FormSection
            wide
            title={t("sections.copy")}
            description={t("copyDescription")}
            icon={<Copy />}
          >
            <div className="flex flex-col gap-1.5 sm:max-w-md">
              <Label htmlFor="add-branch-source">{t("fields.copyFrom")}</Label>
              <Select
                id="add-branch-source"
                name="copyFromCenterId"
                defaultValue={defaultSourceId}
                options={sources.map((source) => ({ value: source.id, label: source.name }))}
                aria-invalid={fieldErrors?.copyFromCenterId ? true : undefined}
              />
              {fieldErrors?.copyFromCenterId ? (
                <FieldError>{tErrors(fieldErrors.copyFromCenterId)}</FieldError>
              ) : null}
            </div>

            <ul className="grid gap-1 sm:grid-cols-2">
              {BRANCH_COPY_KEYS.map((key) => (
                <li key={key}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover">
                    <Checkbox
                      className="mt-0.5"
                      checked={copy.has(key)}
                      onCheckedChange={(next) => toggle(key, Boolean(next))}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-text-primary">{t(`copy.${key}.label`)}</span>
                      <span className="text-xs text-text-muted">{t(`copy.${key}.hint`)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            <p className="rounded-lg bg-surface-subtle p-3 text-xs text-text-secondary">{t("neverCopied")}</p>
          </FormSection>
        </DialogSections>
      </div>
    </DialogShell>
  );
}
