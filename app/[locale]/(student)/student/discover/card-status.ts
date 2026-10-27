import type { ClassCardBadge } from "@/components/explore/class-card";

/** A Discover class's status for the signed-in student (docs/04 §10). */
export type DiscoverCardStatus = "enrolled" | "pending" | "full" | "open" | "requiresApproval";

export const DISCOVER_STATUS_BADGE: Record<DiscoverCardStatus, ClassCardBadge["variant"]> = {
  enrolled: "success",
  pending: "warning",
  full: "neutral",
  open: "info",
  requiresApproval: "warning",
};

/**
 * One rule for the Discover card and the Discover class page (F5): enrolled,
 * then a pending request, then full (an instant class at its room set's
 * capacity), else open or needs approval.
 */
export function discoverCardStatus({
  isEnrolled,
  reservationStatus,
  isFull,
  requiresConfirmation,
}: {
  isEnrolled: boolean;
  reservationStatus: string | undefined;
  isFull: boolean;
  requiresConfirmation: boolean;
}): DiscoverCardStatus {
  if (isEnrolled) return "enrolled";
  if (reservationStatus === "PENDING") return "pending";
  if (isFull && !requiresConfirmation) return "full";
  return requiresConfirmation ? "requiresApproval" : "open";
}
