import { cache } from "react";

import { getUserCenterRelations } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import {
  countUnread,
  hiddenAssessmentNoticeIds,
  syncAssessmentSoonNotices,
  type NotificationReach,
} from "@/lib/db/notifications";

/**
 * What a person reaches right now, for the access re-check every notification
 * read makes (W1, decision 3) — the branches of their relations, resolved by
 * the same per-request `cache()` the shells and the hub already use, so the
 * bell adds no relation query to a page that has one. A person who is not a
 * student anywhere adds no assessment query either (D-W32).
 */
export async function notificationReach(
  userId: string,
  options: { unreadOnly?: boolean } = {},
): Promise<NotificationReach> {
  const relations = await getUserCenterRelations(userId);
  const studentCenterIds = relations.filter((relation) => relation.studentProfile).map((relation) => relation.center.id);
  return {
    relationCenterIds: relations.map((relation) => relation.center.id),
    studentCenterIds,
    hiddenNoticeIds: await hiddenAssessmentNoticeIds(prisma, userId, studentCenterIds, new Date(), options),
  };
}

/**
 * The computed "soon" notices (W3b, D-W32), once per request: called before a
 * read of the bell or the inbox, only for a person with a student profile. Never
 * a job, a timer or a poll (rule 12).
 */
export const ensureSoonNotices = cache(async (userId: string): Promise<void> => {
  const relations = await getUserCenterRelations(userId);
  const studentCenterIds = relations.filter((relation) => relation.studentProfile).map((relation) => relation.center.id);
  if (studentCenterIds.length > 0) await syncAssessmentSoonNotices(prisma, userId, studentCenterIds, new Date());
});

/**
 * The bell's unread count — read on every navigation, server-rendered, never
 * polled (D-W12). Cached per request: a shell and a page share one count.
 */
export const unreadNotificationCount = cache(async (userId: string): Promise<number> => {
  await ensureSoonNotices(userId);
  return countUnread(prisma, userId, await notificationReach(userId, { unreadOnly: true }));
});
