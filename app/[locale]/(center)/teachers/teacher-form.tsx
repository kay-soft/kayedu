"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { createTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { NewTeacherFields } from "@/components/center/new-teacher-fields";
import { DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Add a teacher — the body of the "Add teacher" dialog, in the shared
 * `DialogShell` (R10b, docs/04 §11.19).
 *
 * If the phone or email already belongs to someone on the platform, the
 * action returns the match instead of writing anything: the panel sits
 * directly under the phone field, names them, and confirming links a
 * **membership** at this center to that existing person (spec §5) rather than
 * creating a second identity. The fields and the match flow are
 * `NewTeacherFields`, shared with the class dialog's "New teacher" (R6).
 * The form submits through `startTransition` so a refused submit keeps what
 * was typed (a `<form action>` is reset by React 19).
 */
export function TeacherForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Teachers");
  const tSections = useTranslations("Teachers.addSections");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction, pending] = useActionState(
    createTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  const [matchPending, setMatchPending] = useState(false);

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state.status, onOpenChange]);

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
      submitDisabled={matchPending}
    >
      <input type="hidden" name="locale" value={locale} />

      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        <DialogSections>
          <FormSection
            wide
            title={tSections("person")}
            description={tSections("personHint")}
            icon={<UserRound />}
          >
            <NewTeacherFields
              idPrefix="teacher-create"
              showHeader={false}
              fieldErrors={state.fieldErrors}
              serverMatch={state.status === "matchFound" ? state.match : null}
              onPendingChange={setMatchPending}
              pending={pending}
            />
          </FormSection>
        </DialogSections>
      </div>
    </DialogShell>
  );
}
