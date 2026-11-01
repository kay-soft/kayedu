/**
 * The global academic catalog for the demo (P1) — platform-owned, bilingual,
 * active. Written through `lib/db/catalog-admin.ts`'s `createCatalogEntry`, the
 * only code that may write a global row (it re-checks `isPlatformAdmin` and
 * audits each write), as the seeded platform admin.
 *
 * U3: a subject exists ONCE and links to every grade that teaches it
 * (`CatalogSubjectGrade`, any system) — "Mathematics" is one row linked to 14
 * grades, not 14 rows. The matrix below is the list of grades each subject
 * links to — sensible, not exhaustive.
 */
import type { CatalogGrade, CatalogSubject, PrismaClient } from "@prisma/client";
import { createCatalogEntry, updateCatalogEntry } from "../../lib/db/catalog-admin.ts";

export type SystemKey = "EG" | "US" | "IG";

type Named = { en: string; ar: string };

export const SYSTEMS: Record<SystemKey, Named & { defaultFixedCenterShare: number }> = {
  // Piastres: 30 / 40 / 50 EGP the centre takes per session by default.
  EG: { en: "Egyptian National", ar: "المنهج المصري", defaultFixedCenterShare: 3_000 },
  US: { en: "American", ar: "المنهج الأمريكي", defaultFixedCenterShare: 4_000 },
  IG: { en: "IGCSE", ar: "الشهادة الدولية (IGCSE)", defaultFixedCenterShare: 5_000 },
};

const ORDINAL_AR_M = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];

const GRADES: Record<SystemKey, Named[]> = {
  EG: [
    ...ORDINAL_AR_M.map((o, i) => ({ en: `Primary ${i + 1}`, ar: `الصف ${o} الابتدائي` })),
    ...ORDINAL_AR_M.slice(0, 3).map((o, i) => ({ en: `Preparatory ${i + 1}`, ar: `الصف ${o} الإعدادي` })),
    ...ORDINAL_AR_M.slice(0, 3).map((o, i) => ({ en: `Secondary ${i + 1}`, ar: `الصف ${o} الثانوي` })),
  ],
  US: [
    { en: "Grade 9", ar: "الصف التاسع" },
    { en: "Grade 10", ar: "الصف العاشر" },
    { en: "Grade 11", ar: "الصف الحادي عشر" },
    { en: "Grade 12", ar: "الصف الثاني عشر" },
  ],
  IG: [
    { en: "Year 9", ar: "السنة التاسعة" },
    { en: "Year 10", ar: "السنة العاشرة" },
    { en: "Year 11", ar: "السنة الحادية عشرة" },
  ],
};

const SUBJECT_AR: Record<string, string> = {
  Arabic: "اللغة العربية",
  English: "اللغة الإنجليزية",
  Mathematics: "الرياضيات",
  Physics: "الفيزياء",
  Chemistry: "الكيمياء",
  Biology: "الأحياء",
  French: "اللغة الفرنسية",
  German: "اللغة الألمانية",
  History: "التاريخ",
  Geography: "الجغرافيا",
  "Computer Science": "علوم الحاسب",
};

/** subject → the grades (per system) it links to. */
const SUBJECT_GRADES: Record<string, Partial<Record<SystemKey, string[]>>> = {
  Arabic: {
    EG: ["Primary 4", "Primary 6", "Preparatory 2", "Preparatory 3", "Secondary 1", "Secondary 3"],
  },
  English: {
    EG: ["Primary 3", "Primary 6", "Preparatory 1", "Preparatory 3", "Secondary 2", "Secondary 3"],
    US: ["Grade 9", "Grade 10", "Grade 11"],
    IG: ["Year 10", "Year 11"],
  },
  Mathematics: {
    EG: ["Primary 5", "Primary 6", "Preparatory 2", "Preparatory 3", "Secondary 1", "Secondary 2", "Secondary 3"],
    US: ["Grade 9", "Grade 10", "Grade 11", "Grade 12"],
    IG: ["Year 9", "Year 10", "Year 11"],
  },
  Physics: {
    EG: ["Secondary 1", "Secondary 2", "Secondary 3"],
    US: ["Grade 10", "Grade 11", "Grade 12"],
    IG: ["Year 10", "Year 11"],
  },
  Chemistry: {
    EG: ["Secondary 1", "Secondary 2", "Secondary 3"],
    US: ["Grade 10", "Grade 11"],
    IG: ["Year 10", "Year 11"],
  },
  Biology: {
    EG: ["Secondary 1", "Secondary 2", "Secondary 3"],
    US: ["Grade 10", "Grade 11"],
    IG: ["Year 10", "Year 11"],
  },
  French: { EG: ["Preparatory 2", "Secondary 1"], IG: ["Year 10"] },
  German: { EG: ["Secondary 1", "Secondary 2"] },
  History: { EG: ["Preparatory 3", "Secondary 2", "Secondary 3"], US: ["Grade 11"] },
  Geography: { EG: ["Preparatory 3", "Secondary 2", "Secondary 3"] },
  "Computer Science": {
    EG: ["Preparatory 1", "Preparatory 2"],
    US: ["Grade 10", "Grade 11"],
    IG: ["Year 10", "Year 11"],
  },
};

/**
 * The seed catalog's subject shape, read from the matrix above: each subject's
 * English name → how many grades it links to. `seed:verify` asserts the
 * database matches it (U3: one row per subject, these links).
 */
export function seedSubjectLinkCounts(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(SUBJECT_GRADES).map(([subjectEn, perSystem]) => [
      subjectEn,
      Object.values(perSystem).reduce((sum, grades) => sum + (grades?.length ?? 0), 0),
    ]),
  );
}

export type CatalogSubjectRow = CatalogSubject & { gradeIds: string[] };

