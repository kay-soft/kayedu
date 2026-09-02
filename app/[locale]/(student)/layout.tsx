import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/app-shell";
import { shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireStudentUser, studentBrand } from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * Role gate: any signed-in `User` — not `requireExperience("student")`. A
 * brand-new sign-up has zero relations anywhere until they discover and
 * reserve/enroll in their first class, so this gate cannot require a
 * `StudentProfile` up front (see `requireStudentUser`'s doc comment,
 * `lib/auth/tenant.ts`).
 */
export default async function StudentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireStudentUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );

  return (
    <AppShell
      nav={navForExperience("student", "STUDENT")}
      brand={studentBrand(session)}
      user={shellUser(session.user, "STUDENT")}
      canSwitchCenter={session.relations.length > 1}
      defaultCollapsed={defaultCollapsed}
    >
      {children}
    </AppShell>
  );
}
