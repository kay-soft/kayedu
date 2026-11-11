import type { ReactNode } from "react";

import { assistantShell } from "@/app/[locale]/(assistant)/assistant-shell";
import { AppShell } from "@/components/shell/app-shell";

/** The assistant experience — gate and shell data in `assistantShell()` (W7a). */
export default async function AssistantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const frame = await assistantShell(teacherId);
  return <AppShell {...frame.props}>{children}</AppShell>;
}
