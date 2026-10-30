/**
 * The education system → grade → subject cascade every catalog picker and
 * filter shares (U3, docs/04-design-system.md §5 "Catalog pickers"). Pure — no
 * Prisma, no React — so the server builds the data once and the client narrows
 * it, and `npm run check:catalog` can exercise the rule outside Next.
 *
 * A subject exists once (U3) and links to the grades that teach it. In a
 * form a subject is offered only under a grade it links to; in a filter the
 * subject list narrows to the chosen grade's and, with no grade, lists every
 * subject once.
 */

export type CatalogOption = { value: string; label: string };
export type CatalogGradeOption = CatalogOption & { systemId: string | null };
export type CatalogSubjectOption = CatalogOption & { gradeIds: string[] };

export type CatalogPickerData = {
  systems: CatalogOption[];
  grades: CatalogGradeOption[];
  subjects: CatalogSubjectOption[];
};

/** A centre's pick, as `scoped(ctx).*.list()` returns it (the name already resolved). */
type PickRow = { id: string; name: string; active: boolean; catalogActive: boolean };

/** The grades a system narrows to; every grade when no system is chosen. */
export function gradesForSystem(grades: CatalogGradeOption[], systemId: string): CatalogGradeOption[] {
  return systemId ? grades.filter((grade) => grade.systemId === systemId) : grades;
}

/** The subjects linked to one grade; none when no grade is chosen (a form's subject waits for its grade). */
export function subjectsForGrade(subjects: CatalogSubjectOption[], gradeId: string): CatalogSubjectOption[] {
  return gradeId ? subjects.filter((subject) => subject.gradeIds.includes(gradeId)) : [];
}

/**
 * A filter's subject list: narrowed to the grade when one is chosen, else
 * every subject once. Never repeats — a subject is one row however many
 * grades it links to.
 */
export function filterSubjectsForGrade(subjects: CatalogSubjectOption[], gradeId: string): CatalogSubjectOption[] {
  return gradeId ? subjectsForGrade(subjects, gradeId) : subjects;
}

/**
 * The picker data for a centre form (class create/edit, one-time session,
 * teacher request). Offered = the centre's pick is active AND the platform has
 * not deactivated the entry (docs/00 §5.1 R8, rule 10 of U3). An existing
 * record's own values (`current`) stay selectable — labelled inactive when
 * they are — so it can be saved unchanged; its subject stays under its grade
 * even if that pair is no longer offered.
 */
export function buildCatalogPicker(
  rows: {
    systems: PickRow[];
    grades: (PickRow & { educationSystemId: string | null })[];
    subjects: (PickRow & { gradeIds: string[] })[];
  },
  inactiveLabel: (name: string) => string,
  current?: { educationSystemId?: string | null; gradeId?: string | null; subjectId?: string | null } | null,
): CatalogPickerData {
  const offered = (row: PickRow) => row.active && row.catalogActive;
  const label = (row: PickRow) => (offered(row) ? row.name : inactiveLabel(row.name));

  // Systems keep their pre-U3 rule: a platform-deactivated one is not offered;
  // a centre-deactivated one is, labelled (it only carries the default cut).
  const systems = rows.systems
    .filter((row) => row.catalogActive || row.id === current?.educationSystemId)
    .map((row) => ({
      value: row.id,
      label: row.active && row.catalogActive ? row.name : inactiveLabel(row.name),
    }));

  const grades = rows.grades
    .filter((row) => offered(row) || row.id === current?.gradeId)
    .map((row) => ({ value: row.id, label: label(row), systemId: row.educationSystemId }));
  const offeredGradeIds = new Set(rows.grades.filter(offered).map((row) => row.id));

  const subjects = rows.subjects
    .filter((row) => offered(row) || row.id === current?.subjectId)
    .map((row) => {
      const gradeIds = row.gradeIds.filter((gradeId) => offeredGradeIds.has(gradeId));
      if (row.id === current?.subjectId && current.gradeId && !gradeIds.includes(current.gradeId)) {
        gradeIds.push(current.gradeId);
      }
      return { value: row.id, label: label(row), gradeIds };
    })
    .filter((row) => row.gradeIds.length > 0 || row.value === current?.subjectId);

  return { systems, grades, subjects };
}

/**
 * The options for a centre's grade → subject FILTER: every pick, deactivated
 * ones included (history stays filterable), each subject once with its links.
 */
export function buildCatalogFilter(
  rows: {
    grades: (PickRow & { educationSystemId: string | null })[];
    subjects: (PickRow & { gradeIds: string[] })[];
  },
  inactiveLabel: (name: string) => string,
): { grades: CatalogGradeOption[]; subjects: CatalogSubjectOption[] } {
  const label = (row: PickRow) => (row.active ? row.name : inactiveLabel(row.name));
  return {
    grades: rows.grades.map((row) => ({ value: row.id, label: label(row), systemId: row.educationSystemId })),
    subjects: rows.subjects.map((row) => ({ value: row.id, label: label(row), gradeIds: row.gradeIds })),
  };
}
