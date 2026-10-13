/**
 * The demo's blueprint (P1): who exists, where, and what each centre teaches.
 * Pure data — no database, no clock — so the seed, `seed:verify` and
 * `docs/dev-accounts.md` all read one description. Everything is fictional.
 *
 * Every sign-in address is `@<SEED_EMAIL_DOMAIN>` (default `example.com`,
 * RFC 2606 — never a real mailbox; `./domain.ts`) and every account's password
 * is `SEED_PASSWORD`.
 */
import type { ShareType } from "@prisma/client";
import type { SystemKey } from "./catalog.ts";
import { mail } from "./domain.ts";

export type Locale = "ar" | "en";

export type PersonDef = {
  /** Stable key — the idempotency anchor for phones and lookups. */
  key: string;
  first: string;
  last: string;
  /** Present only for an account that can sign in. */
  email?: string;
  locale?: Locale;
};

export type StaffRole = "OWNER" | "MANAGER" | "RECEPTIONIST" | "ACCOUNTANT";

export type StaffDef = PersonDef & { role: StaffRole };

export type TermKey = "T1" | "T2" | "FULL";

export type ClassDef = {
  key: string;
  system: SystemKey;
  /** English grade name within the system, e.g. "Secondary 2". */
  grade: string;
  /** English subject name, e.g. "Mathematics". */
  subject: string;
  teacher: string;
  /** Index into the branch's `rooms`. */
  room: number;
  /** Extra rooms combined with `room` (each must be a declared link). */
  extraRooms?: number[];
  /** 0 = Sunday … 6 = Saturday (Friday is the weekend: never used). */
  day: number;
  start: string;
  end: string;
  /** Piastres per session. */
  price: number;
  share: { type: ShareType; value: number };
  term: TermKey;
  requiresConfirmation?: boolean;
  acceptsNewStudents?: boolean;
  /** Deactivated at the end of the seed, after its history exists. */
  deactivate?: boolean;
};

export type StudentSpecial = {
  key: string;
  first: string;
  last: string;
  system: SystemKey;
  grade: string;
  /** Present for a student who can sign in. */
  email?: string;
  /** Parent account this child belongs to (its phone is the child's parent phone). */
  parent?: "family" | "nokhba";
  locale?: Locale;
};

export type StudentMix = { system: SystemKey; grade: string; count: number };

export type BranchKey = "downtown" | "nasrcity" | "nokhba" | "onboarding" | "suspended";

export type BranchDef = {
  key: BranchKey;
  orgKey: string;
  slug: string;
  name: string;
  themeColor: string;
  lifecycle: "ACTIVE" | "ONBOARDING" | "SUSPENDED";
  /** Catalog systems this centre picks (every grade and subject under them). */
  systems: SystemKey[];
  dataVisibilityDays: number;
  staff: StaffDef[];
  /** Teacher keys (see TEACHERS) with a membership at this branch. */
  teachers: string[];
  rooms: { name: string; capacity: number }[];
  roomLinks: [number, number][];
  /** One extra payment method beyond Cash / InstaPay / Vodafone Cash. */
  customMethod?: string;
  classes: ClassDef[];
  specials: StudentSpecial[];
  mix: StudentMix[];
  /** Subject renames this centre made for itself (bilingual, either language). */
  renames?: {
    system: SystemKey;
    grade: string;
    subject: string;
    ar?: string;
    en?: string;
  }[];
};

export const OWNER_ORG_NAME = "Center 60";
export const NOKHBA_ORG_NAME = "Al Nokhba Academy";

export const PLATFORM_ADMIN: PersonDef = {
  key: "admin",
  first: "Sherine",
  last: "Abdelhamid",
  email: mail("admin"),
  locale: "en",
};

// ── Teachers (global people; a membership per centre) ──────────────────────

