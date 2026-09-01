"use client";

import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Add a teacher. Rendered inside the "Add teacher" dialog (docs/04 §5
 * "Dialog") — the teachers screen itself is a list first.
 *
 * If the phone or email already belongs to someone on the platform, the
 * action returns the match instead of writing anything: the panel names
 * them, and confirming links a **membership** at this center to that
 * existing person (spec §5) rather than creating a second identity.
 */
export function TeacherForm({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations("Teachers");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  const [dismissedMatch, setDismissedMatch] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "created") onCreated();
  }, [state.status, onCreated]);

  const match =
    state.status === "matchFound" &&
    state.match &&
    state.match.userId !== dismissedMatch
      ? state.match
      : null;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {/* Present only after staff confirm the match — this is what links. */}
      {match ? (
        <input type="hidden" name="linkUserId" value={match.userId} />
      ) : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <SectionHeader
        title={t("contactTitle")}
        description={t("contactDescription")}
      />
      <PersonFields idPrefix="teacher-create" fieldErrors={state.fieldErrors} />
      <ContactFields
        idPrefix="teacher-create"
        fieldErrors={state.fieldErrors}
        atLeastOneRequired
      />

      {match ? (
        <MatchPanel
          match={match}
          linkLabel={t("linkAsTeacher")}
          blocked={match.existingHere === "teacher"}
          onCancel={() => setDismissedMatch(match.userId)}
        />
      ) : (
        <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
      )}
    </form>
  );
}