export type Catalog = {
  systemIds: Record<SystemKey, string>;
  grades: CatalogGrade[];
  /** Each subject once, with its grade links (U3). */
  subjects: CatalogSubjectRow[];
  /** The grade row for a system + English grade name. */
  grade: (system: SystemKey, gradeEn: string) => CatalogGrade;
  /** A linked (grade, subject) pair by English names — throws if the subject does not link to that grade. */
  pair: (system: SystemKey, gradeEn: string, subjectEn: string) => { subjectId: string; gradeId: string };
  systemOfGrade: (gradeId: string) => SystemKey;
};

export async function ensureCatalog(
  prisma: PrismaClient,
  adminUserId: string,
  log: (line: string) => void,
): Promise<Catalog> {
  const systemIds = {} as Record<SystemKey, string>;
  const gradeIndex = new Map<string, CatalogGrade>();
  const gradeSystem = new Map<string, SystemKey>();
  const subjectIndex = new Map<string, CatalogSubjectRow>();
  let created = 0;

  for (const key of Object.keys(SYSTEMS) as SystemKey[]) {
    const def = SYSTEMS[key];
    const existing = await prisma.catalogEducationSystem.findFirst({ where: { nameEn: def.en } });
    if (existing) {
      systemIds[key] = existing.id;
    } else {
      const result = await createCatalogEntry(prisma, adminUserId, "EDUCATION_SYSTEM", {
        nameEn: def.en,
        nameAr: def.ar,
        defaultFixedCenterShare: def.defaultFixedCenterShare,
      });
      if (!result.ok) throw new Error(`Catalog system ${def.en}: ${result.error}`);
      systemIds[key] = result.id;
      created += 1;
    }

    for (const grade of GRADES[key]) {
      let row = await prisma.catalogGrade.findFirst({
        where: { nameEn: grade.en, educationSystemId: systemIds[key] },
      });
      if (!row) {
        const result = await createCatalogEntry(prisma, adminUserId, "GRADE", {
          nameEn: grade.en,
          nameAr: grade.ar,
          parentId: systemIds[key],
        });
        if (!result.ok) throw new Error(`Catalog grade ${grade.en}: ${result.error}`);
        row = await prisma.catalogGrade.findUniqueOrThrow({ where: { id: result.id } });
        created += 1;
      }
      gradeIndex.set(`${key}:${grade.en}`, row);
      gradeSystem.set(row.id, key);
    }
  }

  // Each subject once, linked to its grades; a rerun adds any missing link
  // (through the admin write path, like the create).
  for (const [subjectEn, perSystem] of Object.entries(SUBJECT_GRADES)) {
    const gradeIds = (Object.entries(perSystem) as [SystemKey, string[]][]).flatMap(([key, gradeNames]) =>
      gradeNames.map((gradeEn) => {
        const grade = gradeIndex.get(`${key}:${gradeEn}`);
        if (!grade) throw new Error(`Catalog: no grade ${key}:${gradeEn} for ${subjectEn}`);
        return grade.id;
      }),
    );
    const existing = await prisma.catalogSubject.findFirst({
      where: { nameEn: subjectEn },
      include: { gradeLinks: { select: { gradeId: true } } },
    });
    let id: string;
    if (!existing) {
      const result = await createCatalogEntry(prisma, adminUserId, "SUBJECT", {
        nameEn: subjectEn,
        nameAr: SUBJECT_AR[subjectEn],
        gradeIds,
      });
      if (!result.ok) throw new Error(`Catalog subject ${subjectEn}: ${result.error}`);
      id = result.id;
      created += 1;
    } else {
      id = existing.id;
      const linked = new Set(existing.gradeLinks.map((link) => link.gradeId));
      if (gradeIds.some((gradeId) => !linked.has(gradeId))) {
        const result = await updateCatalogEntry(prisma, adminUserId, "SUBJECT", id, {
          nameEn: existing.nameEn,
          nameAr: existing.nameAr,
          gradeIds: [...new Set([...linked, ...gradeIds])],
        });
        if (!result.ok) throw new Error(`Catalog subject ${subjectEn} links: ${result.error}`);
      }
    }
    const row = await prisma.catalogSubject.findUniqueOrThrow({
      where: { id },
      include: { gradeLinks: { select: { gradeId: true } } },
    });
    const { gradeLinks, ...subject } = row;
    subjectIndex.set(subjectEn, { ...subject, gradeIds: gradeLinks.map((link) => link.gradeId) });
  }

  const links = [...subjectIndex.values()].reduce((sum, row) => sum + row.gradeIds.length, 0);
  log(`  catalog: ${created} entr${created === 1 ? "y" : "ies"} created (${subjectIndex.size} subjects with ${links} grade links, ${gradeIndex.size} grades, 3 systems)`);

  return {
    systemIds,
    grades: [...gradeIndex.values()],
    subjects: [...subjectIndex.values()],
    grade: (system, gradeEn) => {
      const row = gradeIndex.get(`${system}:${gradeEn}`);
      if (!row) throw new Error(`Unknown grade ${system}:${gradeEn}`);
      return row;
    },
    pair: (system, gradeEn, subjectEn) => {
      const grade = gradeIndex.get(`${system}:${gradeEn}`);
      const subject = subjectIndex.get(subjectEn);
      if (!grade || !subject || !subject.gradeIds.includes(grade.id)) {
        throw new Error(`Not a linked pair: ${system}:${gradeEn} × ${subjectEn}`);
      }
      return { subjectId: subject.id, gradeId: grade.id };
    },
    systemOfGrade: (gradeId) => {
      const key = gradeSystem.get(gradeId);
      if (!key) throw new Error(`Unknown grade id ${gradeId}`);
      return key;
    },
  };
}
