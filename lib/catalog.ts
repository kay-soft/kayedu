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

/**
 * The shape a `subject`/`grade`/`educationSystem` relation has once its
 * `select`/`include` carries the nested, centre-scoped
 * `selections: { where: { centerId }, select: { displayName: true }, take: 1 }`
 * every live read path below adds. There is no schema field anywhere that
 * freezes a catalog entry's name (unlike `priceSnapshot` for money) — every
 * one of these is a live join, so a centre's own rename belongs on every one
 * of them, not just the settings screen and the class form.
 */
export type CatalogWithSelection = CatalogLabelSource & {
  selections?: { displayName: string | null }[];
};

/** `catalogLabel`, but pulling the override out of a nested `selections` include. Null-safe. */
export function catalogLabelWithSelection(
  locale: string,
  entry: CatalogWithSelection | null | undefined,
): string | null {
  if (!entry) return null;
  return catalogLabel(locale, entry, entry.selections?.[0]?.displayName ?? null);
}
