import type { Notification, NotificationKind } from "@prisma/client";
import { getTranslations } from "next-intl/server";

import { branchName } from "@/lib/branch-name";
import { loadNotificationSubjects, type NotificationSession } from "@/lib/db/notifications";
import { prisma } from "@/lib/db/client";
import { formatDateTime, formatDay, formatRelativeTime, formatTimeRange } from "@/lib/format";
import { isIdsOnlyPayload } from "@/lib/notifications/kinds";
import { sessionDisplayName } from "@/lib/session-label";

/** One notice as the bell's panel and the inbox page show it — already in the reader's language. */
export type PresentedNotification = {
  id: string;
  kind: NotificationKind;
  text: string;
  /** "5 minutes ago" / a date from a week on. */
  time: string;
  /** ISO, for `<time dateTime>`. */
  createdAt: string;
  unread: boolean;
};

/** A teacher's title in a sentence of the other script: isolated, so it cannot reorder what surrounds it. */
const isolate = (text: string) => `${String.fromCodePoint(0x2068)}${text}${String.fromCodePoint(0x2069)}`;

/**
 * Renders a page of notices at read time (W1, decision 2): the text is the
 * kind's next-intl message, filled with **current** names loaded from the
 * row's ids (`loadNotificationSubjects`), so a renamed class or branch shows
 * its new name and nothing personal was ever stored. An entity that no longer
 * exists reads as "—" rather than hiding the notice.
 */
export async function presentNotifications(
  rows: readonly Notification[],
  locale: string,
  now: Date = new Date(),
): Promise<PresentedNotification[]> {
  if (rows.length === 0) return [];
  const [t, subjects] = await Promise.all([
    // The locale is explicit: the bell's panel renders this from a Server Action.
    getTranslations({ locale, namespace: "Notifications" }),
    loadNotificationSubjects(prisma, rows),
  ]);
  const fallback = t("fallback");

  const sessionParts = (session: NotificationSession | undefined) =>
    session
      ? {
          name: sessionDisplayName(locale, session),
          date: formatDay(session.date, locale),
          time: formatTimeRange(session.startTime, session.endTime, locale),
        }
      : { name: fallback, date: fallback, time: fallback };

  return rows.map((row) => {
    const payload = isIdsOnlyPayload(row.kind, row.payload) ? row.payload : {};
    const branchRow = row.centerId ? subjects.branches.get(row.centerId) : undefined;
    const branch = branchRow ? branchName(locale, branchRow) : fallback;
    let text: string;
    switch (row.kind) {
      case "ENROLLMENT_APPROVED":
      case "ENROLLMENT_DECLINED": {
        const classGroup = payload.classGroupId ? subjects.classes.get(payload.classGroupId) : undefined;
        const className = classGroup ? sessionDisplayName(locale, { classGroup }) : fallback;
        text = t(`kinds.${row.kind}`, { branch, className });
        break;
      }
      case "BOOKING_APPROVED":
      case "BOOKING_DECLINED":
      case "SESSION_CANCELLED": {
        const session = sessionParts(subjects.sessions.get(payload.sessionId ?? ""));
        text = t(`kinds.${row.kind}`, { branch, className: session.name, date: session.date, time: session.time });
        break;
      }
      case "SESSION_RESCHEDULED": {
        const from = sessionParts(subjects.sessions.get(payload.sessionId ?? ""));
        const to = sessionParts(subjects.sessions.get(payload.newSessionId ?? ""));
        text = t("kinds.SESSION_RESCHEDULED", {
          branch,
          className: from.name,
          oldDate: from.date,
          oldTime: from.time,
          newDate: to.date,
          newTime: to.time,
        });
        break;
      }
      // W3b (D-W32): the assessment's current title, class and times, so a rename
      // or an extension shows. In the session's frozen timezone, else the branch's.
      case "ASSESSMENT_PUBLISHED":
      case "ASSESSMENT_EXTENDED":
      case "ASSESSMENT_OPENS_SOON":
      case "ASSESSMENT_DUE_SOON": {
        const assessment = subjects.assessments.get(payload.assessmentId ?? "");
        const zone = assessment?.session?.timezone ?? branchRow?.timeZone;
        const when = (at: Date | null | undefined) => (at && zone ? formatDateTime(at, locale, zone) : fallback);
        text = t(`kinds.${row.kind}`, {
          type: assessment?.type ?? "other",
          title: assessment ? isolate(assessment.title) : fallback,
          className: assessment ? sessionDisplayName(locale, { classGroup: assessment.classGroup }) : fallback,
          branch,
          start: when(assessment?.windowStart),
          end: when(assessment?.type === "EXAM" ? assessment.windowEnd : assessment?.deadline),
        });
        break;
      }
      // W8b (D-W39 item 7): the workspace's current name and its teacher's.
      case "WORKSPACE_INVITATION": {
        const teacher = row.centerId ? subjects.workspaceTeachers.get(row.centerId) : undefined;
        text = t("kinds.WORKSPACE_INVITATION", {
          teacher: teacher ? isolate(teacher) : fallback,
          workspace: branchRow ? isolate(branchRow.name) : fallback,
        });
        break;
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      text,
      time: formatRelativeTime(row.createdAt, now, locale),
      createdAt: row.createdAt.toISOString(),
      unread: row.readAt === null,
    };
  });
}