export const TEACHERS: Record<string, PersonDef> = {
  // Teaches at BOTH Center 60 branches — two memberships, one User.
  hesham: { key: "hesham", first: "Hesham", last: "Mansour", email: mail("teacher.shared"), locale: "en" },
  mona: { key: "mona", first: "Mona", last: "El-Sayed", email: mail("teacher.downtown"), locale: "en" },
  karim: { key: "karim", first: "Karim", last: "Fathy" },
  yasser: { key: "yasser", first: "Yasser", last: "Abdelrahman" },
  dina: { key: "dina", first: "Dina", last: "Samir" },
  tamer: { key: "tamer", first: "Tamer", last: "Nabil" },
  salma: { key: "salma", first: "Salma", last: "Reda", email: mail("teacher.nasrcity"), locale: "en" },
  // Teaches at Nasr City (Center 60) AND at Al Nokhba Academy — a different organization.
  mahmoud: { key: "mahmoud", first: "Mahmoud", last: "Gaber", email: mail("teacher.crossorg"), locale: "en" },
  rania: { key: "rania", first: "Rania", last: "Adel" },
  omar: { key: "omar", first: "Omar", last: "Talaat" },
  nourhan: { key: "nourhan", first: "Nourhan", last: "Wagdy" },
  sameh: { key: "sameh", first: "Sameh", last: "Farouk" },
  heba: { key: "heba", first: "Heba", last: "Zaki" },
};

/** A teacher with no centre yet — requests to teach from the centre directory. */
export const ZERO_CENTRE_TEACHER: PersonDef = {
  key: "walid",
  first: "Walid",
  last: "Ashour",
  email: mail("teacher.new"),
  locale: "en",
};

// ── Parents ────────────────────────────────────────────────────────────────

export const PARENTS = {
  /** 2 VERIFIED children (one per Center 60 branch) + 1 PENDING. */
  family: { key: "parent-family", first: "Hanan", last: "Kamel", email: mail("parent.family"), locale: "ar" as Locale },
  /** One child, who studies at Al Nokhba (and, pending, at Center 60 Downtown too). */
  nokhba: { key: "parent-nokhba", first: "Ashraf", last: "Salah", email: mail("parent.nokhba"), locale: "en" as Locale },
};

/** A student with no centre: reserves a seat from Discover (pending). */
export const DISCOVER_STUDENT: PersonDef = {
  key: "discover",
  first: "Omar",
  last: "Metwally",
  email: mail("student.new"),
  locale: "en",
};

// ── Branches ───────────────────────────────────────────────────────────────

