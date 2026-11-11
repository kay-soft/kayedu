"use client";

import { useTranslations } from "next-intl";

/**
 * One translator for a workspace action's error key (W8a): the
 * workspace-only refusals (`Workspaces.errors`), then the class rules the
 * engine shares with branches (`Classes.errors`), then the session rules
 * (`Sessions.errors`), so a reused engine refusal reads exactly as it does at
 * a branch. Anything unknown is the generic line, never a raw key.
 */
export function useWorkspaceMessage() {
  const tWorkspace = useTranslations("Workspaces.errors");
  const tClasses = useTranslations("Classes.errors");
  const tSessions = useTranslations("Sessions.errors");
  return (key: string | undefined, values?: Record<string, number>): string | undefined => {
    if (!key) return undefined;
    if (tWorkspace.has(key)) return tWorkspace(key, values);
    if (tClasses.has(key)) return tClasses(key);
    if (tSessions.has(key)) return tSessions(key);
    return tWorkspace("generic");
  };
}
