import { ReserveButton } from "@/app/[locale]/(student)/student/discover/reserve-button";
import {
  DISCOVER_STATUS_BADGE,
  type DiscoverCardStatus,
} from "@/app/[locale]/(student)/student/discover/card-status";
import { CancelReservationButton } from "@/app/[locale]/(student)/student/reservations/cancel-button";
import { LeaveClassButton } from "@/app/[locale]/(student)/student/reservations/leave-class-button";
import { Badge } from "@/components/ui/badge";
import type { JoinSummary } from "@/lib/join-summary";

/**
 * The Discover action slot (docs/04 §10), on the card and on the class page:
 * a status badge once enrolled, requested or full, else the ReserveButton.
 *
 * **U8:** on the class page the student's own state also carries its undo —
 * `canLeave` adds "Leave class" under the Enrolled badge, and
 * `pendingReservationId` adds "Cancel request" under Pending. The cards pass
 * neither (a card is a browse surface).
 */
export function DiscoverAction({
  status,
  centerId,
  classGroupId,
  requiresConfirmation,
  labels,
  summary,
  canLeave,
  pendingReservationId,
}: {
  status: DiscoverCardStatus;
  centerId: string;
  classGroupId: string;
  requiresConfirmation: boolean;
  labels: { enrolled: string; pending: string; full: string };
  summary: JoinSummary;
  canLeave?: boolean;
  pendingReservationId?: string | null;
}) {
  if (status === "enrolled" || status === "pending" || status === "full") {
    return (
      <div className="flex flex-col gap-2">
        <Badge variant={DISCOVER_STATUS_BADGE[status]} className="w-full justify-center py-2">
          {labels[status]}
        </Badge>
        {status === "enrolled" && canLeave ? (
          <LeaveClassButton centerId={centerId} classGroupId={classGroupId} fullWidth />
        ) : null}
        {status === "pending" && pendingReservationId ? (
          <CancelReservationButton centerId={centerId} reservationId={pendingReservationId} fullWidth />
        ) : null}
      </div>
    );
  }
  return (
    <ReserveButton
      centerId={centerId}
      classGroupId={classGroupId}
      requiresConfirmation={requiresConfirmation}
      summary={summary}
    />
  );
}