const DOWNTOWN: BranchDef = {
  key: "downtown",
  orgKey: "center60",
  slug: "center-60-downtown",
  name: "Center 60 — Downtown",
  themeColor: "#2563EB",
  lifecycle: "ACTIVE",
  systems: ["EG", "US", "IG"],
  dataVisibilityDays: 30,
  customMethod: "Bank transfer",
  staff: [
    { key: "owner-c60", role: "OWNER", first: "Tarek", last: "Hegazy", email: mail("owner.center60"), locale: "en" },
    { key: "mgr-dt", role: "MANAGER", first: "Hala", last: "Mostafa", email: mail("manager.downtown"), locale: "en" },
    { key: "rec-dt", role: "RECEPTIONIST", first: "Mina", last: "Gerges", email: mail("receptionist.downtown"), locale: "en" },
    { key: "acc-dt", role: "ACCOUNTANT", first: "Ehab", last: "Lotfy", email: mail("accountant.downtown"), locale: "en" },
  ],
  teachers: ["hesham", "mona", "karim", "yasser", "dina", "tamer"],
  rooms: [
    { name: "Room 1", capacity: 18 },
    { name: "Room 2", capacity: 18 },
    { name: "Lab", capacity: 12 },
    { name: "Hall A", capacity: 25 },
    { name: "Hall B", capacity: 25 },
  ],
  roomLinks: [
    [0, 1],
    [3, 4],
  ],
  classes: [
    // On the combined Hall A + Hall B (50 seats).
    { key: "dt-math-s2", system: "EG", grade: "Secondary 2", subject: "Mathematics", teacher: "hesham", room: 3, extraRooms: [4], day: 6, start: "16:00", end: "18:00", price: 15_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    { key: "dt-math-p3", system: "EG", grade: "Preparatory 3", subject: "Mathematics", teacher: "hesham", room: 0, day: 1, start: "15:00", end: "16:30", price: 12_000, share: { type: "FIXED", value: 3_000 }, term: "T1" },
    // Asks the centre to confirm every request.
    { key: "dt-arabic-s3", system: "EG", grade: "Secondary 3", subject: "Arabic", teacher: "mona", room: 1, day: 0, start: "17:00", end: "19:00", price: 16_000, share: { type: "PERCENTAGE", value: 20 }, term: "FULL", requiresConfirmation: true },
    { key: "dt-arabic-p6", system: "EG", grade: "Primary 6", subject: "Arabic", teacher: "mona", room: 0, day: 2, start: "14:00", end: "15:30", price: 9_000, share: { type: "PERCENTAGE", value: 15 }, term: "T1" },
    { key: "dt-english-p6", system: "EG", grade: "Primary 6", subject: "English", teacher: "karim", room: 1, day: 3, start: "16:00", end: "17:30", price: 10_000, share: { type: "FIXED", value: 3_000 }, term: "FULL" },
    { key: "dt-english-us10", system: "US", grade: "Grade 10", subject: "English", teacher: "karim", room: 0, day: 4, start: "17:00", end: "19:00", price: 20_000, share: { type: "FIXED", value: 4_000 }, term: "FULL" },
    { key: "dt-physics-s3", system: "EG", grade: "Secondary 3", subject: "Physics", teacher: "yasser", room: 2, day: 6, start: "18:30", end: "20:30", price: 18_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    // Full: takes no new students.
    { key: "dt-physics-ig10", system: "IG", grade: "Year 10", subject: "Physics", teacher: "yasser", room: 1, day: 1, start: "18:00", end: "19:30", price: 25_000, share: { type: "FIXED", value: 5_000 }, term: "FULL", acceptsNewStudents: false },
    // Deactivated at the end of the seed — its history stays.
    { key: "dt-chem-s2", system: "EG", grade: "Secondary 2", subject: "Chemistry", teacher: "dina", room: 3, day: 2, start: "17:00", end: "19:00", price: 15_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL", deactivate: true },
    // Next term's intake: no sessions yet.
    { key: "dt-cs-p2", system: "EG", grade: "Preparatory 2", subject: "Computer Science", teacher: "tamer", room: 2, day: 3, start: "14:00", end: "15:30", price: 8_000, share: { type: "PERCENTAGE", value: 10 }, term: "T2" },
  ],
  specials: [
    { key: "dt-youssef", first: "Youssef", last: "Hassan", system: "EG", grade: "Secondary 2", email: mail("student.downtown"), locale: "en" },
    { key: "dt-yara", first: "Yara", last: "Kamel", system: "EG", grade: "Primary 6", parent: "family" },
    { key: "dt-mazen", first: "Mazen", last: "Kamel", system: "EG", grade: "Secondary 1", parent: "family" },
    { key: "dt-farida", first: "Farida", last: "Salah", system: "EG", grade: "Secondary 2", email: mail("student.both"), parent: "nokhba", locale: "en" },
  ],
  mix: [
    { system: "EG", grade: "Secondary 2", count: 8 },
    { system: "EG", grade: "Preparatory 3", count: 6 },
    { system: "EG", grade: "Secondary 3", count: 7 },
    { system: "EG", grade: "Primary 6", count: 8 },
    { system: "US", grade: "Grade 10", count: 5 },
    { system: "IG", grade: "Year 10", count: 4 },
    { system: "EG", grade: "Preparatory 2", count: 4 },
    { system: "EG", grade: "Primary 4", count: 1 },
    { system: "EG", grade: "Preparatory 1", count: 1 },
    { system: "EG", grade: "Secondary 1", count: 1 },
  ],
  renames: [
    { system: "EG", grade: "Secondary 2", subject: "Mathematics", ar: "الرياضيات البحتة", en: "Pure Mathematics" },
    { system: "EG", grade: "Secondary 3", subject: "Physics", ar: "الفيزياء (مستوى متقدم)" },
  ],
};

const NASR_CITY: BranchDef = {
  key: "nasrcity",
  orgKey: "center60",
  slug: "center-60-nasr-city",
  name: "Center 60 — Nasr City",
  themeColor: "#0D9488",
  lifecycle: "ACTIVE",
  systems: ["EG", "US", "IG"],
  dataVisibilityDays: 60,
  staff: [
    { key: "mgr-nc", role: "MANAGER", first: "Wael", last: "Shaker", email: mail("manager.nasrcity"), locale: "en" },
    { key: "rec-nc", role: "RECEPTIONIST", first: "Noha", last: "Fouad", email: mail("receptionist.nasrcity"), locale: "en" },
    { key: "acc-nc", role: "ACCOUNTANT", first: "Samar", last: "Khalil", email: mail("accountant.nasrcity"), locale: "en" },
  ],
  teachers: ["hesham", "salma", "mahmoud", "rania", "omar", "nourhan"],
  rooms: [
    { name: "Room A", capacity: 20 },
    { name: "Room B", capacity: 20 },
    { name: "Room C", capacity: 14 },
    { name: "Studio 1", capacity: 30 },
    { name: "Studio 2", capacity: 30 },
  ],
  roomLinks: [
    [0, 1],
    [3, 4],
  ],
  classes: [
    // Combined Studio 1 + Studio 2 (60 seats).
    { key: "nc-math-s3", system: "EG", grade: "Secondary 3", subject: "Mathematics", teacher: "hesham", room: 3, extraRooms: [4], day: 0, start: "15:00", end: "17:00", price: 17_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    { key: "nc-math-us11", system: "US", grade: "Grade 11", subject: "Mathematics", teacher: "hesham", room: 0, day: 3, start: "18:00", end: "19:30", price: 20_000, share: { type: "FIXED", value: 4_000 }, term: "FULL" },
    { key: "nc-english-ig10", system: "IG", grade: "Year 10", subject: "English", teacher: "salma", room: 0, day: 6, start: "16:00", end: "17:30", price: 24_000, share: { type: "FIXED", value: 5_000 }, term: "FULL", acceptsNewStudents: false },
    { key: "nc-english-s2", system: "EG", grade: "Secondary 2", subject: "English", teacher: "salma", room: 1, day: 2, start: "16:00", end: "17:30", price: 12_000, share: { type: "PERCENTAGE", value: 15 }, term: "T1" },
    { key: "nc-physics-s2", system: "EG", grade: "Secondary 2", subject: "Physics", teacher: "mahmoud", room: 1, day: 1, start: "17:00", end: "19:00", price: 16_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    { key: "nc-physics-ig11", system: "IG", grade: "Year 11", subject: "Physics", teacher: "mahmoud", room: 2, day: 4, start: "16:00", end: "18:00", price: 26_000, share: { type: "FIXED", value: 5_000 }, term: "FULL", requiresConfirmation: true },
    { key: "nc-arabic-p3", system: "EG", grade: "Preparatory 3", subject: "Arabic", teacher: "rania", room: 1, day: 6, start: "14:00", end: "15:30", price: 10_000, share: { type: "PERCENTAGE", value: 20 }, term: "T1" },
    { key: "nc-bio-s3", system: "EG", grade: "Secondary 3", subject: "Biology", teacher: "omar", room: 3, day: 2, start: "18:00", end: "20:00", price: 17_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    { key: "nc-history-s3", system: "EG", grade: "Secondary 3", subject: "History", teacher: "nourhan", room: 2, day: 3, start: "14:00", end: "15:30", price: 9_000, share: { type: "PERCENTAGE", value: 10 }, term: "FULL" },
    { key: "nc-geo-s2", system: "EG", grade: "Secondary 2", subject: "Geography", teacher: "nourhan", room: 0, day: 4, start: "14:00", end: "15:30", price: 9_000, share: { type: "PERCENTAGE", value: 10 }, term: "FULL" },
  ],
  specials: [
    { key: "nc-mariam", first: "Mariam", last: "Ibrahim", system: "EG", grade: "Secondary 3", email: mail("student.nasrcity"), locale: "en" },
    { key: "nc-ziad", first: "Ziad", last: "Kamel", system: "EG", grade: "Preparatory 3", parent: "family" },
  ],
  mix: [
    { system: "EG", grade: "Secondary 3", count: 9 },
    { system: "US", grade: "Grade 11", count: 4 },
    { system: "IG", grade: "Year 10", count: 5 },
    { system: "EG", grade: "Secondary 2", count: 9 },
    { system: "IG", grade: "Year 11", count: 5 },
    { system: "EG", grade: "Preparatory 3", count: 6 },
    { system: "EG", grade: "Primary 5", count: 2 },
    { system: "EG", grade: "Primary 4", count: 2 },
    { system: "EG", grade: "Preparatory 1", count: 2 },
    { system: "EG", grade: "Secondary 1", count: 1 },
  ],
  renames: [{ system: "EG", grade: "Secondary 2", subject: "Physics", en: "Physics (Advanced)" }],
};

const NOKHBA: BranchDef = {
  key: "nokhba",
  orgKey: "nokhba",
  slug: "al-nokhba-academy",
  name: "Al Nokhba Academy",
  themeColor: "#7C3AED",
  lifecycle: "ACTIVE",
  systems: ["EG", "IG"],
  dataVisibilityDays: 30,
  staff: [
    { key: "owner-nk", role: "OWNER", first: "Hisham", last: "Badawy", email: mail("owner.nokhba"), locale: "en" },
    { key: "rec-nk", role: "RECEPTIONIST", first: "Rasha", last: "Younes", email: mail("receptionist.nokhba"), locale: "en" },
  ],
  teachers: ["mahmoud", "sameh", "heba"],
  rooms: [
    { name: "Class 1", capacity: 16 },
    { name: "Class 2", capacity: 16 },
    { name: "Class 3", capacity: 24 },
  ],
  roomLinks: [[0, 1]],
  classes: [
    { key: "nk-physics-ig10", system: "IG", grade: "Year 10", subject: "Physics", teacher: "mahmoud", room: 2, day: 0, start: "17:00", end: "19:00", price: 22_000, share: { type: "FIXED", value: 5_000 }, term: "FULL" },
    { key: "nk-math-s2", system: "EG", grade: "Secondary 2", subject: "Mathematics", teacher: "sameh", room: 0, day: 1, start: "16:00", end: "18:00", price: 14_000, share: { type: "PERCENTAGE", value: 15 }, term: "FULL" },
    { key: "nk-english-s2", system: "EG", grade: "Secondary 2", subject: "English", teacher: "heba", room: 1, day: 3, start: "16:00", end: "17:30", price: 11_000, share: { type: "PERCENTAGE", value: 20 }, term: "FULL" },
    { key: "nk-arabic-p6", system: "EG", grade: "Primary 6", subject: "Arabic", teacher: "heba", room: 1, day: 4, start: "15:00", end: "16:30", price: 8_000, share: { type: "PERCENTAGE", value: 15 }, term: "T1" },
  ],
  specials: [
    { key: "nk-farida", first: "Farida", last: "Salah", system: "EG", grade: "Secondary 2", email: mail("student.both"), parent: "nokhba", locale: "en" },
  ],
  mix: [
    { system: "EG", grade: "Secondary 2", count: 9 },
    { system: "IG", grade: "Year 10", count: 5 },
    { system: "EG", grade: "Primary 6", count: 6 },
  ],
};

/** A centre still being set up — its one staff member can sign in. */
const ONBOARDING: BranchDef = {
  key: "onboarding",
  orgKey: "onboarding",
  slug: "al-amal-learning-hub",
  name: "Al Amal Learning Hub",
  themeColor: "#F59E0B",
  lifecycle: "ONBOARDING",
  systems: [],
  dataVisibilityDays: 30,
  staff: [
    { key: "owner-ob", role: "OWNER", first: "Mervat", last: "Salah", email: mail("owner.onboarding"), locale: "en" },
  ],
  teachers: [],
  rooms: [],
  roomLinks: [],
  classes: [],
  specials: [],
  mix: [],
};

/** A suspended centre — its one staff member must be refused at sign-in. */
const SUSPENDED: BranchDef = {
  key: "suspended",
  orgKey: "suspended",
  slug: "future-skills-academy",
  name: "Future Skills Academy",
  themeColor: "#DC2626",
  lifecycle: "SUSPENDED",
  systems: [],
  dataVisibilityDays: 30,
  staff: [
    { key: "owner-sp", role: "OWNER", first: "Kamal", last: "Osman", email: mail("owner.suspended"), locale: "en" },
  ],
  teachers: [],
  rooms: [],
  roomLinks: [],
  classes: [],
  specials: [],
  mix: [],
};

export const BRANCHES: BranchDef[] = [DOWNTOWN, NASR_CITY, NOKHBA, ONBOARDING, SUSPENDED];

export const ORGANIZATIONS: Record<string, { name: string; nameEn: string }> = {
  center60: { name: OWNER_ORG_NAME, nameEn: OWNER_ORG_NAME },
  nokhba: { name: NOKHBA_ORG_NAME, nameEn: NOKHBA_ORG_NAME },
  onboarding: { name: "Al Amal Learning Hub", nameEn: "Al Amal Learning Hub" },
  suspended: { name: "Future Skills Academy", nameEn: "Future Skills Academy" },
};

// ── The fixed account list ─────────────────────────────────────────────────

export type SeedAccount = {
  email: string;
  first: string;
  last: string;
  locale: Locale;
  /** Human description for docs/dev-accounts.md. */
  role: string;
  centre: string;
};

/** Every address the seed owns in Supabase Auth, with what it is for. */
export function seedAccounts(): SeedAccount[] {
  const out: SeedAccount[] = [];
  const add = (person: PersonDef, role: string, centre: string) => {
    if (!person.email) return;
    out.push({
      email: person.email,
      first: person.first,
      last: person.last,
      locale: person.locale ?? "en",
      role,
      centre,
    });
  };

  add(PLATFORM_ADMIN, "Platform admin (Super Admin)", "— (whole platform)");
  for (const branch of BRANCHES) {
    for (const staff of branch.staff) {
      const label =
        staff.role === "OWNER" && branch.orgKey === "center60"
          ? "Owner (organization level — both branches)"
          : staff.role[0] + staff.role.slice(1).toLowerCase();
      add(staff, label, branch.name + (branch.lifecycle === "ACTIVE" ? "" : ` (${branch.lifecycle})`));
    }
  }
  const taught = (key: string) =>
    BRANCHES.filter((branch) => branch.teachers.includes(key)).map((branch) => branch.name);
  for (const teacher of Object.values(TEACHERS)) {
    add(teacher, "Teacher", taught(teacher.key).join(" + "));
  }
  add(ZERO_CENTRE_TEACHER, "Teacher (no centre yet — requests to teach)", "—");
  for (const branch of BRANCHES) {
    for (const special of branch.specials) {
      if (!special.email) continue;
      if (out.some((account) => account.email === special.email)) continue;
      const where = BRANCHES.filter((b) => b.specials.some((s) => s.email === special.email)).map((b) => b.name);
      out.push({
        email: special.email,
        first: special.first,
        last: special.last,
        locale: special.locale ?? "en",
        role: where.length > 1 ? "Student (studies at both organizations)" : "Student",
        centre: where.join(" + "),
      });
    }
  }
  add(DISCOVER_STUDENT, "Student (no centre — has a pending reservation)", "—");
  add(PARENTS.family, "Parent (2 verified children + 1 pending)", "Center 60 — Downtown + Nasr City");
  add(PARENTS.nokhba, "Parent (child at Al Nokhba; Center 60 link pending)", "Al Nokhba Academy");
  return out;
}
