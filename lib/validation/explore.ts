/**
 * The Explore query string (F5): `view`, `subject`, `grade`, `day`, `page`.
 * Nothing here is trusted — an id is only ever a value in a scoped `where`
 * (lib/db/public-catalog.ts), and anything malformed is simply dropped.
 */

export const EXPLORE_VIEWS = ["branches", "classes"] as const;
export type ExploreView = (typeof EXPLORE_VIEWS)[number];

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function id(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function parseExploreFilters(raw: Record<string, string | undefined>) {
  const day = raw.day?.trim();
  const dayNumber = day && /^[0-6]$/.test(day) ? Number(day) : undefined;
  return { subjectId: id(raw.subject), gradeId: id(raw.grade), day: dayNumber };
}

/** Any class filter means the class search; otherwise `view` decides, branches by default. */
export function parseExploreView(
  raw: Record<string, string | undefined>,
  filters: ReturnType<typeof parseExploreFilters>,
): ExploreView {
  if (raw.view === "classes" || raw.view === "branches") return raw.view;
  return filters.subjectId || filters.gradeId || filters.day !== undefined ? "classes" : "branches";
}
