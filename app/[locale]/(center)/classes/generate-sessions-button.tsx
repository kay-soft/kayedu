"use client";

import { useActionState } from "react";
import { CalendarClock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { generateSessionsAction } from "@/app/[locale]/(center)/classes/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

/**
 * Triggers the session generator (docs/02 §11) for every active class in the
 * center at once — the manual stand-in for the Vercel Cron job that will
 * later run this on a schedule (`app/api/cron/generate-sessions`).
 */
export function GenerateSessionsButton({ classGroupId }: { classGroupId?: string }) {
  const t = useTranslations("Classes.generate");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    generateSessionsAction,
    IDLE_CLASS_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction}>
        <input type="hidden" name="locale" value={locale} />
        {classGroupId ? (
          <input type="hidden" name="classGroupId" value={classGroupId} />
        ) : null}
        <SubmitButton variant="outline" className="w-full sm:w-auto">
          <CalendarClock className="size-4" />
          {classGroupId ? t("generateForClass") : t("generateForCenter")}
        </SubmitButton>
      </form>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      {state.status === "generated" && state.generated ? (
        <FormMessage tone={state.generated.conflicts > 0 ? "warning" : "success"}>
          {t("result", {
            created: state.generated.created,
            conflicts: state.generated.conflicts,
          })}
        </FormMessage>
      ) : null}

      {state.conflicts && state.conflicts.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-warning">
          {state.conflicts.slice(0, 10).map((conflict, index) => (
            <li key={index}>
              {t(conflict.type === "room" ? "roomConflict" : "teacherConflict", {
                className: conflict.className,
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
