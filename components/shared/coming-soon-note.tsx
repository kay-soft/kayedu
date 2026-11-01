import { Hourglass } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * What an image control shows while `MEDIA_UPLOADS_ENABLED` is off (U9): the
 * control is replaced, not disabled, and nothing can be sent or stored.
 */
export function ComingSoonNote() {
  const t = useTranslations("Media");
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-subtle p-3 text-sm text-text-secondary">
      <Hourglass className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
      <p className="min-w-0">
        <span className="font-medium text-text-primary">{t("comingSoon")}</span>
        {" — "}
        {t("comingSoonHint")}
      </p>
    </div>
  );
}
