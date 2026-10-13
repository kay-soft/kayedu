/**
 * Seed: "Center 60" — one organization with **two branches**, so the M11
 * org-level roll-up (`npm run check:branches`) and every branch-aware screen
 * is exercisable against realistic two-branch data, not a single-branch
 * stand-in. Each branch gets its own CenterSettings, staff, teachers,
 * students, term presets (R4: Semester 1, Semester 2, Full year), classes
 * with a period and every session of it, and payment/attendance history —
 * plus one login per role so every experience (center, teacher, student)
 * can be signed into and tested (M10, M18).
 *
 * Run with:  npm run db:seed
 *
 * If SUPABASE_SERVICE_ROLE_KEY is set, this also creates the matching
 * **Supabase Auth** user (email confirmed) for the owner and one manager/
 * receptionist/teacher/student per branch — all sharing the owner's
 * password — and links each to its User row so they can sign in
 * immediately. Without that key it creates the app-side Users only — the
 * mirror in lib/auth/session.ts then links each by email on first login.
 *
 * Override the defaults with env vars:
 *   SEED_ORG_NAME, SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD,
 *   SEED_OWNER_FIRST_NAME, SEED_OWNER_LAST_NAME, SEED_OWNER_PHONE
 *
 * English person names throughout (M18, docs/03-build-order.md M18 "Seed
 * rewrite") — every person this seed creates (owner, staff, teachers,
 * students) has a Latin-script English name. Grades 1-12 and subjects come
 * from the global academic catalog (M13), never centre-authored, and every
 * catalog entry carries both an Arabic and an English name.
 */
import { PrismaClient, type CatalogGrade, type CatalogSubject } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { closeEndedSessions } from "../lib/db/session-lifecycle.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import {
  createClassWithSessions,
  createManualSession,
  createOneOffSession,
  updateClassWithSessions,
} from "../lib/db/class-sessions.ts";
import { linkRooms, writeSessionExtraRooms } from "../lib/db/room-sets.ts";
import { createTerm } from "../lib/db/terms.ts";
import { addDays, dateKey, dayMarker } from "../lib/scheduling.ts";
import { claimStudentCode } from "../lib/db/students.ts";

const prisma = new PrismaClient();

const ORG_NAME = process.env.SEED_ORG_NAME ?? "Center 60";
const OWNER_EMAIL = (process.env.SEED_OWNER_EMAIL ?? "owner@kayedu.test")
  .trim()
  .toLowerCase();
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "KayEdu!Dev123";
const OWNER_FIRST_NAME = process.env.SEED_OWNER_FIRST_NAME ?? "James";
const OWNER_LAST_NAME = process.env.SEED_OWNER_LAST_NAME ?? "Anderson";
const OWNER_PHONE = process.env.SEED_OWNER_PHONE ?? null;

// Every account the seed gives a real login shares this password, so the
// user only has to remember one credential to test each role.
const DEMO_LOGIN_PASSWORD = OWNER_PASSWORD;

/** Role → email, collected as logins are created, for the summary printed at the end. */
const seededLogins: { role: string; email: string }[] = [];

/**
 * Creates (or finds) a Supabase Auth user for the given person and returns
 * its id. Returns null when the service-role key isn't configured.
 */
async function ensureAuthUserFor(params: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || serviceRoleKey.startsWith("[")) {
    return null;
  }

  const { email, password, firstName, lastName } = params;
  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName, locale: "en" },
  });

  if (!error && data.user) {
    console.log(`  Auth user    ${email} created`);
    return data.user.id;
  }

  // Already registered: find the existing auth user instead of failing.
  for (let page = 1; page <= 10; page += 1) {
    const { data: list, error: listError } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (listError) throw listError;

    const match = list.users.find((user) => user.email?.toLowerCase() === email);
    if (match) {
      console.log(`  Auth user    ${email} already existed`);
      return match.id;
    }
    if (list.users.length < 200) break;
  }

  throw error ?? new Error(`Could not create or find auth user ${email}`);
}

async function findOrCreateByName<T extends { id: string }>(
  label: string,
  finder: () => Promise<T | null>,
  creator: () => Promise<T>,
): Promise<T> {
  const existing = await finder();
  if (existing) return existing;
  const created = await creator();
  console.log(`  + ${label}`);
  return created;
}

// ── The global academic catalog (M13) — platform-owned, no centerId ────────
// Grades 1-12 and a handful of subjects spread across them, each carrying
// both an Arabic and an English name (docs/01-data-model.md "Academic
// catalog layer"). Created once; both branches below pick from it via their
// own CenterCatalogSelection rows.

