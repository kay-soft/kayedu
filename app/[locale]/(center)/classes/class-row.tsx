"use client";

import { useLocale, useTranslations } from "next-intl";

import { setClassActiveAction } from "@/app/[locale]/(center)/classes/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SessionSyncNotice } from "@/components/center/session-sync-notice";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney, formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export type ClassRowData = {
  classGroupId: string;
  teacherName: string;
  subjectName: string | null;
  gradeName: string | null;
  roomName: string | null;
  price: number;
  /** R3 — the room set's summed capacity; 0 = no seat limit. */
  seats: number;
  enrolledCount: number;
  scheduleCount: number;
  /** R4 — the class's period, already formatted (lib/format.ts). */
  period: string;
  /** R4 — how many sessions the class has (cancelled ones aside). */
  sessionCount: number;
  active: boolean;
};

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

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
  const [state, formAction] = useGuardedActionState(
    setClassActiveAction,
    IDLE_CLASS_STATE,
  );
  // R4: reactivating regenerates the period's sessions — a refusal over a
  // double-booking comes back with the full list, confirmed here at once.
  const conflicts = useSlotConflicts(null, state.error ? state : undefined);

  const subjectGrade = [classGroup.subjectName, classGroup.gradeName]
    .filter(Boolean)
    .join(" · ");

  const hiddenFields = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={classGroup.classGroupId} />
      {classGroup.active ? null : <input type="hidden" name="active" value="true" />}
    </>
  );

  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border p-3 md:flex md:flex-wrap md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:transition-ui md:hover:bg-surface-hover">
      <div className="col-span-2 flex min-w-0 flex-col md:col-span-1 md:flex-[2]">
        <span className="sr-only">
          {t("columns.subject")}
        </span>
        <Link
          href={ROUTES.centerClass(classGroup.classGroupId)}
          className="truncate rounded-sm text-sm font-medium text-brand focus-ring hover:underline"
        >
          {subjectGrade || t("columns.untitled")}
        </Link>
        <span className="truncate text-xs text-text-secondary">
          {t("period.summary", { period: classGroup.period, count: classGroup.sessionCount })}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.teacher")}
        </span>
        <span className="truncate text-sm text-text-secondary" dir="auto">
          {classGroup.teacherName}
        </span>
        {/* The room joins as its own column from lg (docs/04 §14.6). */}
        <span className="hidden truncate text-xs text-text-secondary md:block lg:hidden">
          {classGroup.roomName ?? ""}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col md:hidden lg:flex">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.room")}
        </span>
        <span className="truncate text-sm text-text-secondary">
          {classGroup.roomName ?? "—"}
        </span>
      </div>

      <div className="flex flex-col md:w-24 md:shrink-0 md:text-end">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.price")}
        </span>
        <span className="text-sm whitespace-nowrap tabular-nums text-text-secondary">
          {formatMoney(classGroup.price, locale)}
        </span>
      </div>

      <div className="flex flex-col md:w-20 md:shrink-0 md:text-end">
        <span className="text-xs text-text-secondary md:sr-only">
          {t("columns.enrolled")}
        </span>
        <span className="text-sm whitespace-nowrap tabular-nums text-text-secondary">
          {formatNumber(classGroup.enrolledCount, locale)}
          {classGroup.seats > 0
            ? ` / ${formatNumber(classGroup.seats, locale)}`
            : ""}
        </span>
      </div>

      <div className="md:w-24 md:shrink-0">
        <Badge variant={classGroup.active ? "success" : "neutral"}>
          {classGroup.active ? tCommon("active") : tCommon("inactive")}
        </Badge>
      </div>

      <div className="col-span-2 flex shrink-0 flex-col gap-2 sm:flex-row md:col-span-1 md:w-32 md:justify-end">
        {canManage ? (
          classGroup.active ? (
            // SYS: deactivating removes or cancels the class's upcoming
            // sessions, so it asks first (activating needs no confirmation) —
            // in the shared confirmation since DES (docs/04 §14.6).
            <ConfirmAction
              label={tCommon("deactivate")}
              variant="outline"
              triggerClassName="h-11 w-full px-4 md:w-auto"
              title={t("deactivateConfirmTitle", { name: subjectGrade || t("columns.untitled") })}
              description={t("deactivateConfirm")}
              action={formAction}
              fields={{ locale, id: classGroup.classGroupId }}
            />
          ) : (
            <form action={formAction}>
              {hiddenFields}
              <Button type="submit" variant="ghost" className="h-11 w-full px-4 md:w-auto">
                {tCommon("activate")}
              </Button>
            </form>
          )
        ) : null}
      </div>

      {conflicts.conflicts.length > 0 ? (
        <form action={formAction} className="col-span-2 flex flex-col gap-2 md:w-full md:basis-full">
          {hiddenFields}
          <SlotConflictNotice
            idPrefix={`class-row-${classGroup.classGroupId}`}
            conflicts={conflicts.conflicts}
            policy={conflicts.policy}
            confirmed={conflicts.confirmed}
            onConfirmedChange={conflicts.setConfirmed}
          />
          {conflicts.policy === "WARN" ? (
            <SubmitButton className="w-full sm:w-auto sm:self-end" disabled={conflicts.blocked}>
              {t("activateAnyway")}
            </SubmitButton>
          ) : null}
        </form>
      ) : null}

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
        <div className="col-span-2 md:w-full md:basis-full">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
      {state.status === "saved" && state.sessions ? (
        <div className="col-span-2 md:w-full md:basis-full">
          <SessionSyncNotice sessions={state.sessions} />
        </div>
      ) : null}
    </li>
  );
}
