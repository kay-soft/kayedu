import type { ReactNode } from "react";
import { getLocale } from "next-intl/server";

import { getTenantContext, hasExperience } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { homePathForRole } from "@/lib/routes";

/**
 * The print experience — the same role gate as `(center)`/`(teacher)`, but
 * without the app shell, because a sidebar has no business on a printed page.
 *
 * Route groups add no URL segment, so these pages still live under the
 * record they belong to (`/students/[id]/card`, `/teacher/sessions/[id]/print`);
 * they simply render outside the ERP/portal chrome. This layout only checks
 * that the user has *some* print-worthy experience; each page still resolves
 * its own `getTenantContext("center" | "teacher")` and permission check
 * (docs/02 §7), exactly like the M3 card/paper pages already do.
 */
export default async function PrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = await getTenantContext();
  if (!hasExperience(ctx, "center") && !hasExperience(ctx, "teacher")) {
    redirect({ href: homePathForRole(ctx.role), locale: await getLocale() });
  }

  return (
    <div className="min-h-dvh bg-canvas text-text-primary print:min-h-0 print:bg-white">
      {children}
    </div>
  );
}
