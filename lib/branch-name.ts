/**
 * A branch's name in the active locale (F5): the English name in the English
 * UI when the branch set one, otherwise its (Arabic, required) name. A branch
 * name is the branch's own label, like a catalog entry — not a person's name.
 */
export function branchName(
  locale: string,
  branch: { name: string; nameEn: string | null },
): string {
  const english = branch.nameEn?.trim();
  return locale === "en" && english ? english : branch.name;
}
