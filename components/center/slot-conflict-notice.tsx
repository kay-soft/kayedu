"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  checkSlotConflictsAction,
  type SlotConflictCheckInput,
} from "@/app/[locale]/(center)/conflicts/actions";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDate, formatTimeRange } from "@/lib/format";
import type { SlotConflictInfo } from "@/lib/scheduling";
import { cn } from "@/lib/utils";

/**
 * SlotConflictNotice (R3, docs/04-design-system.md §11.12) — the one way a
 * double-booked room or teacher is shown, in every form that writes a slot.
 *
 * Under the centre's WARN policy: an amber notice (`--warning` /
 * `--warning-bg`, the "attention" pair) listing each clash in full — "Room 1
 * is already booked by Maths · Grade 5, 4:00–6:00 PM on 12 Nov" — and an "I
 * understand, create anyway" checkbox posted as `confirmConflicts`; the form
 * keeps its submit disabled until it is ticked. Under DENY: a red notice
 * (`--danger`) with no override at all. Purely presentational — the server
 * re-checks on submit and refuses an unconfirmed conflict whatever this
 * showed.
 */
export function SlotConflictNotice({
  conflicts,
  policy,
  confirmed,
  onConfirmedChange,
  idPrefix,
  className,
}: {
  conflicts: SlotConflictInfo[];
  policy: "WARN" | "DENY";
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  idPrefix: string;
  className?: string;
}) {
  const t = useTranslations("RoomSets.conflicts");
  const tDays = useTranslations("Classes");
  const locale = useLocale();

  if (conflicts.length === 0) return null;
  const denied = policy === "DENY";
  const dayNames = tDays.raw("dayNames") as string[];

  const line = (conflict: SlotConflictInfo) => {
    const time =
      conflict.startTime && conflict.endTime
        ? formatTimeRange(conflict.startTime, conflict.endTime, locale)
        : "";
    const values = {
      room: conflict.roomName ?? t("unknownRoom"),
      teacher: conflict.teacherName ?? t("unknownTeacher"),
      className: conflict.className,
      time,
    };
    const kind = conflict.type === "room" ? "room" : "teacher";
    if (conflict.date) {
      // Noon UTC so the calendar day never shifts in any viewer's timezone.
      const date = formatDate(new Date(`${conflict.date}T12:00:00.000Z`), locale);
      return t(`${kind}OnDate`, { ...values, date });
    }
    if (conflict.dayOfWeek !== null) {
      return t(`${kind}Weekly`, { ...values, day: dayNames[conflict.dayOfWeek] ?? "" });
    }
    return t(`${kind}Plain`, values);
  };

  return (
    <div
      role={denied ? "alert" : "status"}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 text-sm",
        denied
          ? "border-danger/30 bg-danger-bg text-danger-fg"
          : "border-warning/30 bg-warning-bg text-warning-fg",
        className,
      )}
    >
      <p className="flex items-start gap-2 font-medium">
        {denied ? (
          <Ban className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        )}
        <span className="min-w-0">{denied ? t("denyTitle") : t("warnTitle")}</span>
      </p>
      <ul className="flex flex-col gap-1 ps-6">
        {conflicts.map((conflict, index) => (
          <li key={index} className="list-disc">
            {line(conflict)}
          </li>
        ))}
      </ul>
      {denied ? (
        <p className="ps-6 text-xs">{t("denyHint")}</p>
      ) : (
        <label
          htmlFor={`${idPrefix}-confirm-conflicts`}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md ps-1 text-text-primary"
        >
          <Checkbox
            id={`${idPrefix}-confirm-conflicts`}
            name="confirmConflicts"
            checked={confirmed}
            onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          />
          <span className="flex flex-col">
            <span className="font-medium">{t("confirm")}</span>
            <span className="text-xs text-text-secondary">{t("confirmHint")}</span>
          </span>
        </label>
      )}
    </div>
  );
}

/** A stable identity for a conflict list — a new list needs a new tick. */
function conflictsKey(conflicts: SlotConflictInfo[]): string {
  return JSON.stringify(conflicts);
}

/**
 * The conflict state a slot form needs (R3):
 * - a **debounced live preview** through `checkSlotConflictsAction` while
 *   `input` changes (advisory only — `null` input = nothing to check);
 * - the server's own refusal list (`refused`) when a submit came back with
 *   one, which wins while the preview has found nothing (it is authoritative
 *   for what was submitted);
 * - the confirmation tick, which resets whenever the list changes, so a tick
 *   given for one clash never silently covers a different one;
 * - `blocked`: whether the form's submit must stay disabled.
 */
export function useSlotConflicts(
  input: SlotConflictCheckInput | null,
  refused?: { conflicts?: SlotConflictInfo[]; conflictPolicy?: "WARN" | "DENY" },
) {
  const [preview, setPreview] = useState<{
    conflicts: SlotConflictInfo[];
    policy: "WARN" | "DENY";
    holiday?: boolean;
  }>({
    conflicts: [],
    policy: "WARN",
  });
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const request = useRef(0);
  const inputKey = input ? JSON.stringify(input) : null;

  useEffect(() => {
    if (!inputKey) return;
    const id = ++request.current;
    const timer = setTimeout(() => {
      checkSlotConflictsAction(JSON.parse(inputKey) as SlotConflictCheckInput)
        .then((result) => {
          if (id === request.current) setPreview(result);
        })
        .catch(() => {
          // Advisory only — a failed preview leaves the server check in charge.
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [inputKey]);

  const previewConflicts = inputKey ? preview.conflicts : [];
  const useRefusal = previewConflicts.length === 0 && (refused?.conflicts?.length ?? 0) > 0;
  const conflicts = useRefusal ? (refused?.conflicts ?? []) : previewConflicts;
  const policy = useRefusal ? (refused?.conflictPolicy ?? "WARN") : preview.policy;
  const key = conflictsKey(conflicts);
  const confirmed = conflicts.length > 0 && confirmedKey === key;

  return {
    conflicts,
    policy,
    confirmed,
    setConfirmed: (value: boolean) => setConfirmedKey(value ? key : null),
    blocked: conflicts.length > 0 && (policy === "DENY" || !confirmed),
    /** R5 — the previewed date is a holiday (a non-blocking notice). */
    holiday: Boolean(inputKey && preview.holiday),
  };
}
