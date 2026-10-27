import type { ReactNode } from "react";

import { adminShell } from "@/app/[locale]/(admin)/admin-shell";
import { AppShell } from "@/components/shell/app-shell";

/** The platform admin — gate and shell data in `adminShell()`, shared with Account settings (F2). */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const frame = await adminShell();
  return (
    <AppShell {...frame.props}>
      {frame.lead}
      {frame.replace ?? children}
    </AppShell>
  );
}
