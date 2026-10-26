import type { ReactNode } from "react";

import { parentShell } from "@/app/[locale]/(parent)/parent-shell";
import { AppShell } from "@/components/shell/app-shell";

/** The parent portal — gate and shell data in `parentShell()`, shared with Account settings (F2). */
export default async function ParentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const frame = await parentShell();
  return (
    <AppShell {...frame.props}>
      {frame.lead}
      {frame.replace ?? children}
    </AppShell>
  );
}
