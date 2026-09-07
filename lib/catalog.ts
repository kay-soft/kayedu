/**
 * Pure academic-catalog helpers (M13, docs/01-data-model.md "Academic
 * catalog layer"). No Prisma import — this is the resolution rule, not the
 * query, so it can be exercised by `npm run check:catalog` outside the
 * Next.js runtime (same reasoning as lib/money.ts and lib/scheduling.ts).
 *
 * Every catalog entry carries `nameAr` + `nameEn`. A centre may override the
 * display name for its own picked entry (`CenterCatalogSelection.displayName`)
 * — this is the ONE place that resolution happens, so a select list, the
 * settings/catalog screen and the admin review queue never each reinvent it.
 */

export type CatalogLabelSource = {
  nameAr: string;
  nameEn: string;
};

/** `displayName` wins when the centre has set one; otherwise the locale's own name. */
export function catalogLabel(
  locale: string,
  entry: CatalogLabelSource,
  displayName?: string | null,
): string {
  if (displayName && displayName.trim().length > 0) return displayName;
  const primary = locale === "ar" ? entry.nameAr : entry.nameEn;
  const fallback = locale === "ar" ? entry.nameEn : entry.nameAr;
  return primary && primary.trim().length > 0 ? primary : fallback;
}

export type CatalogEntryKind = "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT";
