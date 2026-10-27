"use client";

import { UserCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { useRequestCheckIn } from "@/app/[locale]/(center)/sessions/[id]/session-check-in-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type BookedStudent = {
  studentProfileId: string;
  name: string;
  studentCode: string;
  photoUrl: string | null;
};

/**
 * "Booked — not arrived (n)" (F6): students who booked this one session
 * online and have not been checked in yet. Check in opens the same confirm
 * panel as every other pick on this page (T2) — "Booked", the session's price,
 * a payment method — and nothing is written until it is confirmed. A booked
 * no-show writes nothing at close (absences stay enrolled-only, R2).
 */
export function BookedNotArrived({
  students,
  canCheckIn,
}: {
  students: BookedStudent[];
  canCheckIn: boolean;
}) {
  const t = useTranslations("Sessions.booked");
  const requestCheckIn = useRequestCheckIn();

  if (students.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <p className="text-sm font-medium text-text-primary">{t("notArrived", { count: students.length })}</p>
      <ul className="flex flex-col gap-2">
        {students.map((student) => (
          <li
            key={student.studentProfileId}
            className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{student.name}</p>
                <p className="text-xs text-text-muted" dir="ltr">
                  {student.studentCode}
                </p>
              </div>
              <Badge variant="info">{t("badge")}</Badge>
            </div>
            {canCheckIn ? (
              <Button
                type="button"
                className="h-11 w-full px-4 sm:w-auto"
                onClick={() =>
                  requestCheckIn({
                    id: student.studentProfileId,
                    name: student.name,
                    code: student.studentCode,
                    photoUrl: student.photoUrl,
                    enrolled: false,
                  })
                }
              >
                <UserCheck className="size-4" aria-hidden />
                {t("checkIn")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
