import { NotificationBell } from "@/components/shell/notification-bell";
import { getAuthUser, getCurrentUser } from "@/lib/auth/session";
import { unreadNotificationCount } from "@/lib/notifications/reach";
import { ACCOUNT_HUB_HINT } from "@/lib/routes";

/**
 * The bell on the `(auth)` layout's header (W1, D-W12 — "the hub included"):
 * the branch hub (`/select-center`) lives in that layout, beside the
 * signed-out screens. Nothing renders for a visitor with no session, and the
 * session check runs first so a signed-out sign-in page reads no `User`.
 * The inbox opens in the hub shell (`?from=hub`).
 */
export async function HubBell() {
  if (!(await getAuthUser())) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  return <NotificationBell unread={await unreadNotificationCount(user.id)} from={ACCOUNT_HUB_HINT} />;
}
