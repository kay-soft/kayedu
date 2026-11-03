import { cache } from "react";

import { getUserCenterRelations } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { countUnread, type NotificationReach } from "@/lib/db/notifications";

/**
 * What a person reaches right now, for the access re-check every notification
 * read makes (W1, decision 3) — the branches of their relations, resolved by
 * the same per-request `cache()` the shells and the hub already use, so the
 * bell adds no relation query to a page that has one.
 */
export async function notificationReach(userId: string): Promise<NotificationReach> {
  const relations = await getUserCenterRelations(userId);
  return { relationCenterIds: relations.map((relation) => relation.center.id) };
}

/**
 * The bell's unread count — read on every navigation, server-rendered, never
 * polled (D-W12). Cached per request: a shell and a page share one count.
 */
export const unreadNotificationCount = cache(async (userId: string): Promise<number> => {
  return countUnread(prisma, userId, await notificationReach(userId));
});
