import type { ReactNode } from "react";

import { centerShell } from "@/app/[locale]/(center)/center-shell";
import { AppShell } from "@/components/shell/app-shell";

/**
 * The center ERP: staff roles only — the gate and the shell's data are
 * `centerShell()` (center-shell.tsx), shared with Account settings (F2).
 */
export default async function CenterLayout({
  children,
}: {
  children: ReactNode;
}) {
  const frame = await centerShell();
  return (
    <AppShell {...frame.props}>
      {frame.lead}
      {frame.replace ?? children}
    </AppShell>
  );
}
