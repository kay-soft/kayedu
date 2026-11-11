import { z } from "zod";

import { localeSchema } from "./auth.ts";

/**
 * Opening one notice from the bell's panel or the inbox (W1). The id is opaque
 * here (the `lib/validation/settings.ts` rule): the reader-scoped lookup
 * decides whether it resolves — another person's id is "not found".
 */
export const openNotificationSchema = z.object({
  locale: localeSchema,
  id: z.string().trim().min(1).max(64),
});

/** "Mark all as read" on the inbox. */
export const markAllNotificationsSchema = z.object({
  locale: localeSchema,
});

/** "Mark all as read"'s answer — every mutation answers (docs/04 §14.2). */
export type NotificationActionState = { status?: "markedAllRead"; error?: "invalid" | "signedOut" } | null;
export const IDLE_NOTIFICATION_STATE: NotificationActionState = null;

/** The inbox's page size (`/notifications`), and the bell panel's "latest 10". */
export const NOTIFICATIONS_PAGE_SIZE = 20;
export const NOTIFICATION_PANEL_SIZE = 10;
