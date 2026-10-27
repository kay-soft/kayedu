import { ReserveButton } from "@/app/[locale]/(student)/student/discover/reserve-button";
import {
  DISCOVER_STATUS_BADGE,
  type DiscoverCardStatus,
} from "@/app/[locale]/(student)/student/discover/card-status";
import { Badge } from "@/components/ui/badge";
/**
 * The Discover action slot (docs/04 §10), on the card and on the class page:
 * a status badge once enrolled, requested or full, else the ReserveButton.
 */
export function DiscoverAction({
  status,
  centerId,
  classGroupId,
  requiresConfirmation,
  labels,
}: {
  status: DiscoverCardStatus;
  centerId: string;
  classGroupId: string;
  requiresConfirmation: boolean;
  labels: { enrolled: string; pending: string; full: string };
}) {
  if (status === "enrolled" || status === "pending" || status === "full") {
    return (
      <Badge variant={DISCOVER_STATUS_BADGE[status]} className="w-full justify-center py-2">
        {labels[status]}
      </Badge>
    );
  }
  return (
    <ReserveButton
      centerId={centerId}
      classGroupId={classGroupId}
      requiresConfirmation={requiresConfirmation}
    />
  );
}
