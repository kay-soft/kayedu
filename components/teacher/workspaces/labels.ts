import { catalogLabel } from "@/lib/catalog";
import type { CatalogPickerData } from "@/lib/catalog-picker";
import { buildCatalogPicker } from "@/lib/catalog-picker";
import { formatTimeRange } from "@/lib/format";

type Named = { nameAr: string; nameEn: string } | null;

/** A workspace class's name: subject · grade (a workspace has no name overrides), or the fallback. */
export function workspaceClassLabel(locale: string, row: { subject: Named; grade: Named }, fallback: string): string {
  const parts = [row.subject, row.grade].filter((entry): entry is NonNullable<Named> => entry !== null);
  return parts.length > 0 ? parts.map((entry) => catalogLabel(locale, entry)).join(" · ") : fallback;
}

/** "Sat 4:00–6:00 PM · Tue 5:00–7:00 PM" — a class's weekly slots in one line. */
export function weeklySlotsLine(
  locale: string,
  dayNames: string[],
  slots: { dayOfWeek: number; startTime: string; endTime: string }[],
): string {
  return slots.map((slot) => `${dayNames[slot.dayOfWeek] ?? ""} ${formatTimeRange(slot.startTime, slot.endTime, locale)}`).join(" · ");
}

type CatalogRow = { id: string; nameAr: string; nameEn: string };

/**
 * The workspace's catalogue picker (D-W38 item 7): every active global entry,
 * each subject under the grades it links to — a workspace has no picks. A
 * class's current entries stay selectable when the platform deactivated them.
 */
export function workspaceCatalogPicker(
  locale: string,
  rows: {
    systems: (CatalogRow & { active: boolean })[];
    grades: (CatalogRow & { active: boolean; educationSystemId: string | null })[];
    subjects: (CatalogRow & { active: boolean; gradeIds: string[] })[];
  },
  inactiveLabel: (name: string) => string,
  current?: { educationSystemId?: string | null; gradeId?: string | null; subjectId?: string | null } | null,
): CatalogPickerData {
  const byLabel = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const pick = <T extends CatalogRow & { active: boolean }>(row: T) => ({
    ...row,
    name: catalogLabel(locale, row),
    active: true,
    catalogActive: row.active,
  });
  return buildCatalogPicker(
    {
      systems: rows.systems.map(pick).sort(byLabel),
      grades: rows.grades.map(pick).sort(byLabel),
      subjects: rows.subjects.map(pick).sort(byLabel),
    },
    inactiveLabel,
    current,
  );
}
