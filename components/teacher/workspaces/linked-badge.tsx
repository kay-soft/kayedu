import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

/**
 * "Linked" / "Not linked" (W8b, D-W27, D-W39 item 7; docs/04 §11.37) — the
 * one thing a teacher is told about a workspace student's account. Text,
 * never colour alone; a pending invitation is never shown (it would say an
 * account matched).
 */
export function LinkedBadge({ linked }: { linked: boolean }) {
  const t = useTranslations("WorkspaceStudents.row");
  return <Badge variant={linked ? "success" : "neutral"}>{linked ? t("linked") : t("notLinked")}</Badge>;
}
