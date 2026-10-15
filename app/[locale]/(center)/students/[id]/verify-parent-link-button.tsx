"use client";

import { useLocale, useTranslations } from "next-intl";

import { verifyParentLinkAction } from "@/app/[locale]/(center)/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * ─────────────────────────────── OD-6 PLACEHOLDER ───────────────────────────
 * The button behind the manual verify seam (`lib/db/parents.ts`'s
 * `verifyParentLinkPlaceholder`) — not the real parent↔child verification
 * mechanism `00-master-product-spec.md` §2.2's OD-6 has yet to decide.
 * Disabled since SEC-2a (D-03 (d)): the action refuses too, by direct call.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function VerifyParentLinkButton({ parentLinkId }: { parentLinkId: string }) {
  const t = useTranslations("Students.parentLinks");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(verifyParentLinkAction, IDLE_PEOPLE_STATE);

  if (state.status === "saved") {
    return <FormMessage tone="success">{t("verified")}</FormMessage>;
  }

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="parentLinkId" value={parentLinkId} />
      <SubmitButton variant="outline" disabled>
        {t("verify")}
      </SubmitButton>
      <p className="text-xs text-text-muted">{t("verifyUnavailable")}</p>
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </form>
  );
}