const GRADE_DEFS = [
  { en: "Grade 1", ar: "الصف الأول الابتدائي" },
  { en: "Grade 2", ar: "الصف الثاني الابتدائي" },
  { en: "Grade 3", ar: "الصف الثالث الابتدائي" },
  { en: "Grade 4", ar: "الصف الرابع الابتدائي" },
  { en: "Grade 5", ar: "الصف الخامس الابتدائي" },
  { en: "Grade 6", ar: "الصف السادس الابتدائي" },
  { en: "Grade 7", ar: "الصف الأول الإعدادي" },
  { en: "Grade 8", ar: "الصف الثاني الإعدادي" },
  { en: "Grade 9", ar: "الصف الثالث الإعدادي" },
  { en: "Grade 10", ar: "الصف الأول الثانوي" },
  { en: "Grade 11", ar: "الصف الثاني الثانوي" },
  { en: "Grade 12", ar: "الصف الثالث الثانوي" },
];

/** Subjects spread across several of the 12 grades, not just the last three. */
const SUBJECT_DEFS = [
  { en: "Mathematics", ar: "رياضيات", gradeIndex: 4 }, // Grade 5
  { en: "Science", ar: "علوم", gradeIndex: 5 }, // Grade 6
  { en: "English", ar: "اللغة الإنجليزية", gradeIndex: 6 }, // Grade 7
  { en: "Arabic", ar: "اللغة العربية", gradeIndex: 7 }, // Grade 8
  { en: "Physics", ar: "الفيزياء", gradeIndex: 9 }, // Grade 10
  { en: "Chemistry", ar: "الكيمياء", gradeIndex: 10 }, // Grade 11
];

type Catalog = {
  educationSystemId: string;
  grades: CatalogGrade[];
  subjects: CatalogSubject[];
};

async function ensureGlobalCatalog(): Promise<Catalog> {
  console.log("\nSeeding the global academic catalog (grades 1-12)…");

  const educationSystem = await findOrCreateByName(
    "Catalog education system: National Curriculum",
    () => prisma.catalogEducationSystem.findFirst({ where: { nameEn: "National Curriculum" } }),
    () =>
      prisma.catalogEducationSystem.create({
        data: {
          nameEn: "National Curriculum",
          nameAr: "المنهج الوطني",
          defaultFixedCenterShare: 4_000, // 40 EGP, per docs/00 §5's worked example
        },
      }),
  );

  const grades: CatalogGrade[] = [];
  for (const def of GRADE_DEFS) {
    grades.push(
      await findOrCreateByName(
        `Catalog grade: ${def.en}`,
        () => prisma.catalogGrade.findFirst({ where: { nameEn: def.en, educationSystemId: educationSystem.id } }),
        () =>
          prisma.catalogGrade.create({
            data: { nameEn: def.en, nameAr: def.ar, educationSystemId: educationSystem.id },
          }),
      ),
    );
  }

  const subjects: CatalogSubject[] = [];
  for (const def of SUBJECT_DEFS) {
    const gradeId = grades[def.gradeIndex].id;
    subjects.push(
      await findOrCreateByName(
        `Catalog subject: ${def.en}`,
        () => prisma.catalogSubject.findFirst({ where: { nameEn: def.en, gradeId } }),
        () => prisma.catalogSubject.create({ data: { nameEn: def.en, nameAr: def.ar, gradeId } }),
      ),
    );
  }

  return { educationSystemId: educationSystem.id, grades, subjects };
}

// ── One branch's roster + demo data ─────────────────────────────────────────

type PersonDef = { first: string; last: string; email: string; login?: boolean };

type BranchConfig = {
  slug: string;
  name: string;
  themeColor: string;
  manager: PersonDef;
  receptionist: PersonDef;
  teachers: PersonDef[];
  students: PersonDef[];
  roomNames: string[];
  /** R3 — pairs of room indices that can be combined into one bigger room. */
  roomLinks?: [number, number][];
  /** Indices into this branch's own teachers/rooms and the shared catalog's subjects. */
  classDefs: {
    subject: number;
    teacher: number;
    room: number;
    /** R3 — extra rooms combined with `room` (each must be in `roomLinks`). */
    extraRooms?: number[];
    day: number;
    start: string;
    end: string;
    price: number;
    shareType: "FIXED" | "PERCENTAGE";
    shareValue: number;
  }[];
  /** R5 — seed one one-time session and one extra session on a class. */
  manualSessions?: boolean;
};

/**
 * The academic year the demo runs in: September 1st to June 30th, starting
 * this calendar year from August on and last year before it — so "Full
 * year" always contains today (bar July) and the demo has upcoming
 * sessions. Semester 1 runs Sep–Jan, Semester 2 Feb–Jun; the two overlap
 * "Full year", which is exactly the overlap terms are allowed to have.
 */
