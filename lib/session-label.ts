// Relative import on purpose: the gate scripts (`npm run check:one-off-sessions`)
// exercise this module directly, outside the Next.js runtime — the same
// reasoning as lib/catalog.ts and lib/money.ts. No Prisma import: this is the
// naming rule, not a query.
import { catalogLabelWithSelection, type CatalogWithSelection } from "./catalog.ts";

/**
 * **The single owner of "what is this session called"** (R5). Since R5 a
 * session may belong to no class — a one-time session — so nothing may read
 * `session.classGroup.subject` directly any more: a class session takes its
 * class's subject and grade, a one-time session its own `title` (plus its own
 * optional subject and grade). Every list, receipt, print route, portal and
 * history row resolves its label through here, and a session with neither a
 * class nor a title renders "—" rather than throwing or printing "undefined".
 *
 * Catalog labels are live joins (docs/01 "Academic catalog layer"): pass the
 * `subject`/`grade` relations with the centre-scoped `selections` lookup
 * (`sessionLabelSelect(centerId)` below) and the centre's own display name
 * wins; pass them without it and the canonical name is used — what the
 * conflict list (`lib/db/slot-conflicts.ts`) deliberately does.
 */

type CatalogRef = CatalogWithSelection | null | undefined;

export type SessionLabelSource = {
  title?: string | null;
  subject?: CatalogRef;
  grade?: CatalogRef;
  classGroup?: { subject?: CatalogRef; grade?: CatalogRef } | null;
};

/** What kind of session this is — decides the badge a list shows. */
export type SessionKind = "class" | "extra" | "oneOff";

export function sessionKind(session: {
  classGroupId?: string | null;
  classGroup?: unknown;
  isManual?: boolean | null;
}): SessionKind {
  const hasClass =
    session.classGroupId !== undefined ? session.classGroupId !== null : Boolean(session.classGroup);
  if (!hasClass) return "oneOff";
  return session.isManual ? "extra" : "class";
}

/** "Math · Grade 10" for a class session; "Revision day · Physics" for a one-time one. */
export function sessionDisplayName(locale: string, session: SessionLabelSource): string {
  const parts = session.classGroup
    ? [
        catalogLabelWithSelection(locale, session.classGroup.subject),
        catalogLabelWithSelection(locale, session.classGroup.grade),
      ]
    : [
        session.title?.trim() || null,
        catalogLabelWithSelection(locale, session.subject),
        catalogLabelWithSelection(locale, session.grade),
      ];
  return parts.filter(Boolean).join(" · ") || "—";
}

/**
 * The same name split in two, for cards that show a subject line and a grade
 * line (the student's and parent's schedule/history): a class session's
 * subject and grade; a one-time session's title (plus its own subject) and
 * its own grade.
 */
export function sessionLabelParts(
  locale: string,
  session: SessionLabelSource,
): { subjectName: string | null; gradeName: string | null } {
  if (session.classGroup) {
    return {
      subjectName: catalogLabelWithSelection(locale, session.classGroup.subject),
      gradeName: catalogLabelWithSelection(locale, session.classGroup.grade),
    };
  }
  return {
    subjectName:
      [session.title?.trim() || null, catalogLabelWithSelection(locale, session.subject)]
        .filter(Boolean)
        .join(" · ") || null,
    gradeName: catalogLabelWithSelection(locale, session.grade),
  };
}

/** The subject/grade catalog ids a session is about — its class's, or its own (one-time). */
export function sessionCatalogIds(session: {
  subjectId?: string | null;
  gradeId?: string | null;
  classGroup?: { subjectId?: string | null; gradeId?: string | null } | null;
}): { subjectId: string | null; gradeId: string | null } {
  if (session.classGroup) {
    return {
      subjectId: session.classGroup.subjectId ?? null,
      gradeId: session.classGroup.gradeId ?? null,
    };
  }
  return { subjectId: session.subjectId ?? null, gradeId: session.gradeId ?? null };
}

/**
 * The Prisma `select` fragment every reader adds to label a session: the
 * session's own title/subject/grade and its class's subject/grade, each
 * catalog entry with this centre's display-name override. A plain object
 * (no Prisma import), spread into a `select`.
 */
export function sessionLabelSelect(centerId: string) {
  const catalog = {
    select: {
      nameAr: true,
      nameEn: true,
      selections: { where: { centerId }, select: { displayName: true }, take: 1 },
    },
  } as const;
  return {
    title: true,
    isManual: true,
    classGroupId: true,
    subject: catalog,
    grade: catalog,
    classGroup: { select: { subject: catalog, grade: catalog } },
  } as const;
}
