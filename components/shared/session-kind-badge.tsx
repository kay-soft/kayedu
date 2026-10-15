import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { SessionKind } from "@/lib/session-label";

/**
 * Says what kind of session a row is (R5, docs/04-design-system.md §11.14):
 * a **One-time** session (no class — `brand`, it stands on its own) or an
 * **Extra session** added by hand to a class (`neutral`). A session the
 * class's own schedule made shows nothing — that is the normal case.
 * Never a semantic status colour: those mean present/late/absent/upcoming.
 */
export function SessionKindBadge({ kind, className }: { kind: SessionKind; className?: string }) {
  const t = useTranslations("Sessions.kind");
  if (kind === "class") return null;
  return (
    <Badge variant={kind === "oneOff" ? "brand" : "neutral"} className={className}>
      {kind === "oneOff" ? t("oneOff") : t("extra")}
    </Badge>
  );
}