function demoTerms(today: Date): { name: string; startDate: Date; endDate: Date }[] {
  const year = today.getUTCMonth() >= 7 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
  return [
    { name: "Semester 1", startDate: day(year, 9, 1), endDate: day(year + 1, 1, 31) },
    { name: "Semester 2", startDate: day(year + 1, 2, 1), endDate: day(year + 1, 6, 30) },
    { name: "Full year", startDate: day(year, 9, 1), endDate: day(year + 1, 6, 30) },
  ];
}

/**
 * Fills one branch (Center row) with realistic people, term presets,
 * classes with every session of their period, and payment/attendance
 * history — "seed a realistic demo centre for meetings"
 * (docs/03-build-order.md M10), extended at M18 to run once per branch so
 * the org-level roll-up sums two genuinely different, non-zero branches
 * rather than one branch and an empty sibling. Every write goes through the
 * same real functions the app uses (`createTerm`, `createClassWithSessions`,
 * `createAttendance`, `recordPayment`, `claimStudentCode`), so the demo's
 * money/attendance data is exactly as trustworthy as a real centre's.
 * Idempotent by email/name within the branch.
 */
async function seedBranch(centerId: string, catalog: Catalog, config: BranchConfig) {
  console.log(`\nSeeding ${config.name}…`);

  // Pick every catalog grade + subject into this branch (a centre "picks"
  // from the platform-owned catalog, M13 — it never authors these rows).
  for (const grade of catalog.grades) {
    await prisma.centerCatalogSelection.upsert({
      where: { centerId_kind_gradeId: { centerId, kind: "GRADE", gradeId: grade.id } },
      update: {},
      create: { centerId, kind: "GRADE", gradeId: grade.id },
    });
  }
  for (const subject of catalog.subjects) {
    await prisma.centerCatalogSelection.upsert({
      where: { centerId_kind_subjectId: { centerId, kind: "SUBJECT", subjectId: subject.id } },
      update: {},
      create: { centerId, kind: "SUBJECT", subjectId: subject.id },
    });
  }
  await prisma.centerCatalogSelection.upsert({
    where: {
      centerId_kind_educationSystemId: {
        centerId,
        kind: "EDUCATION_SYSTEM",
        educationSystemId: catalog.educationSystemId,
      },
    },
    update: {},
    create: {
      centerId,
      kind: "EDUCATION_SYSTEM",
      educationSystemId: catalog.educationSystemId,
      basePrice: 0,
    },
  });

  const rooms: { id: string; name: string }[] = [];
  for (const name of config.roomNames) {
    rooms.push(
      await findOrCreateByName(
        `Room: ${name}`,
        () => prisma.room.findFirst({ where: { centerId, name } }),
        () => prisma.room.create({ data: { centerId, name, capacity: 20 } }),
      ),
    );
  }

  // R3 — joinable rooms, through the same writer Settings → Rooms uses
  // (idempotent: an existing link is a no-op).
  for (const [a, b] of config.roomLinks ?? []) {
    await linkRooms(prisma, centerId, rooms[a].id, rooms[b].id);
    console.log(`  + Rooms combinable: ${rooms[a].name} + ${rooms[b].name}`);
  }

  // The first teacher gets a real login so the teacher experience can be
  // tested end to end; the rest stay app-side-only roster filler.
  const teachers = [];
  for (const [index, def] of config.teachers.entries()) {
    const wantsLogin = index === 0;
    const authId = wantsLogin
      ? await ensureAuthUserFor({
          email: def.email,
          password: DEMO_LOGIN_PASSWORD,
          firstName: def.first,
          lastName: def.last,
        })
      : null;
    if (wantsLogin) seededLogins.push({ role: `Teacher (${config.name})`, email: def.email });

    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: authId ? { authId } : {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "en", authId },
    });
    await prisma.membership.upsert({
      where: { userId_centerId_role: { userId: user.id, centerId, role: "TEACHER" } },
      update: {},
      create: {
        userId: user.id,
        centerId,
        role: "TEACHER",
        active: true,
        joinedAt: new Date(),
        firstName: def.first,
        lastName: def.last,
        email: def.email,
      },
    });
    teachers.push(user);
  }

  // Manager + receptionist — both get a real login so centre-staff access
  // can be tested for more than the owner, at each branch.
  for (const [role, def] of [
    ["MANAGER", config.manager],
    ["RECEPTIONIST", config.receptionist],
  ] as const) {
    const authId = await ensureAuthUserFor({
      email: def.email,
      password: DEMO_LOGIN_PASSWORD,
      firstName: def.first,
      lastName: def.last,
    });
    seededLogins.push({
      role: `${role === "MANAGER" ? "Manager" : "Receptionist"} (${config.name})`,
      email: def.email,
    });

    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: authId ? { authId } : {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "en", authId },
    });
    await prisma.membership.upsert({
      where: { userId_centerId_role: { userId: user.id, centerId, role } },
      update: {},
      create: {
        userId: user.id,
        centerId,
        role,
        active: true,
        joinedAt: new Date(),
        firstName: def.first,
        lastName: def.last,
        email: def.email,
      },
    });
  }

  const students: { userId: string; profileId: string }[] = [];
  for (const [index, def] of config.students.entries()) {
    const wantsLogin = index === 0;
    const authId = wantsLogin
      ? await ensureAuthUserFor({
          email: def.email,
          password: DEMO_LOGIN_PASSWORD,
          firstName: def.first,
          lastName: def.last,
        })
      : null;
    if (wantsLogin) seededLogins.push({ role: `Student (${config.name})`, email: def.email });

    const existingUser = await prisma.user.findUnique({ where: { email: def.email } });
    if (existingUser) {
      if (authId && existingUser.authId !== authId) {
        await prisma.user.update({ where: { id: existingUser.id }, data: { authId } });
      }
      const profile = await prisma.studentProfile.findFirst({ where: { userId: existingUser.id, centerId } });
      if (profile) {
        students.push({ userId: existingUser.id, profileId: profile.id });
        continue;
      }
    }
    const { user, profile } = await prisma.$transaction(async (tx) => {
      const user = existingUser ?? (await tx.user.create({
        data: { firstName: def.first, lastName: def.last, email: def.email, locale: "en", authId },
      }));
      const code = await claimStudentCode(tx, centerId);
      const grade = catalog.grades[index % catalog.grades.length];
      const profile = await tx.studentProfile.create({
        data: {
          userId: user.id,
          centerId,
          studentCode: code,
          gradeId: grade.id,
          firstName: def.first,
          lastName: def.last,
          email: def.email,
          // A receptionist filled every field a self-registering student
          // would otherwise complete later (M18, spec §4.3 item 4) — this
          // profile is already whole.
          profileCompletedAt: new Date(),
        },
      });
      return { user, profile };
    });
    students.push({ userId: user.id, profileId: profile.id });
  }
  console.log(`  + ${students.length} demo students (or already present)`);

  // ── Terms (R4): Semester 1, Semester 2 and Full year ─────────────────────
  // Through the real writer (case-insensitive name rule); an existing term
  // of the same name is left as it is.
  const today = dayMarker(new Date().toISOString().slice(0, 10));
  const terms = demoTerms(today);
  for (const term of terms) {
    const result = await createTerm(prisma, centerId, term);
    if (result.ok) console.log(`  + Term: ${term.name} (${dateKey(term.startDate)} – ${dateKey(term.endDate)})`);
  }
  // Every seeded class copies "Full year" — the dates, never a link. Its
  // start reaches back far enough to hold the 4 weeks of history below.
  const fullYear = terms[2];
  const historyStart = addDays(today, -4 * 7);
  const classPeriod = {
    startDate: historyStart < fullYear.startDate ? historyStart : fullYear.startDate,
    endDate: fullYear.endDate,
  };

  // ── Classes: one per definition, each with a single weekly slot ─────────
  // Created through the class-sessions engine, so every session of the
  // period exists from the moment the class does (R4 — no generator). The
  // demo's double-bookings, if any, are confirmed explicitly.
  const classGroups = [];
  for (const def of config.classDefs) {
    const subject = catalog.subjects[def.subject];
    const teacher = teachers[def.teacher];
    const input = {
      teacherId: teacher.id,
      subjectId: subject.id,
      gradeId: subject.gradeId,
      educationSystemId: catalog.educationSystemId,
      roomId: rooms[def.room].id,
      // R3 — a class on a combined room set: its seats are the rooms' sum.
      extraRoomIds: (def.extraRooms ?? []).map((index) => rooms[index].id),
      price: def.price,
      centerShareType: def.shareType,
      centerShareValue: def.shareValue,
      lateThresholdMinutes: 10,
      acceptsNewStudents: true,
      requiresConfirmation: false,
      ...classPeriod,
    };
    const existing = await prisma.classGroup.findFirst({
      where: { centerId, subjectId: subject.id, teacherId: teacher.id },
    });
    if (!existing) {
      const created = await createClassWithSessions(
        prisma,
        centerId,
        { ...input, slots: [{ dayOfWeek: def.day, startTime: def.start, endTime: def.end }] },
        { confirmConflicts: true },
      );
      if (!created.ok) throw new Error(`Class ${subject.nameEn}: ${created.error}`);
      console.log(
        `  + Class: ${subject.nameEn} (${teacher.firstName} ${teacher.lastName}) — ${created.report.created} session(s) for its period`,
      );
    } else {
      // A re-run: bring an older class onto the seeded period (a no-op when
      // it is already there — the resync is idempotent).
      const updated = await updateClassWithSessions(prisma, centerId, existing.id, input, {
        confirmConflicts: true,
      });
      if (!updated.ok) throw new Error(`Class ${subject.nameEn}: ${updated.error}`);
    }
    classGroups.push(
      await prisma.classGroup.findFirstOrThrow({
        where: { centerId, subjectId: subject.id, teacherId: teacher.id },
      }),
    );
  }

  // ── Enrollments: most students in one class, a few in two ───────────────
  let enrollCursor = 0;
  for (const classGroup of classGroups) {
    const roster = [
      students[enrollCursor % students.length],
      students[(enrollCursor + 1) % students.length],
      students[(enrollCursor + 2) % students.length],
    ];
    enrollCursor += 2;
    for (const student of roster) {
      await prisma.enrollment.upsert({
        where: { studentProfileId_classGroupId: { studentProfileId: student.profileId, classGroupId: classGroup.id } },
        update: {},
        create: { centerId, studentProfileId: student.profileId, classGroupId: classGroup.id, status: "ACTIVE" },
      });
    }
  }

  // R3 — upcoming sessions an older seed run created before a class was
  // combined get the class's extra rooms too, so the demo's combined class
  // is combined on every upcoming session. New ones were copied by the
  // class-sessions engine itself.
  for (const [index, def] of config.classDefs.entries()) {
    if (!def.extraRooms?.length) continue;
    const upcoming = await prisma.session.findMany({
      where: {
        centerId,
        classGroupId: classGroups[index].id,
        roomId: rooms[def.room].id,
        date: { gte: today },
        closedAt: null,
      },
      select: { id: true },
    });
    for (const session of upcoming) {
      await writeSessionExtraRooms(
        prisma,
        centerId,
        session.id,
        def.extraRooms.map((roomIndex) => rooms[roomIndex].id),
      );
    }
  }

  // ── Past attendance + payment history (4 weeks back per class) ─────────
  // The class-sessions engine never creates a past session, so history is
  // written directly — through the same createAttendance/recordPayment the
  // app uses, never inventing a shortcut around them (CLAUDE.md rule 2).
  let historyWritten = 0;
  // The branch's first active method (Cash, for a seeded branch) — history
  // goes through the real `recordPayment`, which freezes its label.
  const [historyMethod] = await listActivePaymentMethods(prisma, centerId);
  if (!historyMethod) throw new Error(`${config.name} has no active payment method`);
  for (const classGroup of classGroups) {
    const schedule = await prisma.classSchedule.findFirst({ where: { centerId, classGroupId: classGroup.id } });
    if (!schedule) continue;
    const roster = await prisma.enrollment.findMany({ where: { centerId, classGroupId: classGroup.id, status: "ACTIVE" } });
    if (roster.length === 0) continue;

    for (let weeksAgo = 4; weeksAgo >= 1; weeksAgo--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - weeksAgo * 7);
      date.setUTCHours(0, 0, 0, 0);

      const existingSession = await prisma.session.findFirst({
        where: { centerId, classGroupId: classGroup.id, date, startTime: schedule.startTime },
      });
      const session =
        existingSession ??
        (await prisma.session.create({
          data: {
            centerId,
            classGroupId: classGroup.id,
            teacherId: classGroup.teacherId,
            roomId: classGroup.roomId,
            date,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            status: "COMPLETED",
            priceSnapshot: classGroup.price,
          },
        }));
      if (existingSession) continue; // history for this session already written

      for (let i = 0; i < roster.length; i++) {
        const enrollment = roster[i];
        // The first student in the first class's roster demos "3 in a row" —
        // otherwise mostly PRESENT with an occasional LATE, so analytics has
        // varied, plausible numbers rather than a suspiciously perfect 100%.
        const isConsecutiveAbsenceDemo = classGroup.id === classGroups[0]?.id && i === 0;
        const status = isConsecutiveAbsenceDemo
          ? "ABSENT"
          : (i + weeksAgo) % 7 === 0
            ? "ABSENT"
            : (i + weeksAgo) % 5 === 0
              ? "LATE"
              : "PRESENT";

        const attendee = await createAttendance(prisma, {
          centerId,
          sessionId: session.id,
          studentProfileId: enrollment.studentProfileId,
          enrollmentId: enrollment.id,
          isDropIn: false,
          recordedBy: classGroup.teacherId,
        }, { historicalBackfill: true, status });
        historyWritten++;

        if (status === "PRESENT" || status === "LATE") {
          await prisma.$transaction((tx) =>
            recordPayment(tx, centerId, attendee.id, historyMethod.id, classGroup.teacherId, { historicalBackfill: true }),
          );
        }
      }
    }
  }
  console.log(`  + ${historyWritten} historical attendance record(s) with payments, over the past 4 weeks`);

  // The history above is written with `historicalBackfill` (R2 — those
  // sessions' days have ended, so the live write path would refuse them).
  // Close them now, the same lazy end-of-day close the app performs on its
  // next touch, so their receipts render as the closed records they are.
  const closedHistory = await closeEndedSessions(prisma, centerId);
  console.log(`  + ${closedHistory} past session(s) closed (automatic end-of-day close)`);

  // ── R5: a one-time session tomorrow and an extra session on a class ─────
  // Through the real writers (`createOneOffSession`/`createManualSession`),
  // so both are `isManual`, audited and conflict-checked like the app's own.
  // Skipped on a re-run when they already exist.
  if (config.manualSessions) {
    const tomorrow = addDays(today, 1);
    const title = "Exam revision day";
    const hasOneOff = await prisma.session.count({ where: { centerId, classGroupId: null, title } });
    if (hasOneOff === 0) {
      const settings = await prisma.centerSettings.findUnique({ where: { centerId } });
      const subject = catalog.subjects[config.classDefs[0].subject];
      const created = await createOneOffSession(
        prisma,
        centerId,
        {
          title,
          subjectId: subject.id,
          gradeId: subject.gradeId,
          teacherId: teachers[0].id,
          roomId: rooms[0].id,
          extraRoomIds: [],
          date: tomorrow,
          startTime: "19:00",
          endTime: "21:00",
          price: 15_000,
          centerShareType: settings?.defaultShareType ?? "PERCENTAGE",
          centerShareValue: settings?.defaultShareValue ?? 15,
        },
        { confirmConflicts: true },
      );
      if (!created.ok) throw new Error(`One-time session: ${created.error}`);
      console.log(`  + One-time session: "${title}" on ${dateKey(tomorrow)}`);
    }
    const extraClass = classGroups[0];
    const hasExtra = await prisma.session.count({ where: { centerId, classGroupId: extraClass.id, isManual: true } });
    if (hasExtra === 0 && extraClass.roomId) {
      const extraDate = addDays(today, 2);
      const extraRoomIds = (
        await prisma.classGroupRoom.findMany({ where: { centerId, classGroupId: extraClass.id }, select: { roomId: true } })
      ).map((row) => row.roomId);
      const created = await createManualSession(
        prisma,
        centerId,
        {
          classGroupId: extraClass.id,
          teacherId: extraClass.teacherId,
          roomId: extraClass.roomId,
          extraRoomIds,
          date: extraDate,
          startTime: "10:00",
          endTime: "11:30",
        },
        { confirmConflicts: true },
      );
      if (!created.ok) throw new Error(`Extra session: ${created.error}`);
      console.log(`  + Extra session on the first class: ${dateKey(extraDate)} 10:00–11:30`);
    }
  }

  // ── A couple of expense categories + entries, for the Analytics demo ───
  const rentCategory = await findOrCreateByName(
    "Expense category: Rent",
    () => prisma.expenseCategory.findFirst({ where: { centerId, name: "Rent" } }),
    () => prisma.expenseCategory.create({ data: { centerId, name: "Rent" } }),
  );
  const suppliesCategory = await findOrCreateByName(
    "Expense category: Supplies",
    () => prisma.expenseCategory.findFirst({ where: { centerId, name: "Supplies" } }),
    () => prisma.expenseCategory.create({ data: { centerId, name: "Supplies" } }),
  );
  const existingExpenses = await prisma.expense.count({ where: { centerId } });
  if (existingExpenses === 0) {
    const lastWeek = new Date();
    lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
    await prisma.expense.createMany({
      data: [
        { centerId, categoryId: rentCategory.id, amount: 500_000, date: lastWeek, note: "Monthly rent", recordedBy: "seed" },
        { centerId, categoryId: suppliesCategory.id, amount: 35_000, date: lastWeek, note: "Office supplies", recordedBy: "seed" },
      ],
    });
    console.log("  + 2 demo expenses");
  }
}

