import type { ReactNode } from "react";

import { requireExperience } from "@/lib/auth/tenant";

/**
 * The print experience — the same center role gate as `(center)`, but without
 * the app shell, because a sidebar has no business on a printed page.
 *
 * Route groups add no URL segment, so these pages still live under the student
 * they belong to (`/students/[id]/card`, `/students/[id]/paper`); they simply
 * render outside the ERP chrome.
 */
export default async function PrintLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireExperience("center");

  return (
    <div className="min-h-dvh bg-canvas text-text-primary print:bg-white">
      {children}
    </div>
  );
}
