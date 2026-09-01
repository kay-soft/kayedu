"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { createStudentAction } from "@/app/[locale]/(center)/students/actions";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import {
  StudentFields,
  type GradeOption,
} from "@/components/center/student-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Register a student (spec §4.1 item 4).
 *
 * A student is registered **once** on the platform and connected to this
 * center. If the phone or email already belongs to someone, the action stops
 * and returns the match; confirming attaches a new `StudentProfile` to that
 * existing person instead of creating a duplicate (spec §5).
 */
export function StudentForm({
  grades,
  studentCount,
  noneLabel,
}: {
  grades: GradeOption[];
  studentCount: number;
  noneLabel: string;
}) {
  const t = useTranslations("Students");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    createStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const [dismissedMatch, setDismissedMatch] = useState<string | null>(null);

  const match =
    state.status === "matchFound" &&
    state.match &&
    state.match.userId !== dismissedMatch
      ? state.match
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("addTitle")}</CardTitle>
        <CardDescription>{t("addDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          // A successful add changes the count, remounting the form empty and
          // ready for the next registration; a rejected one keeps the input.
          key={`student-create-${studentCount}`}
          action={formAction}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="locale" value={locale} />
          {match ? (
            <input type="hidden" name="linkUserId" value={match.userId} />
          ) : null}

          {state.error ? (
            <FormMessage>{tErrors(state.error)}</FormMessage>
          ) : null}

          <PersonFields
            idPrefix="student-create"
            fieldErrors={state.fieldErrors}
          />

          <SectionHeader
            title={t("centerSectionTitle")}
            description={t("centerSectionDescription")}
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
            <SubmitButton className="w-full sm:w-auto">
              <Plus className="size-4" />
              {t("add")}
            </SubmitButton>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