// ── The two branches of "Center 60" ─────────────────────────────────────────

const BRANCH_A: BranchConfig = {
  slug: "center-60-downtown",
  name: "Center 60 — Downtown",
  manualSessions: true,
  themeColor: "#2563EB",
  manager: { first: "Olivia", last: "Bennett", email: "demo-manager-downtown@center60-demo.test" },
  receptionist: { first: "Daniel", last: "Carter", email: "demo-receptionist-downtown@center60-demo.test" },
  teachers: [
    { first: "Michael", last: "Turner", email: "demo-teacher1-downtown@center60-demo.test" },
    { first: "Emily", last: "Clarke", email: "demo-teacher2-downtown@center60-demo.test" },
    { first: "Robert", last: "Bailey", email: "demo-teacher3-downtown@center60-demo.test" },
    { first: "Sophia", last: "Mitchell", email: "demo-teacher4-downtown@center60-demo.test" },
  ],
  students: [
    { first: "Ethan", last: "Brooks", email: "demo-student1-downtown@center60-demo.test" },
    { first: "Ava", last: "Foster", email: "demo-student2-downtown@center60-demo.test" },
    { first: "Liam", last: "Coleman", email: "demo-student3-downtown@center60-demo.test" },
    { first: "Mia", last: "Sanders", email: "demo-student4-downtown@center60-demo.test" },
    { first: "Noah", last: "Reynolds", email: "demo-student5-downtown@center60-demo.test" },
    { first: "Grace", last: "Palmer", email: "demo-student6-downtown@center60-demo.test" },
    { first: "Lucas", last: "Barrett", email: "demo-student7-downtown@center60-demo.test" },
    { first: "Chloe", last: "Hayes", email: "demo-student8-downtown@center60-demo.test" },
    { first: "Mason", last: "Wood", email: "demo-student9-downtown@center60-demo.test" },
    { first: "Zoe", last: "Fisher", email: "demo-student10-downtown@center60-demo.test" },
    { first: "Benjamin", last: "Reed", email: "demo-student11-downtown@center60-demo.test" },
    { first: "Lily", last: "Cooper", email: "demo-student12-downtown@center60-demo.test" },
    { first: "Jack", last: "Morrison", email: "demo-student13-downtown@center60-demo.test" },
    { first: "Ella", last: "Simmons", email: "demo-student14-downtown@center60-demo.test" },
    { first: "Henry", last: "Douglas", email: "demo-student15-downtown@center60-demo.test" },
    { first: "Amelia", last: "Ross", email: "demo-student16-downtown@center60-demo.test" },
    { first: "Owen", last: "Fletcher", email: "demo-student17-downtown@center60-demo.test" },
    { first: "Isla", last: "Watson", email: "demo-student18-downtown@center60-demo.test" },
    { first: "Leo", last: "Graham", email: "demo-student19-downtown@center60-demo.test" },
    { first: "Nora", last: "Stevens", email: "demo-student20-downtown@center60-demo.test" },
  ],
  roomNames: ["Room 1", "Room 2", "Room 3"],
  // R3 — Room 1 + Room 2 can be joined; the first class runs on both (40 seats).
  roomLinks: [[0, 1]],
  classDefs: [
    { subject: 0, teacher: 0, room: 0, extraRooms: [1], day: 0, start: "16:00", end: "18:00", price: 15_000, shareType: "PERCENTAGE", shareValue: 15 },
    { subject: 1, teacher: 1, room: 1, day: 1, start: "16:00", end: "18:00", price: 18_000, shareType: "FIXED", shareValue: 4_000 },
    { subject: 2, teacher: 1, room: 2, day: 2, start: "16:00", end: "18:00", price: 16_000, shareType: "PERCENTAGE", shareValue: 20 },
    { subject: 3, teacher: 2, room: 0, day: 3, start: "17:00", end: "18:30", price: 12_000, shareType: "PERCENTAGE", shareValue: 10 },
    { subject: 4, teacher: 3, room: 1, day: 4, start: "17:00", end: "18:30", price: 14_000, shareType: "PERCENTAGE", shareValue: 15 },
  ],
};

