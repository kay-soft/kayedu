import type { ReactNode } from "react";

import { teacherShell } from "@/app/[locale]/(teacher)/teacher-shell";
import { AppShell } from "@/components/shell/app-shell";

/** The teacher portal — gate and shell data in `teacherShell()`, shared with Account settings (F2). */
export default async function TeacherLayout({
  children,
}: {
  children: ReactNode;
}) {
  const frame = await teacherShell();
  return (
    <AppShell {...frame.props}>
      {frame.lead}
      {frame.replace ?? children}
    </AppShell>
  );
}
