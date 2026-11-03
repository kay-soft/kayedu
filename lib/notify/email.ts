/**
 * Email switch (W1, D-W12). Server-only env, read at request time — the
 * `MEDIA_UPLOADS_ENABLED` pattern (`lib/media.ts`).
 *
 * `EMAIL_ENABLED` (default off) gates every notification email. Off, nothing
 * is sent and no screen says an email went. On needs M20's sender, which does
 * not exist yet: until then `queueNotificationEmails` is the one hook point a
 * notice passes through, and it sends nothing either way.
 *
 * No runtime imports, so the gates can exercise it outside Next.js.
 */

export function emailEnabled(): boolean {
  return process.env.EMAIL_ENABLED?.trim().toLowerCase() === "true";
}

/** What the hook did with a batch of notices — `check:notifications` asserts "off". */
export type EmailHookResult = { status: "off" } | { status: "noSender" };

/**
 * The email hook point (D-W12). `lib/db/notifications.ts` calls it for every
 * batch of notices it writes. M20 replaces the body with its sender (after the
 * event's transaction commits, never inside it); today it only reports why
 * nothing went.
 */
export function queueNotificationEmails(notices: readonly { userId: string; kind: string }[]): EmailHookResult {
  if (!emailEnabled() || notices.length === 0) return { status: "off" };
  return { status: "noSender" };
}
