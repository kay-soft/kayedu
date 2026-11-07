import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { PLATFORM_BRAND, type ShellFrame } from "@/components/shell/from-context";
import { shellExperiences } from "@/components/shell/experience-switcher-data";
import { assistantExperienceKey } from "@/lib/auth/experiences";
import { getAssistantSession } from "@/lib/auth/assistant-context";
import { fullName } from "@/lib/identity";
import { personInitials } from "@/lib/initials";
import { unreadNotificationCount } from "@/lib/notifications/reach";
import { ACCOUNT_HUB_HINT, ROUTES } from "@/lib/routes";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The assistant experience's shell (W7a, D-W36, docs/04 §11.36): one per
 * teacher the account assists, under the platform brand — no branch, no
 * branch switcher, one nav item (Home). Role gate: an **effective** link for
 * the route's teacher (`getAssistantSession`); anything else is not-found.
 * Account settings and the inbox open from here in the hub shell
 * (`ACCOUNT_HUB_HINT`): their frame would need this route's teacher.
 */
export async function assistantShell(teacherUserId: string): Promise<ShellFrame> {
  const session = await getAssistantSession(teacherUserId);
  if (!session) notFound();

  const [defaultCollapsed, unreadNotifications, experiences] = await Promise.all([
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
    // W1: the bell's count.
    unreadNotificationCount(session.user.id),
    // W5: the role switcher, this teacher's entry current.
    shellExperiences(session.user.id, assistantExperienceKey(teacherUserId)),
  ]);

  return {
    props: {
      experience: ACCOUNT_HUB_HINT,
      nav: [{ href: ROUTES.assistantHome(teacherUserId), labelKey: "home", icon: "dashboard" }],
      brand: PLATFORM_BRAND,
      user: {
        name: fullName(session.user),
        email: session.user.email,
        initials: personInitials(session.user.firstName, session.user.lastName),
        roleKey: "ASSISTANT",
      },
      experiences,
      defaultCollapsed,
      unreadNotifications,
    },
  };
}
