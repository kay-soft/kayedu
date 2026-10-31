import { getLocale, getTranslations } from "next-intl/server";
import { Users } from "lucide-react";

import { ChildSelector } from "@/app/[locale]/(parent)/parent/child-selector";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { SessionCalendar } from "@/components/shared/session-calendar";
import { studentCalendarEntry } from "@/components/shared/student-calendar-entry";
import { Card, CardContent } from "@/components/ui/card";
import { requireParentUser } from "@/lib/auth/tenant";
import {
  STUDENT_CALENDAR_TONES,
  calendarMonthRange,
  parseCalendarDay,
  parseCalendarMonth,
} from "@/lib/calendar";
import { prisma } from "@/lib/db/client";
import { centerTimeZone } from "@/lib/db/session-lifecycle";
import { bookedCalendarEntries, childBookedUpcoming, studentCalendarMonth } from "@/lib/db/student-portal";
import { ROUTES } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";

/**
 * The parent's calendar (U7, spec §4.5 item 2): the **selected child's**
 * month, read-only — the very reads the child's own calendar makes
 * (`studentCalendarMonth`, `childBookedUpcoming`) against that child's own
 * `centerId`/`studentProfileId`, so it is never a superset of what the child
 * can see. The child is one of `requireParentUser()`'s options (ACTIVE family
 * links, active profiles at accessible branches, F3) — the `?child=` param is
 * re-checked against that list, never trusted. No write path of any kind.
 */
export default async function ParentCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireParentUser();
  const t = await getTranslations("Calendar");
  const tParent = await getTranslations("ParentPortal");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  if (session.children.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("parentTitle")} description={t("parentSubtitle")} />
        <Card>
          <CardContent>
            <EmptyState
              icon={<Users />}
              tone="info"
              title={session.linkedChildren.length === 0 ? tParent("noChildren") : tParent("noBranchTitle")}
              description={t("parentNoChild")}
              action={<LinkButton href={ROUTES.parentHome}>{t("parentBack")}</LinkButton>}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const rawParams = await searchParams;
  const selected =
    session.children.find((child) => child.studentProfileId === rawParams.child?.trim()) ?? session.children[0];

  // R7b: "today" is the selected child's own branch's calendar day.
  const now = new Date();
  const today = todayInTimezone(await centerTimeZone(prisma, selected.centerId), now);
  const month = parseCalendarMonth(rawParams.month, today);
  const range = calendarMonthRange(month);
  const selectedDay = parseCalendarDay(rawParams.day, month, today);

  const [rows, booked] = await Promise.all([
    studentCalendarMonth(prisma, selected.centerId, selected.studentProfileId, range, today),
    childBookedUpcoming(prisma, selected.centerId, selected.studentProfileId, now),
  ]);
  const enrolledIds = new Set(rows.map((row) => row.sessionId));
  const entries = [...rows, ...bookedCalendarEntries(booked, range, enrolledIds)].map((row) =>
    studentCalendarEntry(row, selected.centerName, locale, tCommon("none")),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("parentTitle")} description={t("parentSubtitle")} />

      {session.children.length > 1 ? (
        <ChildSelector
          options={session.children.map((child) => ({
            id: child.studentProfileId,
            label: `${child.childName} · ${child.centerName}`,
          }))}
          selectedId={selected.studentProfileId}
          label={tParent("childSelectorLabel")}
        />
      ) : (
        <div>
          <p className="text-xs font-medium text-text-secondary">{tParent("childSelectorLabel")}</p>
          <p className="text-sm text-text-primary">
            {selected.childName} · {selected.centerName}
          </p>
        </div>
      )}

      {/* The child selector changes the whole calendar: one region dims it. */}
      <ResultsRegion>
        <SessionCalendar
          locale={locale}
          basePath={ROUTES.parentCalendar}
          keep={{ child: selected.studentProfileId }}
          month={month}
          selectedDay={selectedDay}
          todayKey={dateKey(today)}
          entries={entries}
          legend={STUDENT_CALENDAR_TONES}
          emptyMonthHint={t("parentEmpty")}
          region={false}
        />
      </ResultsRegion>
    </div>
  );
}
