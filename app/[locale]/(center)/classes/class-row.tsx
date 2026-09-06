"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { setClassActiveAction } from "@/app/[locale]/(center)/classes/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney, formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

export type ClassRowData = {
  classGroupId: string;
  teacherName: string;
  subjectName: string | null;
  gradeName: string | null;
  roomName: string | null;
  price: number;
  capacity: number;
  enrolledCount: number;
  scheduleCount: number;
  active: boolean;
};

/** One class. Stacked card below `md`, table row from `md` up (docs/04 §6). */
export function ClassRow({
  classGroup,
  canManage,
}: {
  classGroup: ClassRowData;
  canManage: boolean;
}) {
  const t = useTranslations("Classes");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    setClassActiveAction,
    IDLE_CLASS_STATE,
  );

  const subjectGrade = [classGroup.subjectName, classGroup.gradeName]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.subject")}
        </span>
        <Link
          href={ROUTES.centerClass(classGroup.classGroupId)}
          className="truncate text-sm font-medium text-brand hover:underline"
        >
          {subjectGrade || t("columns.untitled")}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.teacher")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          {classGroup.teacherName}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.room")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          {classGroup.roomName ?? "—"}
        </span>
      </div>

      <div className="flex w-28 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.price")}
        </span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatMoney(classGroup.price, locale)}
        </span>
      </div>

      <div className="flex w-28 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">
          {t("columns.enrolled")}
        </span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatNumber(classGroup.enrolledCount, locale)}
          {classGroup.capacity > 0
            ? ` / ${formatNumber(classGroup.capacity, locale)}`
            : ""}
        </span>
      </div>

      <div className="w-24 shrink-0">
        <Badge variant={classGroup.active ? "success" : "neutral"}>
          {classGroup.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:w-44 md:justify-end">
        <Link
          href={ROUTES.centerClass(classGroup.classGroupId)}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle"
        >
          {t("open")}
        </Link>

        {canManage ? (
          <form action={formAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="id" value={classGroup.classGroupId} />
            {classGroup.active ? null : (
              <input type="hidden" name="active" value="true" />
            )}
            <Button type="submit" variant="ghost" className="h-11 w-full px-4">
              {classGroup.active ? tCommon("deactivate") : tCommon("activate")}
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
