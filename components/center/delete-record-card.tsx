"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { IDLE_PEOPLE_STATE, type PeopleActionState } from "@/lib/validation/people";

/**
 * The danger zone at the foot of a student or teacher page (R10b, docs/04 §5
 * "Detail page"): the one destructive control, set apart from Save instead of
 * sharing a row with it. Same two-step confirmation the edit forms had inline
 * — "Delete", then the irreversible warning with "Delete permanently" and
 * "Cancel" — and the same server action, which re-checks the permission and
 * refuses a record that already has history (`studentInUse` /
 * `teacherInUse`, shown here as the error). Only the record's id and the
 * locale are posted; that is all either action reads.
 *
 * The page renders this only to a role holding the delete permission.
 */
export function DeleteRecordCard({
  action,
  idField,
  recordId,
  title,
  description,
  confirmMessage,
}: {
  action: (state: PeopleActionState, formData: FormData) => Promise<PeopleActionState>;
  /** The hidden field the action reads the record's id from. */
  idField: "studentProfileId" | "membershipId";
  recordId: string;
  title: string;
  description: string;
  confirmMessage: string;
}) {
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(action, IDLE_PEOPLE_STATE);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-danger/30 bg-surface p-4 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-text-secondary">{description}</p>
      </div>

      <form action={formAction} className="flex flex-col gap-3 lg:items-end">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name={idField} value={recordId} />

        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        {confirming ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="text-sm text-text-secondary">{confirmMessage}</span>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <SubmitButton variant="destructive" className="w-full sm:w-auto">
                {tCommon("deleteYes")}
              </SubmitButton>
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full px-4 sm:w-auto"
                onClick={() => setConfirming(false)}
              >
                {tCommon("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="destructive"
            className="h-11 w-full gap-2 px-4 lg:w-auto"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" aria-hidden />
            {tCommon("delete")}
          </Button>
        )}
      </form>
    </section>
  );
}
