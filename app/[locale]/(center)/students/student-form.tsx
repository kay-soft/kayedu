"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { Camera, GraduationCap, UserRound, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createStudentAction,
  lookupPersonByPhoneAction,
} from "@/app/[locale]/(center)/students/actions";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { PhoneLookupField } from "@/components/center/phone-lookup-field";
import {
  GradeField,
  ParentFields,
  type GradeOption,
} from "@/components/center/student-fields";
import { DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { IDLE_PEOPLE_STATE, type MatchCandidate } from "@/lib/validation/people";

/**
 * Register a student (spec §4.1 item 4) — the body of the "Add student"
 * dialog, laid out in the shared `DialogShell` (R10b, docs/04 §11.19): the
 * dialog's header and footer stay put, the sections scroll between them.
 *
 * A student is registered **once** on the platform and connected to this
 * center. If the phone or email already belongs to someone, the action stops
 * and returns the match; the match panel sits directly under the phone field,
 * and confirming it attaches a new `StudentProfile` to that existing person
 * instead of creating a duplicate (spec §5). While a match waits, the
 * dialog's own "Register student" is held back — the panel's **Use this
 * person** is the one forward action.
 *
 * The form submits through `startTransition`, not a `<form action>`, which
 * React 19 resets once the action returns — a refused or "match found" submit
 * keeps everything typed.
 */
export function StudentForm({
  open,
  onOpenChange,
  grades,
  noneLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grades: GradeOption[];
  noneLabel: string;
}) {
  const t = useTranslations("Students");
  const tSections = useTranslations("Students.addSections");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction, pending] = useActionState(
    createStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const [dismissedMatch, setDismissedMatch] = useState<string | null>(null);
  const [linkedMatch, setLinkedMatch] = useState<MatchCandidate | null>(null);

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state.status, onOpenChange]);

  const match =
    state.status === "matchFound" &&
    state.match &&
    state.match.userId !== dismissedMatch
      ? state.match
      : null;

  const linkUserId = linkedMatch?.userId ?? match?.userId ?? null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("addTitle")}
      description={t("addDescription")}
      formProps={{ onSubmit, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("add")}
      submitPending={pending}
      submitDisabled={match !== null}
    >
      <input type="hidden" name="locale" value={locale} />
      {linkUserId ? (
        <input type="hidden" name="linkUserId" value={linkUserId} />
      ) : null}

      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        <DialogSections>
          <FormSection
            title={tSections("person")}
            description={tSections("personHint")}
            icon={<UserRound />}
          >
            {!linkedMatch ? (
              <PhoneLookupField lookup={lookupPersonByPhoneAction} onMatch={setLinkedMatch} />
            ) : null}
            <PersonFields
              key={`person-${linkedMatch?.userId ?? "new"}`}
              idPrefix="student-create"
              values={
                linkedMatch?.name
                  ? { firstName: linkedMatch.name.split(" ")[0], lastName: linkedMatch.name.split(" ").slice(1).join(" ") }
                  : undefined
              }
              fieldErrors={state.fieldErrors}
            />
            <ContactFields
              key={`contact-${linkedMatch?.userId ?? "new"}`}
              idPrefix="student-create"
              values={linkedMatch ? { phone: linkedMatch.phone ?? "", email: linkedMatch.email ?? "" } : undefined}
              fieldErrors={state.fieldErrors}
              belowPhone={
                match ? (
                  <MatchPanel
                    match={match}
                    linkLabel={t("linkAsStudent")}
                    blocked={match.existingHere === "student"}
                    onCancel={() => setDismissedMatch(match.userId)}
                    pending={pending}
                  />
                ) : null
              }
            />
          </FormSection>

          <div className="flex flex-col gap-4">
            <FormSection
              title={tSections("grade")}
              description={tSections("gradeHint")}
              icon={<GraduationCap />}
            >
              <GradeField
                idPrefix="student-create"
                grades={grades}
                fieldErrors={state.fieldErrors}
                noneLabel={noneLabel}
              />
            </FormSection>

            <FormSection
              title={tSections("parent")}
              description={tSections("parentHint")}
              icon={<Users />}
            >
              <ParentFields idPrefix="student-create" fieldErrors={state.fieldErrors} />
            </FormSection>

            <FormSection
              title={tSections("photo")}
              description={tSections("photoHint")}
              icon={<Camera />}
            >
              <p className="text-sm text-text-secondary">{tSections("photoNote")}</p>
            </FormSection>
          </div>
        </DialogSections>
      </div>
    </DialogShell>
  );
}
