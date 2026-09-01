"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { createTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { ToggleRow } from "@/components/settings/toggle-row";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Add a teacher. If the phone or email already belongs to someone on the
 * platform, the action returns the match instead of writing anything: the panel
 * names them, and confirming links a **membership** at this center to that
 * existing person (spec §5) rather than creating a second identity.
 */
export function TeacherForm({ teacherCount }: { teacherCount: number }) {
  const t = useTranslations("Teachers");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createTeacherAction,
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
          // A successful add changes the teacher count, which remounts the
          // form with empty inputs. A rejected one keeps what was typed.
          key={`teacher-create-${teacherCount}`}
          action={formAction}
          className="flex flex-col gap-4"
          noValidate
        >
          <input type="hidden" name="locale" value={locale} />
          {/* Present only after staff confirm the match — this is what links. */}
          {match ? (
            <input type="hidden" name="linkUserId" value={match.userId} />
          ) : null}

          {state.error ? (
            <FormMessage>{tErrors(state.error)}</FormMessage>
          ) : null}

          <PersonFields idPrefix="teacher-create" fieldErrors={state.fieldErrors} />

          <ToggleRow
            name="canSeeEarnings"
            label={t("canSeeEarnings")}
            description={t("canSeeEarningsHint")}
            defaultChecked
          />

          {match ? (
            <MatchPanel
              match={match}
              linkLabel={t("linkAsTeacher")}
              blocked={match.existingHere === "teacher"}
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
