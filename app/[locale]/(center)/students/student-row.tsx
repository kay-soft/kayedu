"use client";

import { useLocale, useTranslations } from "next-intl";

import { setStudentActiveAction } from "@/app/[locale]/(center)/students/actions";
import { Ltr } from "@/components/shared/ltr";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

export type StudentRowData = {
  studentProfileId: string;
  name: string;
  studentCode: string;
  gradeName: string | null;
  contact: string | null;
  active: boolean;
};

/** One student. Stacked card below `md`, table row from `md` up (docs/04 §6). */
export function StudentRow({
  student,
  canManage,
}: {
  student: StudentRowData;
  canManage: boolean;
}) {
  const t = useTranslations("Students");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    setStudentActiveAction,
    IDLE_PEOPLE_STATE,
  );
  const tToast = useTranslations("Toasts");
  useActionFeedback(state, {
    success: () => tToast(student.active ? "studentActivated" : "studentDeactivated"),
  });

  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border p-3 md:flex md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:transition-ui md:hover:bg-surface-hover">
      <div className="flex min-w-0 flex-col md:w-24 md:shrink-0">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.code")}
        </span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          <Ltr>{student.studentCode}</Ltr>
        </span>
      </div>

      <div className="order-first col-span-2 flex min-w-0 flex-col md:order-none md:col-span-1 md:flex-1">
        <span className="sr-only">
          {t("columns.name")}
        </span>
        <Link
          href={ROUTES.centerStudent(student.studentProfileId)}
          className="truncate rounded-sm text-base font-semibold text-brand focus-ring hover:underline md:text-sm md:font-medium"
        >
          {student.name}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.grade")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          {student.gradeName ?? "—"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.contact")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          <Ltr>{student.contact ?? "—"}</Ltr>
        </span>
      </div>

      <div className="md:w-24 md:shrink-0">
        <Badge variant={student.active ? "success" : "neutral"}>
          {student.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="col-span-2 flex shrink-0 flex-col gap-2 sm:flex-row md:col-span-1 md:w-36 md:justify-end">

        {canManage ? (
          student.active ? (
            // Deactivating asks first (docs/04 §14.6); activating is one tap.
            <ConfirmAction
              label={tCommon("deactivate")}
              variant="outline"
              triggerClassName="h-11 w-full px-4 md:w-auto"
              title={t("deactivateConfirm.title", { name: student.name })}
              description={t("deactivateConfirm.body")}
              action={formAction}
              fields={{ locale, studentProfileId: student.studentProfileId }}
            />
          ) : (
            <form action={formAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="studentProfileId" value={student.studentProfileId} />
              <input type="hidden" name="active" value="true" />
              <Button type="submit" variant="ghost" className="h-11 w-full px-4 md:w-auto">
                {tCommon("activate")}
              </Button>
            </form>
          )
        ) : null}
      </div>

      {state.error ? (
        <div className="col-span-2 md:w-full md:basis-full">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
