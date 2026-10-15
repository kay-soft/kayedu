import { SearchX } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LinkButton } from "@/components/shared/link-button";

/**
 * What a route group's `not-found.tsx` renders (DES, docs/04 §12): a missing
 * record — an unknown student id, a session from another branch — shown
 * **inside** the experience's own shell, with a way back to that experience's
 * home. It used to render the global 404, which dropped the user out of the
 * app (no sidebar, no branch, no language) with a link to `/`.
 */
export async function RecordNotFound({ homeHref }: { homeHref: string }) {
  const t = await getTranslations("Shared.notFound");

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-surface-hover text-text-secondary"
      >
        <SearchX className="size-6" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <h1 className="text-xl font-semibold text-balance text-text-primary">{t("recordTitle")}</h1>
        <p className="text-sm text-pretty text-text-secondary">{t("recordDescription")}</p>
      </div>
      <LinkButton href={homeHref} variant="default">
        {t("home")}
      </LinkButton>
    </div>
  );
}
