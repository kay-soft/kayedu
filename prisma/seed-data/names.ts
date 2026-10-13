/**
 * Name pools for the demo seed (P1). All fictional: first names and family
 * names are common Egyptian ones, recombined at random — no real person is
 * meant. Each carries a Latin spelling (`en`) and its Arabic script (`ar`), so
 * ~10% of students can be written in Arabic script while the rest use Latin
 * (a person has ONE name per relationship, never a locale pair — CLAUDE.md
 * rule 5; the choice of script is made once, here, per person).
 */
import type { Rng } from "./helpers.ts";

export type NamePart = { en: string; ar: string };

export const MALE_FIRST: NamePart[] = [
  { en: "Ahmed", ar: "أحمد" },
  { en: "Mohamed", ar: "محمد" },
  { en: "Mahmoud", ar: "محمود" },
  { en: "Omar", ar: "عمر" },
  { en: "Youssef", ar: "يوسف" },
  { en: "Ali", ar: "علي" },
  { en: "Hassan", ar: "حسن" },
  { en: "Hussein", ar: "حسين" },
  { en: "Khaled", ar: "خالد" },
  { en: "Karim", ar: "كريم" },
  { en: "Tarek", ar: "طارق" },
  { en: "Amr", ar: "عمرو" },
  { en: "Mostafa", ar: "مصطفى" },
  { en: "Ibrahim", ar: "إبراهيم" },
  { en: "Ismail", ar: "إسماعيل" },
  { en: "Adam", ar: "آدم" },
  { en: "Ziad", ar: "زياد" },
  { en: "Seif", ar: "سيف" },
  { en: "Hamza", ar: "حمزة" },
  { en: "Yassin", ar: "ياسين" },
  { en: "Marwan", ar: "مروان" },
  { en: "Mazen", ar: "مازن" },
  { en: "Bassem", ar: "باسم" },
  { en: "Hazem", ar: "حازم" },
  { en: "Fady", ar: "فادي" },
  { en: "Sherif", ar: "شريف" },
  { en: "Walid", ar: "وليد" },
  { en: "Tamer", ar: "تامر" },
];

export const FEMALE_FIRST: NamePart[] = [
  { en: "Fatma", ar: "فاطمة" },
  { en: "Mariam", ar: "مريم" },
  { en: "Salma", ar: "سلمى" },
  { en: "Nour", ar: "نور" },
  { en: "Hana", ar: "هنا" },
  { en: "Jana", ar: "جنى" },
  { en: "Laila", ar: "ليلى" },
  { en: "Farida", ar: "فريدة" },
  { en: "Malak", ar: "ملك" },
  { en: "Habiba", ar: "حبيبة" },
  { en: "Nada", ar: "ندى" },
  { en: "Rawan", ar: "روان" },
  { en: "Yasmin", ar: "ياسمين" },
  { en: "Aya", ar: "آية" },
  { en: "Sara", ar: "سارة" },
  { en: "Mai", ar: "مي" },
  { en: "Dina", ar: "دينا" },
  { en: "Reem", ar: "ريم" },
  { en: "Nouran", ar: "نوران" },
  { en: "Rana", ar: "رنا" },
  { en: "Heba", ar: "هبة" },
  { en: "Menna", ar: "منة" },
  { en: "Lina", ar: "لينا" },
  { en: "Tala", ar: "تالا" },
  { en: "Shahd", ar: "شهد" },
  { en: "Amira", ar: "أميرة" },
];

