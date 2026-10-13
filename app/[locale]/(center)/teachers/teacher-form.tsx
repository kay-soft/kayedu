"use client";

import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { NewTeacherFields } from "@/components/center/new-teacher-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Add a teacher. Rendered inside the "Add teacher" dialog (docs/04 §5
 * "Dialog") — the teachers screen itself is a list first.
 *
 * If the phone or email already belongs to someone on the platform, the
 * action returns the match instead of writing anything: the panel names
 * them, and confirming links a **membership** at this center to that
 * existing person (spec §5) rather than creating a second identity. The
 * fields and the match flow are `NewTeacherFields`, shared with the class
 * dialog's "New teacher" (R6).
 */
export function TeacherForm({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations("Teachers");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  const [matchPending, setMatchPending] = useState(false);

  useEffect(() => {
    if (state.status === "created") onCreated();
  }, [state.status, onCreated]);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <NewTeacherFields
        idPrefix="teacher-create"
        fieldErrors={state.fieldErrors}
        serverMatch={state.status === "matchFound" ? state.match : null}
        onPendingChange={setMatchPending}
      />

      {matchPending ? null : (
        <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
      )}
    </form>
  );
}
