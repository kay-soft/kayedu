/**
 * The rotating subject-accent palette (docs/04-design-system.md §2, §10):
 * "blue, green, purple, amber, rose — assigned per subject, consistent
 * app-wide." Deterministic on the subject *name* (not a stored id) so the
 * same subject reads the same color everywhere it appears, even though
 * `Subject` rows are center-local master data (docs/01-data-model.md §2) and
 * two centers' "Math" are two different rows.
 */
const ACCENTS = ["#2563eb", "#16a34a", "#7c3aed", "#f59e0b", "#e11d48"] as const;

export function subjectAccentColor(name: string | null | undefined): string {
  const key = (name ?? "").trim();
  if (!key) return ACCENTS[0];

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return ACCENTS[hash % ACCENTS.length];
}
