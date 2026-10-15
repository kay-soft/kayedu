"use client";

import { useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";
import type { ClassActionState } from "@/lib/validation/classes";

/**
 * What a class write did to the class's sessions (R4) — created, removed,
 * moved to the new teacher/rooms, cancelled — and, separately and in amber,
 * how many upcoming sessions were **kept** because they already carry
 * records or custom changes ("3 upcoming sessions were kept…"). Shown under
 * the class form, the schedule builder, the activate/deactivate control and
 * the holiday calendar after a save; the class page lists the kept ones.
 * SYS: a price edit adds how many open sessions took the new price and, in
 * amber, how many kept their old one (they already hold a payment).
 */
export function SessionSyncNotice({ sessions }: { sessions?: ClassActionState["sessions"] }) {
  const t = useTranslations("Classes.sessionsSync");
  if (!sessions) return null;

  const parts = [
    sessions.created > 0 ? t("created", { count: sessions.created }) : null,
    sessions.deleted > 0 ? t("deleted", { count: sessions.deleted }) : null,
    sessions.updated > 0 ? t("updated", { count: sessions.updated }) : null,
    sessions.cancelled ? t("cancelled", { count: sessions.cancelled }) : null,
    sessions.repriced ? t("repriced", { count: sessions.repriced }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="flex flex-col gap-2">
      <FormMessage tone="success">{parts.length > 0 ? parts.join(" · ") : t("unchanged")}</FormMessage>
      {sessions.kept > 0 ? (
        <FormMessage tone="warning">{t("kept", { count: sessions.kept })}</FormMessage>
      ) : null}
      {sessions.priceKept ? (
        <FormMessage tone="warning">{t("priceKept", { count: sessions.priceKept })}</FormMessage>
      ) : null}
    </div>
  );
}