export const FAMILY: NamePart[] = [
  { en: "Hassan", ar: "حسن" },
  { en: "Ibrahim", ar: "إبراهيم" },
  { en: "Mansour", ar: "منصور" },
  { en: "Abdelrahman", ar: "عبد الرحمن" },
  { en: "El-Sayed", ar: "السيد" },
  { en: "Fathy", ar: "فتحي" },
  { en: "Samir", ar: "سمير" },
  { en: "Nabil", ar: "نبيل" },
  { en: "Gaber", ar: "جابر" },
  { en: "Adel", ar: "عادل" },
  { en: "Talaat", ar: "طلعت" },
  { en: "Wagdy", ar: "وجدي" },
  { en: "Reda", ar: "رضا" },
  { en: "Ashour", ar: "عاشور" },
  { en: "Farouk", ar: "فاروق" },
  { en: "Salah", ar: "صلاح" },
  { en: "Zaki", ar: "زكي" },
  { en: "Hegazy", ar: "حجازي" },
  { en: "Soliman", ar: "سليمان" },
  { en: "Kamel", ar: "كامل" },
  { en: "Shaker", ar: "شاكر" },
  { en: "Moussa", ar: "موسى" },
  { en: "Radwan", ar: "رضوان" },
  { en: "Helmy", ar: "حلمي" },
  { en: "Badawy", ar: "بدوي" },
  { en: "Ragab", ar: "رجب" },
  { en: "Lotfy", ar: "لطفي" },
  { en: "Sabry", ar: "صبري" },
  { en: "Fouad", ar: "فؤاد" },
  { en: "Yousry", ar: "يسري" },
  { en: "Naguib", ar: "نجيب" },
  { en: "Awad", ar: "عوض" },
  { en: "Morsy", ar: "مرسي" },
  { en: "Khalil", ar: "خليل" },
  { en: "Hamdy", ar: "حمدي" },
  { en: "Eissa", ar: "عيسى" },
  { en: "Shehata", ar: "شحاتة" },
  { en: "Metwally", ar: "متولي" },
  { en: "Osman", ar: "عثمان" },
  { en: "Saad", ar: "سعد" },
  { en: "Taha", ar: "طه" },
  { en: "Darwish", ar: "درويش" },
  { en: "Fahmy", ar: "فهمي" },
  { en: "Shawky", ar: "شوقي" },
  { en: "Mekky", ar: "مكي" },
  { en: "Amer", ar: "عامر" },
  { en: "Younes", ar: "يونس" },
  { en: "Bakr", ar: "بكر" },
  { en: "Rizk", ar: "رزق" },
];

export type GeneratedPerson = {
  firstName: string;
  lastName: string;
  /** Latin slug used to build a unique, readable example.com address. */
  slug: string;
  arabicScript: boolean;
  female: boolean;
};

/**
 * One unique person per call (unique on the English "first last" within
 * `taken`). `arabic` says whether this person is written in Arabic script —
 * the caller decides it by position (every tenth student), so the share is a
 * steady ~10% rather than whatever a random draw happened to give.
 */
export function generatePerson(
  rng: Rng,
  taken: Set<string>,
  options: { arabic: boolean; female?: boolean },
): GeneratedPerson {
  for (;;) {
    const female = options.female ?? rng.chance(0.5);
    const first = rng.pick(female ? FEMALE_FIRST : MALE_FIRST);
    const family = rng.pick(FAMILY);
    const key = `${first.en} ${family.en}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const arabicScript = options.arabic;
    return {
      firstName: arabicScript ? first.ar : first.en,
      lastName: arabicScript ? family.ar : family.en,
      slug: `${first.en}.${family.en}`.toLowerCase().replace(/[^a-z.]/g, ""),
      arabicScript,
      female,
    };
  }
}

/**
 * A parent's first name — the parent shares the child's family name. Never the
 * child's own first name (`avoid`), which would read as a data-entry slip.
 */
export function parentFirstName(
  rng: Rng,
  arabicScript: boolean,
  avoid?: string,
): { name: string; female: boolean } {
  for (;;) {
    const female = rng.chance(0.5);
    const first = rng.pick(female ? FEMALE_FIRST : MALE_FIRST);
    const name = arabicScript ? first.ar : first.en;
    if (name !== avoid) return { name, female };
  }
}
