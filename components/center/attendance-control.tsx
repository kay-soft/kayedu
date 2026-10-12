"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** Exactly three statuses (R1): present, late, absent. */
export type AttendanceStatusValue = "PRESENT" | "LATE" | "ABSENT";

export const ATTENDANCE_STATUS_ORDER: AttendanceStatusValue[] = ["PRESENT", "LATE", "ABSENT"];

/** Present = green, late = amber, absent = red (CLAUDE.md rule 8). */
export const ATTENDANCE_STATUS_TINT: Record<AttendanceStatusValue, string> = {
  PRESENT: "bg-success-bg text-success ring-1 ring-success/30",
  LATE: "bg-warning-bg text-warning ring-1 ring-warning/30",
  ABSENT: "bg-danger-bg text-danger ring-1 ring-danger/30",
};

/**
 * The segmented Attendance control (docs/04-design-system.md §5): three large
 * touch targets, unselected = neutral outline, selected = the semantic tint.
 * Used hundreds of times a day, so this is deliberately *not* stateful —
 * it is one `<form>` with three named submit buttons, and the caller (which
 * already owns a `useActionState` for its own pending/error handling, exactly
 * like every other roster form in this codebase — see `class-roster.tsx`)
 * supplies `formAction` and the hidden fields the action needs.
 */
export function AttendanceControl({
  formAction,
  value,
  hiddenFields,
  pending,
  size = "md",
}: {
  formAction: (formData: FormData) => void;
  /** Currently recorded status, or null if this attendee has never been marked. */
  value: AttendanceStatusValue | null;
  hiddenFields: ReactNode;
  pending?: boolean;
  size?: "md" | "lg";
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
      {ATTENDANCE_STATUS_ORDER.map((status) => {
        const selected = value === status;
        return (
          <button
            key={status}
            type="submit"
            name="status"
            value={status}
            disabled={pending}
            aria-pressed={selected}
            className={cn(
              "min-h-11 min-w-11 rounded-lg px-3 text-sm font-medium transition-ui focus-ring disabled:pointer-events-none disabled:opacity-60",
              size === "lg" ? "min-h-12 px-4 text-base" : undefined,
              selected
                ? ATTENDANCE_STATUS_TINT[status]
                : "border border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-hover active:bg-surface-active",
            )}
          >
            {t(status)}
          </button>
        );
      })}
    </form>
  );
}
