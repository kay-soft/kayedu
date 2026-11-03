import { adminShell } from "@/app/[locale]/(admin)/admin-shell";
import { centerShell } from "@/app/[locale]/(center)/center-shell";
import { parentShell } from "@/app/[locale]/(parent)/parent-shell";
import { studentShell } from "@/app/[locale]/(student)/student-shell";
import { teacherShell } from "@/app/[locale]/(teacher)/teacher-shell";
import type { ShellFrame } from "@/components/shell/from-context";
import type { ShellExperience } from "@/lib/routes";

/**
 * The experience's own shell, for a page every experience opens inside its
 * own shell (`?from=`): Account settings (F2) and the notification inbox
 * (W1) — the same frame its route group's layout renders, one selection,
 * never a copy. Not the student portal itself: no completion gate, no rating
 * pop-up, so only `props` is used.
 */
export function shellFrameFor(experience: ShellExperience): Promise<ShellFrame> {
  switch (experience) {
    case "center":
      return centerShell();
    case "teacher":
      return teacherShell();
    case "student":
      return studentShell({ interruptions: false });
    case "parent":
      return parentShell();
    case "admin":
      return adminShell();
  }
}
