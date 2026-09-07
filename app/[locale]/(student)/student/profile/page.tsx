import { getLocale } from "next-intl/server";

import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * The `(student)` layout substitutes `ProfileCompletionForm` for `children`
 * on every route in this group while a profile is incomplete (M18, spec §4.3
 * item 4) — so this page's own content only ever renders once a profile is
 * already complete, at which point there's nothing left for this route to
 * do but send the student back to their schedule.
 */
export default async function StudentProfilePage() {
  const locale = await getLocale();
  redirect({ href: ROUTES.studentSchedule, locale });
}
