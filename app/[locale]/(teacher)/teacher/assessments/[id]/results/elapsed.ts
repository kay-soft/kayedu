import { getLocale, getTranslations } from "next-intl/server";

import { elapsedParts, formatNumber } from "@/lib/format";

/** "1 h 05 min", "12 min 30 s", "45 s" in the reader's locale and digits. */
export async function elapsedFormatter(): Promise<(ms: number) => string> {
  const t = await getTranslations("TeacherAssessments.results.duration");
  const locale = await getLocale();
  return (ms) => {
    const { hours, minutes, seconds } = elapsedParts(ms);
    const n = (value: number) => formatNumber(value, locale);
    if (hours > 0) return t("hours", { hours: n(hours), minutes: n(minutes) });
    if (minutes > 0) return t("minutes", { minutes: n(minutes), seconds: n(seconds) });
    return t("seconds", { seconds: n(seconds) });
  };
}
