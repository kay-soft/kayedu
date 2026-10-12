"use client";

import { useActionState, useState } from "react";
import { CalendarClock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { generateSessionsAction } from "@/app/[locale]/(center)/classes/actions";
import { SlotConflictNotice } from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

/**
 * Triggers the session generator (docs/02 §11) for one class, or every active
 * class in the center at once — the manual stand-in for the Vercel Cron job
 * (`app/api/cron/generate-sessions`).
 *
 * R3: non-conflicting occurrences are always created. Conflicting ones are
 * held back — under DENY for good, under WARN until someone confirms the
 * double-booking: the result then lists them in `SlotConflictNotice`, and
 * ticking "I understand" and pressing generate again creates them (the run
 * is idempotent, so nothing already created is duplicated).
 */
export function GenerateSessionsButton({ classGroupId }: { classGroupId?: string }) {
  const t = useTranslations("Classes.generate");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    generateSessionsAction,
    IDLE_CLASS_STATE,
  );
  const [confirmedFor, setConfirmedFor] = useState<object | null>(null);

  const heldBack = state.status === "generated" && state.generated?.needsConfirmation;
  const confirmed = confirmedFor === state;
  const idPrefix = `generate-${classGroupId ?? "center"}`;

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={locale} />
        {classGroupId ? (
          <input type="hidden" name="classGroupId" value={classGroupId} />
        ) : null}

        {state.status === "generated" && state.generated ? (
          <FormMessage tone={state.generated.conflicts > 0 ? "warning" : "success"}>
            {t("result", {
              created: state.generated.created,
              conflicts: state.generated.conflicts,
            })}
          </FormMessage>
        ) : null}

        {state.conflicts && state.conflicts.length > 0 ? (
          <>
            <p className="text-xs text-text-secondary">
              {heldBack
                ? t("heldBack")
                : state.conflictPolicy === "DENY"
                  ? t("skipped")
                  : t("createdWithConflicts")}
            </p>
            {heldBack || state.conflictPolicy === "DENY" ? (
              <SlotConflictNotice
                idPrefix={idPrefix}
                conflicts={state.conflicts}
                policy={state.conflictPolicy ?? "WARN"}
                confirmed={confirmed}
                onConfirmedChange={(value) => setConfirmedFor(value ? state : null)}
              />
            ) : null}
          </>
        ) : null}

        <SubmitButton variant="outline" className="w-full sm:w-auto">
          <CalendarClock className="size-4" />
          {heldBack && confirmed
            ? t("createConflicting")
            : classGroupId
              ? t("generateForClass")
              : t("generateForCenter")}
        </SubmitButton>
      </form>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </div>
  );
}
