import type { PublicClass } from "@/lib/db/public-catalog";
import { CalendarCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LinkButton } from "@/components/shared/link-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROUTES } from "@/lib/routes";

/**
 * "Attend one session" on a public class page (F6). Sessions, their seats and
 * the student's own bookings are read only when signed in (the public catalog
 * reads no session), so this links to the signed-in class page — through
 * sign-in for a guest, who comes back there (`?next=`). Nothing when the
 * class does not take single-session bookings.
 */
export async function SessionBookingLink({
  mode,
  signedIn,
  centerId,
  classId,
}: {
  mode: PublicClass["sessionBookingMode"];
  signedIn: boolean;
  centerId: string;
  classId: string;
}) {
  if (mode === "OFF") return null;
  const t = await getTranslations("Explore.sessions");
  const target = ROUTES.studentDiscoverClass(centerId, classId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{mode === "APPROVAL" ? t("approvalNote") : t("instantNote")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LinkButton
          href={signedIn ? target : `${ROUTES.login}?next=${encodeURIComponent(target)}`}
          variant="outline"
          className="w-full sm:w-fit"
        >
          <CalendarCheck className="size-4" aria-hidden />
          {signedIn ? t("see") : t("signIn")}
        </LinkButton>
      </CardContent>
    </Card>
  );
}
