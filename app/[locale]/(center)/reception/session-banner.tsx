import { Radio } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AnchorButton, LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import { ROUTES } from "@/lib/routes";

/**
 * The sticky "Attending: …" banner of session mode (R7) — sticks under the
 * 64px app bar so the selected session is always in view while students are
 * being scanned. "Change session" jumps to the cards below (the URL keeps the
 * current session until another is started); "Exit" returns to the plain desk.
 *
 * DES (docs/04 §14.5): a mode, not one more card — a brand-tinted surface with
 * a brand start edge, the session name at 16px / 600, a Live badge and the
 * running count. Only the summary is the live region (the buttons are not).
 */
export async function SessionBanner({
  label,
  detail,
  live,
  checkedIn,
}: {
  /** The session's name. */
  label: string;
  /** Teacher · time · rooms, already formatted. */
  detail: string;
  live: boolean;
  /** Already formatted. */
  checkedIn: string;
}) {
  const t = await getTranslations("Reception");

  return (
    <div className="sticky top-16 z-10 flex flex-col gap-3 rounded-xl border border-brand/40 border-s-4 border-s-brand bg-brand/5 p-3 shadow-card backdrop-blur-sm md:flex-row md:items-center md:justify-between md:p-4">
      <div role="status" className="flex min-w-0 items-start gap-3">
        <Radio className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs font-medium text-brand">{t("sessionMode.attending")}</p>
          <p className="text-base font-semibold text-pretty text-text-primary">{label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
            <span>{detail}</span>
            {live ? (
              <Badge variant="success" pulse>
                {t("status.LIVE")}
              </Badge>
            ) : null}
            <span className="font-medium tabular-nums text-text-primary">
              {t("sessionMode.checkedInCount", { count: checkedIn })}
            </span>
          </p>
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 md:flex">
        <AnchorButton href="#today-sessions" className="whitespace-nowrap">
          {t("sessionMode.change")}
        </AnchorButton>
        <LinkButton href={ROUTES.centerReception} className="whitespace-nowrap">
          {t("sessionMode.exit")}
        </LinkButton>
      </div>
    </div>
  );
}
