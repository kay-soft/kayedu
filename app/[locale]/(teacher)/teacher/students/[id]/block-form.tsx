"use client";

import { useActionState } from "react";
import { Ban, UserMinus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  teacherBlockStudentAction,
  teacherUnblockStudentAction,
} from "@/app/[locale]/(teacher)/teacher/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";

/**
 * Block/unblock this student from the current teacher (spec §4.2 items 2/3),
 * reusing the `StudentBlock` scope TEACHER mechanism from M3. `refId` is
 * always the acting teacher's own userId, resolved server-side — never a
 * value this form can influence.
 */
export function StudentBlockForm({
  studentProfileId,
  block,
}: {
  studentProfileId: string;
  block: { id: string; reason: string | null } | null;
}) {
  const t = useTranslations("TeacherStudents.block");
  const tErrors = useTranslations("TeacherStudents.errors");
  const locale = useLocale();

  const [blockState, blockAction] = useActionState(teacherBlockStudentAction, IDLE_TEACHER_STATE);
  const [unblockState, unblockAction] = useActionState(
    teacherUnblockStudentAction,
    IDLE_TEACHER_STATE,
  );

  const error = blockState.error ?? unblockState.error;

  if (block) {
    return (
      <div className="flex flex-col gap-3">
        {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}
        <p className="text-sm text-text-secondary">
          {block.reason ? t("blockedWithReason", { reason: block.reason }) : t("blocked")}
        </p>
        <form action={unblockAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="blockId" value={block.id} />
          <SubmitButton variant="outline">
            <UserMinus className="size-4" />
            {t("unblock")}
          </SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <form action={blockAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      {error ? <FormMessage className="sm:basis-full">{tErrors(error)}</FormMessage> : null}
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <label htmlFor="block-reason" className="text-xs font-medium text-text-secondary">
          {t("reason")}
        </label>
        <Input id="block-reason" name="reason" maxLength={200} placeholder={t("reasonPlaceholder")} />
      </div>

      <SubmitButton variant="destructive">
        <Ban className="size-4" />
        {t("block")}
      </SubmitButton>
    </form>
  );
}
