import { catalogLabel, type CatalogLabelSource } from "./catalog.ts";

/**
 * The two-step grade picker's data (F4): education system → grade, from the
 * platform catalog (the *account* grade is not a branch's pick, so no branch
 * rename applies — `catalogLabel` with the canonical bilingual names). Pure,
 * so a gate can run it. Only active grades are offered, plus the student's
 * current one when the platform has since deactivated it (kept, never newly
 * chosen — R8).
 */

export type GradeSource = CatalogLabelSource & {
  id: string;
  active: boolean;
  educationSystemId: string | null;
  educationSystem: (CatalogLabelSource & { id: string }) | null;
};

export type GradePickerData = {
  systems: { value: string; label: string }[];
  grades: { value: string; label: string; systemId: string }[];
  /** The system the current grade sits in ("" when unset), to open the picker on. */
  currentSystemId: string;
};

/** A grade the catalog files under no education system sits under this pseudo-system. */
export const NO_SYSTEM_ID = "none";

export function gradePickerData(
  locale: string,
  grades: GradeSource[],
  currentGradeId: string | null,
  labels: { noSystem: string; inactive: string },
): GradePickerData {
  const offered = grades.filter((grade) => grade.active || grade.id === currentGradeId);
  const systemOf = (grade: GradeSource) => grade.educationSystemId ?? NO_SYSTEM_ID;

  const systems = new Map<string, string>();
  for (const grade of offered) {
    if (!systems.has(systemOf(grade))) {
      systems.set(
        systemOf(grade),
        grade.educationSystem ? catalogLabel(locale, grade.educationSystem) : labels.noSystem,
      );
    }
  }

  const options = offered
    .map((grade) => ({
      value: grade.id,
      label: grade.active
        ? catalogLabel(locale, grade)
        : `${catalogLabel(locale, grade)} · ${labels.inactive}`,
      systemId: systemOf(grade),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));

  const current = grades.find((grade) => grade.id === currentGradeId);
  return {
    systems: [...systems.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, locale)),
    grades: options,
    currentSystemId: current ? systemOf(current) : "",
  };
}
