"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import {
  countUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/db/notifications";
import { redirect } from "@/lib/i18n/navigation";
import { notificationHref } from "@/lib/notifications/kinds";
import { presentNotifications, type PresentedNotification } from "@/lib/notifications/present";
import { ensureSoonNotices, notificationReach } from "@/lib/notifications/reach";
import { ROUTES } from "@/lib/routes";
import { localeSchema } from "@/lib/validation/auth";
import {
  NOTIFICATION_PANEL_SIZE,
  markAllNotificationsSchema,
  openNotificationSchema,
  type NotificationActionState,
} from "@/lib/validation/notifications";

/**
 * The inbox's three writes and one read (W1, D-W12). Each acts on the signed-in
 * person's own notices only — `userId` comes from the session, never the form —
 * and re-checks access through `notificationReach`, so a hidden notice can be
 * neither listed nor opened.
 */

export type NotificationPanelData = { items: PresentedNotification[]; unread: number };

/**
 * The bell panel's latest notices, loaded when the panel opens — on demand,
 * never polled. Null when signed out.
 */
export async function loadNotificationPanelAction(rawLocale: string): Promise<NotificationPanelData | null> {
  const parsed = localeSchema.safeParse(rawLocale);
  const user = await getCurrentUser();
  if (!parsed.success || !user) return null;

  await ensureSoonNotices(user.id);
  const reach = await notificationReach(user.id);
  const [{ rows }, unread] = await Promise.all([
    listNotifications(prisma, user.id, reach, { skip: 0, take: NOTIFICATION_PANEL_SIZE }),
    countUnread(prisma, user.id, reach),
  ]);
  return { items: await presentNotifications(rows, parsed.data), unread };
}

/**
 * Opening a notice marks it read and follows its deep link — the link is the
 * stored kind's own (`lib/notifications/kinds.ts`), never one from the form.
 * An id that is not the reader's, or no longer visible to them, lands on the
 * inbox with nothing changed.
 */
export async function openNotificationAction(formData: FormData): Promise<never> {
  const parsed = openNotificationSchema.safeParse(Object.fromEntries(formData));
  const locale = localeSchema.safeParse(formData.get("locale")).data ?? "en";
  const user = await getCurrentUser();
  if (!user) return redirect({ href: ROUTES.login, locale });
  if (!parsed.success) return redirect({ href: ROUTES.notifications, locale });

  const row = await markNotificationRead(prisma, user.id, await notificationReach(user.id), parsed.data.id);
  // The bell sits in every shell's layout: refresh it on the way out.
  revalidatePath("/", "layout");
  return redirect({ href: row ? notificationHref(row.kind, row.payload) : ROUTES.notifications, locale });
}

/** "Mark all as read" on the inbox — every notice the reader can see. */
export async function markAllNotificationsReadAction(
  _state: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  const parsed = markAllNotificationsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid" };
  const user = await getCurrentUser();
  if (!user) return { error: "signedOut" };

  await markAllNotificationsRead(prisma, user.id, await notificationReach(user.id, { unreadOnly: true }));
  revalidatePath("/", "layout");
  return { status: "markedAllRead" };
}
