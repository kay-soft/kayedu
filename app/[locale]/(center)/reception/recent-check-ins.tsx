import { UserRound } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/shared/link-button";
import { formatClockTime, formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

export type RecentCheckInRow = {
  id: string;
  studentName: string;
  studentCode: string;
  photoUrl: string | null;
  status: "PRESENT" | "LATE" | "ABSENT";
  recordedAt: Date;
};

/**
 * The last few check-ins on the session being attended (R7), the running
 * count and a link to the full roster. Server-rendered from the same data the
 * cards use, so it refreshes with the page after every check-in
 * (`revalidatePath` in `checkInAction`) — no polling.
 */
export async function RecentCheckIns({
  sessionId,
  rows,
  total,
  locale,
  timeZone,
}: {
  sessionId: string;
  rows: RecentCheckInRow[];
  total: number;
  locale: string;
  timeZone: string;
}) {
  const t = await getTranslations("Reception");
  const tAttendance = await getTranslations("Sessions.attendance");

  return (
    <section className="flex flex-col gap-3 border-t border-border-subtle pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{t("recent.title")}</h3>
        <p className="text-sm text-text-secondary">
          {t("recent.total")}{" "}
          <span className="font-semibold tabular-nums text-text-primary">
            {formatNumber(total, locale)}
          </span>
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{t("recent.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-border-subtle px-3 py-2"
            >
              {row.photoUrl ? (
                // A short-lived signed Storage URL, not a static/remote asset next/image can optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={row.photoUrl}
                  alt=""
                  className="size-9 shrink-0 rounded-full border border-border object-cover"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle text-text-muted">
                  <UserRound className="size-4" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{row.studentName}</p>
                <p className="text-xs text-text-muted" dir="ltr">
                  {row.studentCode}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge variant={row.status === "LATE" ? "warning" : "success"}>
                  {tAttendance(row.status)}
                </Badge>
                <span className="text-xs tabular-nums text-text-muted" dir="ltr">
                  {formatClockTime(row.recordedAt, locale, timeZone)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <LinkButton href={ROUTES.centerSession(sessionId)} className="w-full sm:w-fit">
        {t("recent.fullRoster")}
      </LinkButton>
    </section>
  );
}
