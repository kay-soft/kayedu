/**
 * Server-side logging for the few deliberately best-effort steps (SYS): a
 * storage clean-up after a record is gone, a confirmation-email resend, the
 * parent-phone match at sign-up. Each must never fail the request it rides
 * on — but a failure must never be silent either. One line, a stable label,
 * the error's message only: never the call's arguments (a name, a phone),
 * matching Prisma's minimal production error format (SEC-75).
 */
export function logBestEffort(label: string): (error: unknown) => undefined {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[best-effort] ${label}: ${message.slice(0, 300)}`);
    return undefined;
  };
}
