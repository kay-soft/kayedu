import { getTranslations } from "next-intl/server";

import { ReserveButton } from "@/app/[locale]/(student)/student/discover/reserve-button";
import type { ClassCardBadge } from "@/components/explore/class-card";
import { LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import type { SeatStatus } from "@/lib/capacity";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** A guest's seat badge (F5): a status only — Open / Few seats left / Full, never a number. */
export async function seatBadge(seats: SeatStatus): Promise<ClassCardBadge> {
  const t = await getTranslations("Explore.seats");
  if (seats === "full") return { variant: "neutral", label: t("full") };
  if (seats === "few") return { variant: "warning", label: t("few") };
  return { variant: "info", label: t("open") };
}

/**
 * The Enrol / Request to join slot on a public card or class page (F5).
 * Signed out, it is a link to sign in with `?next=` set to `returnPath` (a
 * locale-less path — login and sign-up return there through `safeNextPath`).
 * Signed in, it is the existing Discover `ReserveButton` — the same
 * `reserveOrEnroll` path and the same messages. An instant class that is full
 * offers nothing, like Discover; a class that needs approval can still be
 * requested.
 */
export async function EnrolAction({
  signedIn,
  centerId,
  classId,
  requiresConfirmation,
  seats,
  returnPath,
}: {
  signedIn: boolean;
  centerId: string;
  classId: string;
  requiresConfirmation: boolean;
  seats: SeatStatus;
  returnPath: string;
}) {
  const t = await getTranslations("StudentDiscover.card");

  if (!requiresConfirmation && seats === "full") {
    return (
      <Badge variant="neutral" className="w-full justify-center py-2">
        {t("full")}
      </Badge>
    );
  }

  if (signedIn) {
    return <ReserveButton centerId={centerId} classGroupId={classId} requiresConfirmation={requiresConfirmation} />;
  }

  return (
    <LinkButton
      href={`${ROUTES.login}?next=${encodeURIComponent(returnPath)}`}
      variant={requiresConfirmation ? "outline" : "default"}
      className={cn(
        "w-full",
        requiresConfirmation && "border-brand/50 text-brand hover:border-brand hover:bg-brand/10 hover:text-brand",
      )}
    >
      {requiresConfirmation ? t("requestToJoin") : t("enroll")}
    </LinkButton>
  );
}