const BRANCH_B: BranchConfig = {
  slug: "center-60-nasr-city",
  name: "Center 60 — Nasr City",
  themeColor: "#2563EB",
  manager: { first: "Rachel", last: "Thompson", email: "demo-manager-nasrcity@center60-demo.test" },
  receptionist: { first: "Tyler", last: "Morgan", email: "demo-receptionist-nasrcity@center60-demo.test" },
  teachers: [
    { first: "David", last: "Mitchell", email: "demo-teacher1-nasrcity@center60-demo.test" },
    { first: "Laura", last: "Bennett", email: "demo-teacher2-nasrcity@center60-demo.test" },
  ],
  students: [
    { first: "Aiden", last: "Parker", email: "demo-student1-nasrcity@center60-demo.test" },
    { first: "Ruby", last: "Hughes", email: "demo-student2-nasrcity@center60-demo.test" },
    { first: "Caleb", last: "Price", email: "demo-student3-nasrcity@center60-demo.test" },
    { first: "Layla", last: "Simpson", email: "demo-student4-nasrcity@center60-demo.test" },
    { first: "Nathan", last: "Cross", email: "demo-student5-nasrcity@center60-demo.test" },
    { first: "Hannah", last: "Marsh", email: "demo-student6-nasrcity@center60-demo.test" },
    { first: "Oliver", last: "Grant", email: "demo-student7-nasrcity@center60-demo.test" },
    { first: "Sofia", last: "Dunn", email: "demo-student8-nasrcity@center60-demo.test" },
    { first: "Wyatt", last: "Chapman", email: "demo-student9-nasrcity@center60-demo.test" },
    { first: "Emma", last: "Pierce", email: "demo-student10-nasrcity@center60-demo.test" },
  ],
  roomNames: ["Room A", "Room B"],
  classDefs: [
    { subject: 0, teacher: 0, room: 0, day: 0, start: "15:00", end: "17:00", price: 15_000, shareType: "PERCENTAGE", shareValue: 15 },
    { subject: 4, teacher: 1, room: 1, day: 2, start: "16:00", end: "17:30", price: 17_000, shareType: "FIXED", shareValue: 4_000 },
    { subject: 5, teacher: 1, room: 0, day: 3, start: "17:00", end: "18:30", price: 16_000, shareType: "PERCENTAGE", shareValue: 20 },
  ],
};

