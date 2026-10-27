"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** Exactly three statuses (R1): present, late, absent. */
export type AttendanceStatusValue = "PRESENT" | "LATE" | "ABSENT";

export const ATTENDANCE_STATUS_ORDER: AttendanceStatusValue[] = ["PRESENT", "LATE", "ABSENT"];

/** Present = green, late = amber, absent = red (CLAUDE.md rule 8). */
export const ATTENDANCE_STATUS_TINT: Record<AttendanceStatusValue, string> = {
  PRESENT: "bg-success-bg text-success-fg ring-1 ring-success/30",
  LATE: "bg-warning-bg text-warning-fg ring-1 ring-warning/30",
  ABSENT: "bg-danger-bg text-danger-fg ring-1 ring-danger/30",
};

/**
 * The segmented Attendance control (docs/04-design-system.md §5): three large
 * touch targets, unselected = neutral outline, selected = the semantic tint.
 * Used hundreds of times a day, so this is deliberately *not* stateful —
 * it is one `<form>` with three named submit buttons, and the caller (which
 * already owns a `useActionState` for its own pending/error handling, exactly
 * like every other roster form in this codebase — see `class-roster.tsx`)
 * supplies `formAction` and the hidden fields the action needs.
 *
 * `interceptStatus` (R2): that one status's button does not submit — it
 * calls `onIntercept` instead, so the caller can confirm first. The roster
 * uses it for Absent on a paid student, whose payment the change voids.
 *
 * `statuses` (T5) narrows the buttons: a "Not arrived" row is corrected to
 * Present or Late only — it is already ABSENT underneath.
 */
export function AttendanceControl({
  formAction,
  value,
  hiddenFields,
  pending,
  size = "md",
  interceptStatus,
  onIntercept,
  statuses = ATTENDANCE_STATUS_ORDER,
}: {
  formAction: (formData: FormData) => void;
  /** Currently recorded status, or null if this attendee has never been marked. */
  value: AttendanceStatusValue | null;
  hiddenFields: ReactNode;
  pending?: boolean;
  size?: "md" | "lg";
  interceptStatus?: AttendanceStatusValue;
  onIntercept?: () => void;
  statuses?: AttendanceStatusValue[];
}) {
  const t = useTranslations("Sessions.attendance");

  return (
    <form
      action={formAction}
      className="inline-flex flex-wrap gap-1.5"
      role="group"
      aria-label={t("groupLabel")}
    >
      {hiddenFields}
      {statuses.map((status) => {
        const selected = value === status;
        const intercepted = status === interceptStatus && !selected && onIntercept;
        return (
          <button
            key={status}
            type={intercepted ? "button" : "submit"}
            name={intercepted ? undefined : "status"}
            value={intercepted ? undefined : status}
            onClick={intercepted ? onIntercept : undefined}
            disabled={pending}
            aria-pressed={selected}
            className={cn(
              "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-ui focus-ring disabled:pointer-events-none disabled:opacity-60",
              size === "lg" ? "min-h-12 px-4 text-base" : undefined,
              selected
                ? ATTENDANCE_STATUS_TINT[status]
                : "border border-border-control bg-surface text-text-secondary hover:border-border-control-hover hover:bg-surface-hover active:bg-surface-active",
            )}
          >
            {/* The chosen status is never colour alone (DES, docs/04 §14.7). */}
            {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
            {t(status)}
          </button>
        );
      })}
    </form>
  );
}
