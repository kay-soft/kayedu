"use client";

import { startTransition, useEffect, useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { createTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { NewTeacherFields } from "@/components/center/new-teacher-fields";
import { DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { ErrorSummary } from "@/components/shared/error-summary";
import { FormMessage } from "@/components/shared/form-message";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { IDLE_PEOPLE_STATE, teacherCreateSchema } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { useClientValidation } from "@/lib/ui/client-validation";

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
  branches,
  activeBranchId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** F1: the branches where the actor holds teacher.manage; a select appears with more than one. */
  branches: { id: string; name: string }[];
  activeBranchId: string;
}) {
  const t = useTranslations("Teachers");
  const tSections = useTranslations("Teachers.addSections");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(
    createTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  // The action's own schema, run before the round trip (docs/04 §14.2).
  const { clientErrors, check } = useClientValidation(teacherCreateSchema);
  const fieldErrors = clientErrors ?? state.fieldErrors;
  const [matchPending, setMatchPending] = useState(false);
  const [branchId, setBranchId] = useState(activeBranchId);
  const tToast = useTranslations("Teachers.toast");

  // The row lands on this page's list only at the active branch; elsewhere
  // the confirmation names the branch it went to (F1).
  useActionFeedback(state, {
    success: (status, result) =>
      status === "created"
        ? result.branchName
          ? tToast("addedAtBranch", { branch: result.branchName })
          : tToast("added")
        : null,
  });

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state.status, onOpenChange]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    if (!check(event.currentTarget, formData)) return;
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
        <ErrorSummary fieldErrors={fieldErrors} />

        {branches.length > 1 ? (
          <div className="flex flex-col gap-1.5 sm:max-w-md">
            <Label htmlFor="teacher-create-branch">{t("branchLabel")}</Label>
            <Select
              id="teacher-create-branch"
              name="branchId"
              value={branchId}
              onValueChange={setBranchId}
              aria-describedby="teacher-create-branch-hint"
              aria-invalid={fieldErrors?.branchId ? true : undefined}
              options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
            />
            <p id="teacher-create-branch-hint" className="text-xs text-text-muted">
              {t("branchHint")}
            </p>
          </div>
        ) : null}

        <DialogSections>
          <FormSection
            wide
            title={tSections("person")}
            description={tSections("personHint")}
            icon={<UserRound />}
          >
            <NewTeacherFields
              // A match found at one branch says nothing about another: a
              // branch change starts the person afresh.
              key={branchId}
              lookupBranchId={branchId !== activeBranchId ? branchId : undefined}
              idPrefix="teacher-create"
              showHeader={false}
              fieldErrors={fieldErrors}
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
