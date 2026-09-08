"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { setTeacherActiveAction } from "@/app/[locale]/(center)/teachers/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { LinkButton } from "@/components/shared/link-button";

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
  const [state, formAction] = useActionState(
    setTeacherActiveAction,
    IDLE_PEOPLE_STATE,
  );

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.name")}
        </span>
        <Link
          href={ROUTES.centerTeacher(teacher.membershipId)}
          className="truncate text-sm font-medium text-brand hover:underline"
        >
          {teacher.name}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.contact")}
        </span>
        <span className="truncate text-sm text-text-secondary" dir="ltr">
          {teacher.phone ?? teacher.email ?? "—"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-text-muted md:hidden">
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

      <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:w-44 md:justify-end">
        <LinkButton href={ROUTES.centerTeacher(teacher.membershipId)}>
          {t("open")}
        </LinkButton>

        {canManage ? (
          <form action={formAction}>
            <input type="hidden" name="locale" value={locale} />
            <input
              type="hidden"
              name="membershipId"
              value={teacher.membershipId}
            />
            {/* An absent checkbox means false, so only send it to activate. */}
            {teacher.active ? null : (
              <input type="hidden" name="active" value="true" />
            )}
            <Button type="submit" variant="ghost" className="h-11 w-full px-4">
              {teacher.active ? tCommon("deactivate") : tCommon("activate")}
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