async function main() {
  const organization = await findOrCreateByName(
    `Organization: ${ORG_NAME}`,
    () => prisma.organization.findFirst({ where: { name: ORG_NAME } }),
    () => prisma.organization.create({ data: { name: ORG_NAME, nameEn: ORG_NAME } }),
  );

  const branchConfigs = [BRANCH_A, BRANCH_B];
  const branches = [];
  for (const config of branchConfigs) {
    const center = await prisma.center.upsert({
      where: { slug: config.slug },
      update: { name: config.name, themeColor: config.themeColor, lifecycleState: "ACTIVE" },
      create: {
        slug: config.slug,
        name: config.name,
        nameEn: config.name,
        themeColor: config.themeColor,
        lifecycleState: "ACTIVE",
        organizationId: organization.id,
      },
    });

    // Defaults come from docs/01-data-model.md: percentage cut, 15%, Cairo time.
    const settings = await prisma.centerSettings.upsert({
      where: { centerId: center.id },
      update: {},
      create: {
        centerId: center.id,
        defaultShareType: "PERCENTAGE",
        defaultShareValue: 15,
        defaultLateThreshold: 10,
        teacherTimeoutDays: 30,
        timezone: "Africa/Cairo",
      },
    });

    // R1: Cash / InstaPay / Vodafone Cash, only if the branch has none yet.
    await ensureDefaultPaymentMethods(prisma, center.id);

    console.log(`Branch          ${center.name} (${center.slug}) — ${center.id}`);
    console.log(`  Settings      share ${settings.defaultShareType} ${settings.defaultShareValue}`);
    branches.push({ center, config });
  }

  const catalog = await ensureGlobalCatalog();

  if (process.env.SEED_DEMO_DATA !== "false") {
    for (const { center, config } of branches) {
      await seedBranch(center.id, catalog, config);
    }
  }

  // The Owner's real membership names one "home" branch (M11) — they resolve
  // to every sibling branch under the same organization at read time
  // (`getUserCenterRelations`), never via a second row here.
  const authId = await ensureAuthUserFor({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    firstName: OWNER_FIRST_NAME,
    lastName: OWNER_LAST_NAME,
  });

  const owner = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: authId ? { authId } : {},
    create: {
      email: OWNER_EMAIL,
      firstName: OWNER_FIRST_NAME,
      lastName: OWNER_LAST_NAME,
      phone: OWNER_PHONE,
      locale: "en",
      authId,
    },
  });

  const homeBranch = branches[0].center;
  const existingMembership = await prisma.membership.findFirst({
    where: { userId: owner.id, centerId: homeBranch.id, role: "OWNER" },
  });

  const membership =
    existingMembership ??
    (await prisma.membership.create({
      data: {
        userId: owner.id,
        centerId: homeBranch.id,
        role: "OWNER",
        active: true,
        joinedAt: new Date(),
      },
    }));

  console.log(`\nOrganization    ${organization.name} (${branches.length} branches) — ${organization.id}`);
  console.log(`Owner           ${OWNER_EMAIL} — membership ${membership.id} (home branch: ${homeBranch.name})`);
  console.log("");

  if (authId) {
    console.log(`Password for every account below: ${OWNER_PASSWORD}`);
    console.log("Sign in at /en/login with any of:");
    console.log(`  Owner         ${OWNER_EMAIL}`);
    for (const login of seededLogins) {
      console.log(`  ${login.role.padEnd(28)}  ${login.email}`);
    }
    console.log("These are development credentials — change them before any real use.");
  } else {
    console.log("SUPABASE_SERVICE_ROLE_KEY is not set, so no Auth users were created.");
    console.log("Create them manually: Supabase dashboard → Authentication → Users →");
    console.log(`Add user → ${OWNER_EMAIL}, and any of these to test other roles (tick \"Auto Confirm User\"):`);
    for (const login of seededLogins) {
      console.log(`  ${login.role.padEnd(28)}  ${login.email}`);
    }
    console.log("The User mirror links each to its Auth user by email on first login.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
