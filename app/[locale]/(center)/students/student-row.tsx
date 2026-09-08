"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { setStudentActiveAction } from "@/app/[locale]/(center)/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { LinkButton } from "@/components/shared/link-button";

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
  const [state, formAction] = useActionState(
    setStudentActiveAction,
    IDLE_PEOPLE_STATE,
  );

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex w-full min-w-0 flex-col md:w-24 md:shrink-0">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.code")}
        </span>
        <span className="truncate text-sm tabular-nums text-text-secondary" dir="ltr">
          {student.studentCode}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.name")}
        </span>
        <Link
          href={ROUTES.centerStudent(student.studentProfileId)}
          className="truncate text-sm font-medium text-brand hover:underline"
        >
          {student.name}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.grade")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          {student.gradeName ?? "—"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.contact")}
        </span>
        <span className="truncate text-sm text-text-secondary" dir="ltr">
          {student.contact ?? "—"}
        </span>
      </div>

      <div className="md:w-24 md:shrink-0">
        <Badge variant={student.active ? "success" : "neutral"}>
          {student.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:w-44 md:justify-end">
        <LinkButton href={ROUTES.centerStudent(student.studentProfileId)}>
          {t("open")}
        </LinkButton>

        {canManage ? (
          <form action={formAction}>
            <input type="hidden" name="locale" value={locale} />
            <input
              type="hidden"
              name="studentProfileId"
              value={student.studentProfileId}
            />
            {student.active ? null : (
              <input type="hidden" name="active" value="true" />
            )}
            <Button type="submit" variant="ghost" className="h-11 w-full px-4">
              {student.active ? tCommon("deactivate") : tCommon("activate")}
            </Button>
          </form>
        ) : null}
      </div>

      {state.error ? (
        <div className="md:w-full md:basis-full">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
