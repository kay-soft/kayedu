import { Radio } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LinkButton } from "@/components/shared/link-button";
import { ROUTES } from "@/lib/routes";

/**
 * The sticky "Attending: …" banner of session mode (R7) — sticks under the
 * 64px app bar so the selected session is always in view while students are
 * being scanned. "Change session" jumps to the cards below (the URL keeps the
 * current session until another is started); "Exit" returns to the plain desk.
 */
export async function SessionBanner({ summary }: { summary: string }) {
  const t = await getTranslations("Reception");

  return (
    <div
      role="status"
      className="sticky top-16 z-10 flex flex-col gap-3 rounded-xl border border-brand/40 bg-surface p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-4"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
        <Radio className="size-4 shrink-0 text-brand" aria-hidden />
        <span className="min-w-0">
          {t("sessionMode.attending")} <span className="font-medium">{summary}</span>
        </span>
      </p>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <a
          href="#today-sessions"
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-text-primary transition-ui focus-ring hover:bg-surface-hover active:bg-surface-active"
        >
          {t("sessionMode.change")}
        </a>
        <LinkButton href={ROUTES.centerReception} className="w-full sm:w-auto">
          {t("sessionMode.exit")}
        </LinkButton>
      </div>
    </div>
  );
}
