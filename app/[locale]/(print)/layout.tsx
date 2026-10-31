import type { ReactNode } from "react";
import { getLocale } from "next-intl/server";

import { isCenterStaffRole } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserCenterRelations } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * The print experience — the same role gate as `(center)`/`(teacher)`, but
 * without the app shell, because a sidebar has no business on a printed page.
 *
 * Route groups add no URL segment, so these pages still live under the
 * record they belong to (`/students/[id]/card`, `/teacher/sessions/[id]/print`);
 * they simply render outside the ERP/portal chrome. This layout only checks
 * that the user has *some* print-worthy experience — a staff or TEACHER role
 * at some branch; each page still resolves its own context (a centre page's
 * `getTenantContext("center")`, the teacher sheet's `getTeacherScope()`, U7)
 * and permission check (docs/02 §7), exactly like the M3 card/paper pages
 * already do. U7: no active branch is resolved here — a teacher at several
 * branches has none, and must still reach their own session's sheet.
 */
export default async function PrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  const locale = await getLocale();
  const user = await getCurrentUser();
  if (!user) redirect({ href: ROUTES.login, locale });
  const relations = await getUserCenterRelations(user!.id);
  const printable = relations.some((relation) =>
    relation.roles.some((role) => role === "TEACHER" || isCenterStaffRole(role)),
  );
  if (!printable) redirect({ href: "/", locale });

  return (
    <div className="min-h-dvh bg-canvas text-text-primary print:min-h-0 print:bg-white">
      {children}
    </div>
  );
}
