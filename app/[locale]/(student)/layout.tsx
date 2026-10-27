import type { ReactNode } from "react";

import { studentShell } from "@/app/[locale]/(student)/student-shell";
import { AppShell } from "@/components/shell/app-shell";

/**
 * The student portal — gate and shell data in `studentShell()`, shared with
 * Account settings (F2). `replace` is the M18 completion gate: the form
 * stands in for whichever page was asked for.
 */
export default async function StudentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const frame = await studentShell();
  return (
    <AppShell {...frame.props}>
      {frame.lead}
      {frame.replace ?? children}
    </AppShell>
  );
}
