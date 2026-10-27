"use client";

import { startTransition, useState } from "react";
import { KeyRound, Printer, UserMinus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  cancelParentCodeAction,
  generateParentCodeAction,
  revokeParentLinkAction,
} from "@/app/[locale]/(center)/students/actions";
import { FamilyCodeReveal } from "@/components/family/family-code-reveal";
import { ParentCodeSlip, printParentCodeSlip, type SlipTexts } from "@/components/family/parent-code-slip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { familyJoinUrl } from "@/lib/routes";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_FAMILY_STATE } from "@/lib/validation/parents";

/**
 * The "Parent access" card's controls on `/students/[id]` (F3, docs/04
 * §11.22) — rendered only for a role holding `parent.link.manage`; each
 * action re-checks it on the server and resolves the student through the
 * active branch.
 */

type SlipCopy = { branchName: string; studentName: string; ar: SlipTexts; en: SlipTexts };

/** "Generate parent code" (or "Replace the code"): confirm, then the code once, with Print. */
export function GenerateParentCodeButton({
  studentProfileId,
  replacing,
  disabled,
  disabledReason,
  slip,
}: {
  studentProfileId: string;
  /** A code from this branch is waiting — generating replaces it. */
  replacing: boolean;
  disabled: boolean;
  disabledReason: string;
  slip: SlipCopy;
}) {
  const t = useTranslations("Family.branch");
  return (
    <div className="flex flex-col gap-1.5">
      <DialogLauncher
        button={(open) => (
          <Button
            type="button"
            variant={replacing ? "outline" : "default"}
            onClick={open}
            disabled={disabled}
            aria-describedby={disabled ? "parent-code-reason" : undefined}
            className="w-full sm:w-fit"
          >
            <KeyRound className="size-4" aria-hidden />
            {replacing ? t("regenerate") : t("generate")}
          </Button>
        )}
        render={(dialog) => (
          <GenerateDialog {...dialog} studentProfileId={studentProfileId} replacing={replacing} slip={slip} />
        )}
      />
      {disabled ? (
        <p id="parent-code-reason" className="text-xs text-text-secondary">
          {disabledReason}
        </p>
      ) : replacing ? (
        <p className="text-xs text-text-secondary">{t("regenerateHint")}</p>
      ) : null}
    </div>
  );
}

function GenerateDialog({
  open,
  onOpenChange,
  studentProfileId,
  replacing,
  slip,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentProfileId: string;
  replacing: boolean;
  slip: SlipCopy;
}) {
  const t = useTranslations("Family.branch");
  const tErrors = useTranslations("Family.errors");
  const tShared = useTranslations("Shared");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(generateParentCodeAction, IDLE_FAMILY_STATE);
  const issued = state.status === "issued" && state.code ? state.code : null;
  const title = t("dialogTitle", { student: slip.studentName });

  if (issued) {
    const joinUrl = familyJoinUrl(window.location.origin, locale === "en" ? "en" : "ar", issued);
    return (
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={title}
        description={t("dialogDescription")}
        cancelLabel={t("done")}
      >
        <FamilyCodeReveal code={issued}>
          <Button type="button" className="w-full sm:w-auto" onClick={printParentCodeSlip}>
            <Printer className="size-4" aria-hidden />
            {t("print")}
          </Button>
        </FamilyCodeReveal>
        <ParentCodeSlip code={issued} joinUrl={joinUrl} {...slip} />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={title}
      description={replacing ? t("regenerateHint") : t("dialogDescription")}
      cancelLabel={tShared("keep")}
      submitLabel={replacing ? t("regenerate") : t("generate")}
      submitPending={pending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => formAction(formData));
        },
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </DialogShell>
  );
}

export function CancelParentCodeButton({ studentProfileId }: { studentProfileId: string }) {
  const t = useTranslations("Family.branch");
  const tErrors = useTranslations("Family.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(cancelParentCodeAction, IDLE_FAMILY_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "revoked" ? tToasts("familyCodeCancelled") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("cancelCode")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("cancelCodeTitle")}
      description={t("cancelCodeDescription")}
      action={formAction}
      fields={{ locale, studentProfileId }}
    />
  );
}

/**
 * "Remove access" — a confirmation that needs input (the reason), so it is
 * the inline panel of docs/04 §14.6, not a dialog: the reason, then Keep /
 * the solid destructive confirm. The reason is kept on the link, never in
 * the audit row (D-20).
 */
export function RevokeParentLinkButton({
  studentProfileId,
  linkId,
  parentName,
}: {
  studentProfileId: string;
  linkId: string;
  parentName: string;
}) {
  const t = useTranslations("Family.branch");
  const tErrors = useTranslations("Family.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useGuardedActionState(revokeParentLinkAction, IDLE_FAMILY_STATE);
  useActionFeedback(state, { success: (status) => (status === "revoked" ? tToasts("familyAccessRemoved") : null) });
  const reasonId = `revoke-reason-${linkId}`;

  if (!open) {
    return (
      <Button type="button" variant="destructive" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        <UserMinus className="size-4" aria-hidden />
        {t("revoke")}
      </Button>
    );
  }

  return (
    <form
      noValidate
      className="flex w-full flex-col gap-3 rounded-xl bg-surface-subtle p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      <input type="hidden" name="linkId" value={linkId} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-text-primary">{t("revokeTitle", { name: parentName })}</p>
        <p className="text-xs text-text-secondary">{t("revokeDescription")}</p>
      </div>
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      <Field
        id={reasonId}
        label={t("reason")}
        hint={t("reasonHint")}
        error={state.fieldErrors?.reason ? tErrors(state.fieldErrors.reason) : undefined}
      >
        <Textarea id={reasonId} name="reason" rows={2} maxLength={500} required />
      </Field>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          {t("keep")}
        </Button>
        <Button type="submit" variant="danger-solid" disabled={pending}>
          {t("revoke")}
        </Button>
      </div>
    </form>
  );
}
