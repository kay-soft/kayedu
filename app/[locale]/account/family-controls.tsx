"use client";

import { startTransition } from "react";
import { MessageCircle, RefreshCw, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  cancelInvitationAction,
  inviteParentAction,
  regenerateInvitationAction,
  unlinkChildAction,
} from "@/app/[locale]/account/family-actions";
import { FamilyCodeReveal } from "@/components/family/family-code-reveal";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { AnchorButton } from "@/components/shared/link-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatFamilyCodeForDisplay } from "@/lib/family-code";
import { familyJoinUrl } from "@/lib/routes";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_FAMILY_STATE } from "@/lib/validation/parents";

/**
 * Account → Family's controls (F3, docs/04 §11.22). Every write goes through
 * `family-actions.ts`, which takes the actor from the session.
 */

/** The student's "Share on WhatsApp": the join link (code in its fragment) in a prefilled message. */
export function WhatsAppShare({ code, studentName }: { code: string; studentName: string }) {
  const t = useTranslations("Family.code");
  const locale = useLocale() === "en" ? "en" : "ar";
  const display = formatFamilyCodeForDisplay(code);
  const url = familyJoinUrl(window.location.origin, locale, code);
  const text = t("shareText", { student: studentName, url, code: display });
  return (
    <AnchorButton
      href={`https://wa.me/?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noopener noreferrer"
      variant="default"
      className="w-full sm:w-auto"
    >
      <MessageCircle className="size-4" aria-hidden />
      {t("whatsapp")}
    </AnchorButton>
  );
}

/** "Invite a parent": the declared parent, then the code, once. */
export function InviteParentButton({
  disabled,
  disabledReason,
  studentName,
}: {
  disabled: boolean;
  disabledReason: string;
  studentName: string;
}) {
  const t = useTranslations("Family.student");
  return (
    <div className="flex flex-col gap-1.5">
      <DialogLauncher
        button={(open) => (
          <Button
            type="button"
            onClick={open}
            disabled={disabled}
            aria-describedby={disabled ? "invite-parent-reason" : undefined}
            className="w-full sm:w-fit"
          >
            <UserPlus className="size-4" aria-hidden />
            {t("invite")}
          </Button>
        )}
        render={(dialog) => <InviteParentDialog {...dialog} studentName={studentName} />}
      />
      {disabled ? (
        <p id="invite-parent-reason" className="text-xs text-text-secondary">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

function InviteParentDialog({
  open,
  onOpenChange,
  studentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentName: string;
}) {
  const t = useTranslations("Family.invite");
  const tErrors = useTranslations("Family.errors");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(inviteParentAction, IDLE_FAMILY_STATE);
  const issued = state.status === "issued" && state.code ? state.code : null;
  const fieldError = (name: string) => (state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined);

  if (issued) {
    return (
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={t("issuedTitle")}
        description={t("issuedDescription")}
        cancelLabel={t("done")}
      >
        <FamilyCodeReveal code={issued}>
          <WhatsAppShare code={issued} studentName={studentName} />
        </FamilyCodeReveal>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="invite-first" label={t("firstName")} error={fieldError("parentFirstName")}>
            <Input id="invite-first" name="parentFirstName" autoComplete="off" required maxLength={60} />
          </Field>
          <Field id="invite-last" label={t("lastName")} error={fieldError("parentLastName")}>
            <Input id="invite-last" name="parentLastName" autoComplete="off" required maxLength={60} />
          </Field>
        </div>
        <Field id="invite-phone" label={t("phone")} hint={t("phoneHint")} error={fieldError("parentPhone")}>
          <Input
            id="invite-phone"
            name="parentPhone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            dir="ltr"
            placeholder="01012345678"
            required
            maxLength={20}
          />
        </Field>
      </div>
    </DialogShell>
  );
}

/** "New code" on a pending invitation: confirm, then the new code once. */
export function RegenerateInvitationButton({
  invitationId,
  studentName,
}: {
  invitationId: string;
  studentName: string;
}) {
  const t = useTranslations("Family.student");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant="outline" onClick={open} className="w-full sm:w-auto">
          <RefreshCw className="size-4" aria-hidden />
          {t("newCode")}
        </Button>
      )}
      render={(dialog) => <RegenerateDialog {...dialog} invitationId={invitationId} studentName={studentName} />}
    />
  );
}

function RegenerateDialog({
  open,
  onOpenChange,
  invitationId,
  studentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invitationId: string;
  studentName: string;
}) {
  const t = useTranslations("Family.student");
  const tInvite = useTranslations("Family.invite");
  const tErrors = useTranslations("Family.errors");
  const tShared = useTranslations("Shared");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(regenerateInvitationAction, IDLE_FAMILY_STATE);
  const issued = state.status === "issued" && state.code ? state.code : null;

  if (issued) {
    return (
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={tInvite("issuedTitle")}
        description={tInvite("issuedDescription")}
        cancelLabel={tInvite("done")}
      >
        <FamilyCodeReveal code={issued}>
          <WhatsAppShare code={issued} studentName={studentName} />
        </FamilyCodeReveal>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("newCodeTitle")}
      description={t("newCodeDescription")}
      cancelLabel={tShared("keep")}
      submitLabel={t("newCode")}
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
      <input type="hidden" name="invitationId" value={invitationId} />
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </DialogShell>
  );
}

export function CancelInvitationButton({ invitationId }: { invitationId: string }) {
  const t = useTranslations("Family.student");
  const tErrors = useTranslations("Family.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(cancelInvitationAction, IDLE_FAMILY_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "revoked" ? tToasts("familyInvitationCancelled") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("cancel")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("cancelTitle")}
      description={t("cancelDescription")}
      action={formAction}
      fields={{ locale, invitationId }}
    />
  );
}

export function UnlinkChildButton({ linkId, childName }: { linkId: string; childName: string }) {
  const t = useTranslations("Family.parent");
  const tErrors = useTranslations("Family.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(unlinkChildAction, IDLE_FAMILY_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "revoked" ? tToasts("familyUnlinked") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("unlink")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("unlinkTitle", { name: childName })}
      description={t("unlinkDescription", { name: childName })}
      action={formAction}
      fields={{ locale, linkId }}
    />
  );
}

