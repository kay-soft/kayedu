"use client";

import { useLocale, useTranslations } from "next-intl";

import { setTeacherActiveAction } from "@/app/[locale]/(center)/teachers/actions";
import { Ltr } from "@/components/shared/ltr";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

export type TeacherRowData = {
  membershipId: string;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  /** Blocked students on this teacher's list, shown as a count. */
  blockCount: number;
};

/**
 * One teacher. A stacked card below `md` and a table row from `md` up — a
 * primary list is never side-scrolled (docs/04 §6).
 */
export function TeacherRow({
  teacher,
  canManage,
}: {
  teacher: TeacherRowData;
  canManage: boolean;
}) {
  const t = useTranslations("Teachers");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    setTeacherActiveAction,
    IDLE_PEOPLE_STATE,
  );
  const tToast = useTranslations("Toasts");
  useActionFeedback(state, {
    success: () => tToast(teacher.active ? "teacherActivated" : "teacherDeactivated"),
  });

  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border p-3 md:flex md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:transition-ui md:hover:bg-surface-hover">
      <div className="order-first col-span-2 flex min-w-0 flex-col md:order-none md:col-span-1 md:flex-1">
        <span className="sr-only">
          {t("columns.name")}
        </span>
        <Link
          href={ROUTES.centerTeacher(teacher.membershipId)}
          className="truncate rounded-sm text-base font-semibold text-brand focus-ring hover:underline md:text-sm md:font-medium"
        >
          {teacher.name}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.contact")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          <Ltr>{teacher.phone ?? teacher.email ?? "—"}</Ltr>
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.blocked")}
        </span>
        <span className="text-sm text-text-secondary">
          {teacher.blockCount > 0 ? (
            <Badge variant="warning">
              {t("blockedCount", { count: teacher.blockCount })}
            </Badge>
          ) : (
            "—"
          )}
        </span>
      </div>

      <div className="md:w-24 md:shrink-0">
        <Badge variant={teacher.active ? "success" : "neutral"}>
          {teacher.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="col-span-2 flex shrink-0 flex-col gap-2 sm:flex-row md:col-span-1 md:w-36 md:justify-end">

        {canManage ? (
          teacher.active ? (
            // Deactivating asks first (docs/04 §14.6); activating is one tap.
            <ConfirmAction
              label={tCommon("deactivate")}
              variant="outline"
              triggerClassName="h-11 w-full px-4 md:w-auto"
              title={t("deactivateConfirm.title", { name: teacher.name })}
              description={t("deactivateConfirm.body")}
              action={formAction}
              fields={{ locale, membershipId: teacher.membershipId }}
            />
          ) : (
            <form action={formAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="membershipId" value={teacher.membershipId} />
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
