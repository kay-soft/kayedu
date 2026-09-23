"use client";

import { useActionState, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  createTeacherAction,
  lookupPersonByPhoneAction,
} from "@/app/[locale]/(center)/teachers/actions";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { PhoneLookupField } from "@/components/center/phone-lookup-field";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE, type MatchCandidate } from "@/lib/validation/people";

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
  const [linkedMatch, setLinkedMatch] = useState<MatchCandidate | null>(null);

  useEffect(() => {
    if (state.status === "created") onCreated();
  }, [state.status, onCreated]);

  const match =
    state.status === "matchFound" &&
    state.match &&
    state.match.userId !== dismissedMatch
      ? state.match
      : null;

  const linkUserId = linkedMatch?.userId ?? match?.userId ?? null;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {/* Present once staff confirm the match — this is what links. */}
      {linkUserId ? (
        <input type="hidden" name="linkUserId" value={linkUserId} />
      ) : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      {!linkedMatch ? (
        <PhoneLookupField lookup={lookupPersonByPhoneAction} onMatch={setLinkedMatch} />
      ) : null}

      <SectionHeader
        title={t("contactTitle")}
        description={t("contactDescription")}
      />
      <PersonFields
        key={`person-${linkedMatch?.userId ?? "new"}`}
        idPrefix="teacher-create"
        values={
          linkedMatch
            ? { firstName: linkedMatch.name.split(" ")[0], lastName: linkedMatch.name.split(" ").slice(1).join(" ") }
            : undefined
        }
        fieldErrors={state.fieldErrors}
      />
      <ContactFields
        key={`contact-${linkedMatch?.userId ?? "new"}`}
        idPrefix="teacher-create"
        values={linkedMatch ? { phone: linkedMatch.phone ?? "", email: linkedMatch.email ?? "" } : undefined}
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
