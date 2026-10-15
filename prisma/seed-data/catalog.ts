/**
 * The global academic catalog for the demo (P1) — platform-owned, bilingual,
 * active. Written through `lib/db/catalog-admin.ts`'s `createCatalogEntry`, the
 * only code that may write a global row (it re-checks `isPlatformAdmin` and
 * audits each write), as the seeded platform admin.
 *
 * A subject row hangs off ONE grade (the schema has a single `gradeId`), so
 * "Mathematics" exists once per grade it is taught in. The matrix below is the
 * list of grades each subject is attached to — sensible, not exhaustive.
 */
import type { CatalogGrade, CatalogSubject, PrismaClient } from "@prisma/client";
import { createCatalogEntry } from "../../lib/db/catalog-admin.ts";

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

/** subject → the grades (per system) it is attached to. */
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

export type Catalog = {
  systemIds: Record<SystemKey, string>;
  grades: CatalogGrade[];
  subjects: CatalogSubject[];
  /** The grade row for a system + English grade name. */
  grade: (system: SystemKey, gradeEn: string) => CatalogGrade;
  /** The subject row for a system + English grade + English subject name. */
  subject: (system: SystemKey, gradeEn: string, subjectEn: string) => CatalogSubject;
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
  const subjectIndex = new Map<string, CatalogSubject>();
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

  for (const [subjectEn, perSystem] of Object.entries(SUBJECT_GRADES)) {
    for (const [key, gradeNames] of Object.entries(perSystem) as [SystemKey, string[]][]) {
      for (const gradeEn of gradeNames) {
        const grade = gradeIndex.get(`${key}:${gradeEn}`);
        if (!grade) throw new Error(`Catalog: no grade ${key}:${gradeEn} for ${subjectEn}`);
        let row = await prisma.catalogSubject.findFirst({
          where: { nameEn: subjectEn, gradeId: grade.id },
        });
        if (!row) {
          const result = await createCatalogEntry(prisma, adminUserId, "SUBJECT", {
            nameEn: subjectEn,
            nameAr: SUBJECT_AR[subjectEn],
            parentId: grade.id,
          });
          if (!result.ok) throw new Error(`Catalog subject ${subjectEn}/${gradeEn}: ${result.error}`);
          row = await prisma.catalogSubject.findUniqueOrThrow({ where: { id: result.id } });
          created += 1;
        }
        subjectIndex.set(`${key}:${gradeEn}:${subjectEn}`, row);
      }
    }
  }

  log(`  catalog: ${created} entr${created === 1 ? "y" : "ies"} created (${subjectIndex.size} subject rows, ${gradeIndex.size} grades, 3 systems)`);

  return {
    systemIds,
    grades: [...gradeIndex.values()],
    subjects: [...subjectIndex.values()],
    grade: (system, gradeEn) => {
      const row = gradeIndex.get(`${system}:${gradeEn}`);
      if (!row) throw new Error(`Unknown grade ${system}:${gradeEn}`);
      return row;
    },
    subject: (system, gradeEn, subjectEn) => {
      const row = subjectIndex.get(`${system}:${gradeEn}:${subjectEn}`);
      if (!row) throw new Error(`Unknown subject ${system}:${gradeEn}:${subjectEn}`);
      return row;
    },
    systemOfGrade: (gradeId) => {
      const key = gradeSystem.get(gradeId);
      if (!key) throw new Error(`Unknown grade id ${gradeId}`);
      return key;
    },
  };
}
