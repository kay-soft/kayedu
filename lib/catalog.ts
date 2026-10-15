/**
 * Pure academic-catalog helpers (M13, docs/01-data-model.md "Academic
 * catalog layer"; R8 made centre renames bilingual). No Prisma import — this
 * is the resolution rule, not the query, so it can be exercised by
 * `npm run check:catalog` outside the Next.js runtime (same reasoning as
 * lib/money.ts and lib/scheduling.ts).
 *
 * Every catalog entry carries `nameAr` + `nameEn`. A centre may rename its own
 * picked entry in each language (`CenterCatalogSelection.displayNameAr` /
 * `displayNameEn`). `catalogLabel` is the ONE place that resolution happens,
 * so a select list, the settings/catalog screen, a class card and a receipt
 * never each reinvent it — and no reader touches the override columns
 * directly.
 *
 * The rule (docs/02-architecture.md §8 "Catalog label resolution"): in the
 * Arabic UI, `displayNameAr` else the canonical `nameAr`; in the English UI,
 * `displayNameEn` else the canonical `nameEn`. An Arabic override never shows
 * in the English UI and vice versa.
 */

export type CatalogLabelSource = {
  nameAr: string;
  nameEn: string;
};

/** A centre's own per-language rename of one picked entry. Null/blank = use the canonical name. */
export type CatalogNameOverride = {
  displayNameAr: string | null;
  displayNameEn: string | null;
};

/** The columns every live read path selects from a centre's selection row — and nothing else. */
export const CATALOG_OVERRIDE_SELECT = { displayNameAr: true, displayNameEn: true } as const;

function filled(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The label for `entry` in `locale`: the centre's override in that language
 * if it set one, else the canonical name in that language. Only if the
 * canonical name itself is blank (it cannot be for an entry created since R8,
 * which requires both) does it fall back to the other language's *canonical*
 * name — never to the other language's override.
 */
export function catalogLabel(
  locale: string,
  entry: CatalogLabelSource,
  override?: Partial<CatalogNameOverride> | null,
): string {
  const ar = locale === "ar";
  const own = ar ? override?.displayNameAr : override?.displayNameEn;
  if (filled(own)) return own.trim();
  const primary = ar ? entry.nameAr : entry.nameEn;
  const fallback = ar ? entry.nameEn : entry.nameAr;
  return filled(primary) ? primary : fallback;
}

export type CatalogEntryKind = "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT";

/**
 * The shape a `subject`/`grade`/`educationSystem` relation has once its
 * `select`/`include` carries the nested, centre-scoped
 * `selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 }`
 * every live read path adds. There is no schema field anywhere that freezes a
 * catalog entry's name (unlike `priceSnapshot` for money) — every one of these
 * is a live join, so a centre's own rename belongs on every one of them, not
 * just the settings screen and the class form.
 */
export type CatalogWithSelection = CatalogLabelSource & {
  selections?: CatalogNameOverride[];
};

/** `catalogLabel`, but pulling the override out of a nested `selections` include. Null-safe. */
export function catalogLabelWithSelection(
  locale: string,
  entry: CatalogWithSelection | null | undefined,
): string | null {
  if (!entry) return null;
  return catalogLabel(locale, entry, entry.selections?.[0] ?? null);
}

// ── Names: one normalizer for validation, duplicate-matching and display ────

/** Every catalog name, in both languages, is 1..80 characters after trimming. */
export const CATALOG_NAME_MAX = 80;

/** Trim and collapse inner whitespace; null if that leaves nothing. */
export function normalizeCatalogName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * The key two names are compared by when refusing duplicates within one
 * parent: normalized, then lower-cased (so "Maths" and "maths" clash; Arabic
 * has no case, so an Arabic name clashes only with itself).
 */
export function catalogNameKey(raw: string): string {
  return (normalizeCatalogName(raw) ?? "").toLowerCase();
}

// ── Arabic-script detection (the R8 migration's backfill rule) ──────────────

/**
 * Arabic, Arabic Supplement, Arabic Extended-A, Presentation Forms-A and -B.
 * The R8 migration (`20261016090000_r8_catalog_admin_bilingual_names`) uses
 * this exact character class in SQL to split the old single `displayName`
 * into `displayNameAr` / `displayNameEn`; `npm run check:catalog` asserts the
 * SQL and this function agree on a set of samples.
 */
const ARABIC_SCRIPT_RANGES: readonly (readonly [number, number])[] = [
  [0x0600, 0x06ff], // Arabic
  [0x0750, 0x077f], // Arabic Supplement
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
];

export function containsArabicScript(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (ARABIC_SCRIPT_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) {
      return true;
    }
  }
  return false;
}

/**
 * The migration's backfill, as a pure function: which language field an old
 * free-text name (the dropped `displayName` column) lands in. Blank = nowhere.
 */
export function backfillLegacyName(legacyName: string | null): CatalogNameOverride {
  const trimmed = legacyName?.trim() ?? "";
  if (trimmed === "") return { displayNameAr: null, displayNameEn: null };
  return containsArabicScript(trimmed)
    ? { displayNameAr: trimmed, displayNameEn: null }
    : { displayNameAr: null, displayNameEn: trimmed };
}
