"use client";

import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createStudentAction } from "@/app/[locale]/(center)/students/actions";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import {
  StudentFields,
  type GradeOption,
} from "@/components/center/student-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Register a student (spec §4.1 item 4). Rendered inside the "Add student"
 * dialog (docs/04 §5 "Dialog") — the students screen itself is a list first.
 *
 * A student is registered **once** on the platform and connected to this
 * center. If the phone or email already belongs to someone, the action stops
 * and returns the match; confirming attaches a new `StudentProfile` to that
 * existing person instead of creating a duplicate (spec §5).
 */
export function StudentForm({
  grades,
  noneLabel,
  onCreated,
}: {
  grades: GradeOption[];
  noneLabel: string;
  /** Closes the dialog once the student is actually created. */
  onCreated: () => void;
}) {
  const t = useTranslations("Students");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    createStudentAction,
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
      {match ? (
        <input type="hidden" name="linkUserId" value={match.userId} />
      ) : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <SectionHeader
        title={t("centerSectionTitle")}
        description={t("centerSectionDescription")}
      />
      <PersonFields idPrefix="student-create" fieldErrors={state.fieldErrors} />
      <ContactFields
        idPrefix="student-create"
        fieldErrors={state.fieldErrors}
      />
      <StudentFields
        idPrefix="student-create"
        grades={grades}
        fieldErrors={state.fieldErrors}
        noneLabel={noneLabel}
      />

      {match ? (
        <MatchPanel
          match={match}
          linkLabel={t("linkAsStudent")}
          blocked={match.existingHere === "student"}
          onCancel={() => setDismissedMatch(match.userId)}
        />
      ) : (
        <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
      )}
    </form>
  );
}
