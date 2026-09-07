/**
 * Seed: one center, its CenterSettings, and one owner (M1), plus a demo
 * roster with one login per role so every experience (center, teacher,
 * student) can be signed into and tested (M10).
 *
 * Run with:  npm run db:seed
 *
 * If SUPABASE_SERVICE_ROLE_KEY is set, this also creates the matching
 * **Supabase Auth** user (email confirmed) for the owner, the manager, the
 * receptionist, the first demo teacher, and the first demo student — all
 * sharing the owner's password — and links each to its User row so they can
 * sign in immediately. Without that key it creates the app-side Users only —
 * the mirror in lib/auth/session.ts then links each by email on first login.
 *
 * Override the defaults with env vars:
 *   SEED_CENTER_NAME, SEED_CENTER_SLUG, SEED_CENTER_THEME,
 *   SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD,
 *   SEED_OWNER_FIRST_NAME, SEED_OWNER_LAST_NAME, SEED_OWNER_PHONE
 */
import { PrismaClient, type CatalogGrade } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { generateSessions } from "../lib/db/sessions.ts";
import { claimStudentCode } from "../lib/db/students.ts";

const prisma = new PrismaClient();

const CENTER_NAME = process.env.SEED_CENTER_NAME ?? "مركز النور التعليمي";
const CENTER_SLUG = process.env.SEED_CENTER_SLUG ?? "al-noor";
const CENTER_THEME = process.env.SEED_CENTER_THEME ?? "#2563EB";
const OWNER_EMAIL = (process.env.SEED_OWNER_EMAIL ?? "owner@kayedu.test")
  .trim()
  .toLowerCase();
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "KayEdu!Dev123";
const OWNER_FIRST_NAME = process.env.SEED_OWNER_FIRST_NAME ?? "محمد";
const OWNER_LAST_NAME = process.env.SEED_OWNER_LAST_NAME ?? "الكيالي";
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
    user_metadata: { first_name: firstName, last_name: lastName, locale: "ar" },
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

/**
 * Fills the seeded center with realistic reference data, people, classes,
 * a forward session window, and payment/attendance history — "seed a
 * realistic demo center for meetings" (docs/03-build-order.md M10). Every
 * write here goes through the same real functions the app uses
 * (`generateSessions`, `createAttendance`, `recordPayment`, `claimStudentCode`)
 * so the demo's money/attendance data is exactly as trustworthy as a real
 * center's — never a shortcut that fabricates numbers. Idempotent by name
 * within the center, so re-running `db:seed` does not duplicate rows.
 *
 * Skip with `SEED_DEMO_DATA=false` for a bare owner-only seed.
 */
async function seedDemoData(centerId: string) {
  console.log("\nSeeding demo reference data, people, classes and history…");

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

  // Education systems/grades/subjects are the platform-owned global catalog
  // as of M13 — this centre picks from it via CenterCatalogSelection rather
  // than authoring its own rows. `findOrCreateByName` still keeps the seed
  // idempotent: the catalog rows are looked up (and created once) globally,
  // by name, with no centerId at all; the selection rows below are what's
  // actually centre-scoped.
  const educationSystem = await findOrCreateByName(
    "Catalog education system: الثانوية العامة",
    () => prisma.catalogEducationSystem.findFirst({ where: { nameAr: "الثانوية العامة" } }),
    () =>
      prisma.catalogEducationSystem.create({
        data: { nameAr: "الثانوية العامة", nameEn: "General Secondary", defaultFixedCenterShare: 0 },
      }),
  );
  await prisma.centerCatalogSelection.upsert({
    where: {
      centerId_kind_educationSystemId: {
        centerId,
        kind: "EDUCATION_SYSTEM",
        educationSystemId: educationSystem.id,
      },
    },
    update: {},
    create: {
      centerId,
      kind: "EDUCATION_SYSTEM",
      educationSystemId: educationSystem.id,
      basePrice: 0,
    },
  });

  const gradeDefs = [
    { ar: "الصف الأول الثانوي", en: "Grade 10" },
    { ar: "الصف الثاني الثانوي", en: "Grade 11" },
    { ar: "الصف الثالث الثانوي", en: "Grade 12" },
  ];
  const grades: CatalogGrade[] = [];
  for (const def of gradeDefs) {
    const grade = await findOrCreateByName(
      `Catalog grade: ${def.ar}`,
      () => prisma.catalogGrade.findFirst({ where: { nameAr: def.ar } }),
      () =>
        prisma.catalogGrade.create({
          data: { nameAr: def.ar, nameEn: def.en, educationSystemId: educationSystem.id },
        }),
    );
    grades.push(grade);
    await prisma.centerCatalogSelection.upsert({
      where: { centerId_kind_gradeId: { centerId, kind: "GRADE", gradeId: grade.id } },
      update: {},
      create: { centerId, kind: "GRADE", gradeId: grade.id },
    });
  }

  const subjectDefs = [
    { ar: "رياضيات", en: "Mathematics", gradeIndex: 0 },
    { ar: "فيزياء", en: "Physics", gradeIndex: 1 },
    { ar: "كيمياء", en: "Chemistry", gradeIndex: 1 },
    { ar: "لغة عربية", en: "Arabic", gradeIndex: 0 },
    { ar: "لغة إنجليزية", en: "English", gradeIndex: 2 },
  ];
  const subjects = [];
  for (const def of subjectDefs) {
    const subject = await findOrCreateByName(
      `Catalog subject: ${def.ar}`,
      () => prisma.catalogSubject.findFirst({ where: { nameAr: def.ar } }),
      () =>
        prisma.catalogSubject.create({
          data: { nameAr: def.ar, nameEn: def.en, gradeId: grades[def.gradeIndex].id },
        }),
    );
    subjects.push(subject);
    await prisma.centerCatalogSelection.upsert({
      where: { centerId_kind_subjectId: { centerId, kind: "SUBJECT", subjectId: subject.id } },
      update: {},
      create: { centerId, kind: "SUBJECT", subjectId: subject.id },
    });
  }

  const roomNames = ["قاعة 1", "قاعة 2", "قاعة 3"];
  const rooms = [];
  for (const name of roomNames) {
    rooms.push(
      await findOrCreateByName(
        `Room: ${name}`,
        () => prisma.room.findFirst({ where: { centerId, name } }),
        () => prisma.room.create({ data: { centerId, name, capacity: 20 } }),
      ),
    );
  }

  // The first teacher gets a real login so the teacher experience can be
  // tested end to end; the rest stay app-side-only roster filler.
  const teacherDefs = [
    { first: "أحمد", last: "حسن", email: "demo-teacher1@alnoor-demo.test", login: true },
    { first: "منى", last: "سليم", email: "demo-teacher2@alnoor-demo.test" },
    { first: "خالد", last: "عبدالله", email: "demo-teacher3@alnoor-demo.test" },
    { first: "سارة", last: "يوسف", email: "demo-teacher4@alnoor-demo.test" },
  ];
  const teachers = [];
  for (const def of teacherDefs) {
    const authId = def.login
      ? await ensureAuthUserFor({
          email: def.email,
          password: DEMO_LOGIN_PASSWORD,
          firstName: def.first,
          lastName: def.last,
        })
      : null;
    if (def.login) seededLogins.push({ role: "Teacher", email: def.email });

    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: authId ? { authId } : {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "ar", authId },
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

  // A manager and a receptionist for role variety in the demo — both get a
  // real login so center-staff access can be tested for more than the owner.
  const staffDefs = [
    { first: "ليلى", last: "مراد", email: "demo-manager@alnoor-demo.test", role: "MANAGER" as const },
    { first: "عمر", last: "فتحي", email: "demo-receptionist@alnoor-demo.test", role: "RECEPTIONIST" as const },
  ];
  for (const def of staffDefs) {
    const authId = await ensureAuthUserFor({
      email: def.email,
      password: DEMO_LOGIN_PASSWORD,
      firstName: def.first,
      lastName: def.last,
    });
    seededLogins.push({
      role: def.role === "MANAGER" ? "Manager" : "Receptionist",
      email: def.email,
    });

    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: authId ? { authId } : {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "ar", authId },
    });
    await prisma.membership.upsert({
      where: { userId_centerId_role: { userId: user.id, centerId, role: def.role } },
      update: {},
      create: {
        userId: user.id,
        centerId,
        role: def.role,
        active: true,
        joinedAt: new Date(),
        firstName: def.first,
        lastName: def.last,
        email: def.email,
      },
    });
  }

  const studentFirstNames = [
    "يوسف", "زينب", "عمر", "نور", "حمزة", "ملك", "علي", "جنى", "مصطفى", "هنا",
    "كريم", "روان", "طارق", "لمى", "زياد", "دينا", "بلال", "رنا", "سيف", "ياسمين",
  ];
  const students: { userId: string; profileId: string }[] = [];
  for (let i = 0; i < studentFirstNames.length; i++) {
    const email = `demo-student${i + 1}@alnoor-demo.test`;
    // Only the first student gets a real login, to test the student portal.
    const wantsLogin = i === 0;
    const authId = wantsLogin
      ? await ensureAuthUserFor({
          email,
          password: DEMO_LOGIN_PASSWORD,
          firstName: studentFirstNames[i],
          lastName: "الطالب",
        })
      : null;
    if (wantsLogin) seededLogins.push({ role: "Student", email });

    const existingUser = await prisma.user.findUnique({ where: { email } });
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
        data: { firstName: studentFirstNames[i], lastName: "الطالب", email, locale: "ar", authId },
      }));
      const code = await claimStudentCode(tx, centerId);
      const gradeForStudent = grades[i % grades.length];
      const profile = await tx.studentProfile.create({
        data: {
          userId: user.id,
          centerId,
          studentCode: code,
          gradeId: gradeForStudent.id,
          firstName: studentFirstNames[i],
          lastName: "الطالب",
          email,
        },
      });
      return { user, profile };
    });
    students.push({ userId: user.id, profileId: profile.id });
  }
  console.log(`  + ${students.length} demo students (or already present)`);

  // ── Classes: one per subject, each with a single weekly slot ────────────
  const classDefs = [
    { subject: 0, teacher: 0, room: 0, day: 0, start: "16:00", end: "18:00", price: 15_000, shareType: "PERCENTAGE" as const, shareValue: 15 },
    { subject: 1, teacher: 1, room: 1, day: 1, start: "16:00", end: "18:00", price: 18_000, shareType: "FIXED" as const, shareValue: 2_000 },
    { subject: 2, teacher: 1, room: 2, day: 2, start: "16:00", end: "18:00", price: 16_000, shareType: "PERCENTAGE" as const, shareValue: 20 },
    { subject: 3, teacher: 2, room: 0, day: 3, start: "17:00", end: "18:30", price: 12_000, shareType: "PERCENTAGE" as const, shareValue: 10 },
    { subject: 4, teacher: 3, room: 1, day: 4, start: "17:00", end: "18:30", price: 14_000, shareType: "PERCENTAGE" as const, shareValue: 15 },
  ];

  const classGroups = [];
  for (const def of classDefs) {
    const subject = subjects[def.subject];
    const teacher = teachers[def.teacher];
    let classGroup = await prisma.classGroup.findFirst({
      where: { centerId, subjectId: subject.id, teacherId: teacher.id },
    });
    if (!classGroup) {
      classGroup = await prisma.classGroup.create({
        data: {
          centerId,
          teacherId: teacher.id,
          subjectId: subject.id,
          gradeId: subject.gradeId,
          educationSystemId: educationSystem.id,
          roomId: rooms[def.room].id,
          price: def.price,
          centerShareType: def.shareType,
          centerShareValue: def.shareValue,
          capacity: 20,
        },
      });
      await prisma.classSchedule.create({
        data: {
          centerId,
          classGroupId: classGroup.id,
          dayOfWeek: def.day,
          startTime: def.start,
          endTime: def.end,
        },
      });
      console.log(`  + Class: ${subject.nameEn} (${teacher.firstName} ${teacher.lastName})`);
    }
    classGroups.push(classGroup);
  }

  // ── Enrollments: most students in one class, a few in two ───────────────
  let enrollCursor = 0;
  for (const classGroup of classGroups) {
    const roster = [students[enrollCursor % students.length], students[(enrollCursor + 1) % students.length], students[(enrollCursor + 2) % students.length]];
    enrollCursor += 2;
    for (const student of roster) {
      await prisma.enrollment.upsert({
        where: { studentProfileId_classGroupId: { studentProfileId: student.profileId, classGroupId: classGroup.id } },
        update: {},
        create: { centerId, studentProfileId: student.profileId, classGroupId: classGroup.id, status: "ACTIVE" },
      });
    }
  }

  // ── Forward rolling window (docs §11) — the real generator, unmodified ──
  const generated = await generateSessions(prisma, centerId, "WARN");
  console.log(`  + ${generated.created} upcoming session(s) generated for the next 6 weeks`);

  // ── Past attendance + payment history (4 weeks back per class) ─────────
  // generateSessions only ever looks forward, so history is written
  // directly — through the same createAttendance/recordPayment the app
  // uses, never inventing a shortcut around them (CLAUDE.md rule 2).
  let historyWritten = 0;
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
          status,
          recordedBy: classGroup.teacherId,
        });
        historyWritten++;

        if (status === "PRESENT" || status === "LATE") {
          await prisma.$transaction((tx) =>
            recordPayment(tx, centerId, attendee.id, "CASH", classGroup.teacherId),
          );
        }
      }
    }
  }
  console.log(`  + ${historyWritten} historical attendance record(s) with payments, over the past 4 weeks`);

  // ── A couple of expense categories + entries, for the Analytics demo ───
  const rentCategory = await findOrCreateByName(
    "Expense category: إيجار",
    () => prisma.expenseCategory.findFirst({ where: { centerId, name: "إيجار" } }),
    () => prisma.expenseCategory.create({ data: { centerId, name: "إيجار" } }),
  );
  const suppliesCategory = await findOrCreateByName(
    "Expense category: مستلزمات",
    () => prisma.expenseCategory.findFirst({ where: { centerId, name: "مستلزمات" } }),
    () => prisma.expenseCategory.create({ data: { centerId, name: "مستلزمات" } }),
  );
  const existingExpenses = await prisma.expense.count({ where: { centerId } });
  if (existingExpenses === 0) {
    const lastWeek = new Date();
    lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
    await prisma.expense.createMany({
      data: [
        { centerId, categoryId: rentCategory.id, amount: 500_000, date: lastWeek, note: "إيجار الشهر", recordedBy: "seed" },
        { centerId, categoryId: suppliesCategory.id, amount: 35_000, date: lastWeek, note: "أدوات مكتبية", recordedBy: "seed" },
      ],
    });
    console.log("  + 2 demo expenses");
  }
}

async function main() {
  const center = await prisma.center.upsert({
    where: { slug: CENTER_SLUG },
    update: { name: CENTER_NAME, themeColor: CENTER_THEME, active: true },
    create: {
      slug: CENTER_SLUG,
      name: CENTER_NAME,
      nameEn: "Al-Noor Education Center",
      themeColor: CENTER_THEME,
      active: true,
      plan: "pilot",
      // One organization per seeded center (M11) — a single-branch org, the
      // same shape the migration's backfill gave every pre-existing center.
      organization: {
        create: { name: CENTER_NAME, nameEn: "Al-Noor Education Center" },
      },
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

  console.log("Seed complete:");
  console.log(`  Center       ${center.name} (${center.slug}) — ${center.id}`);
  console.log(
    `  Settings     share ${settings.defaultShareType} ${settings.defaultShareValue}`,
  );

  if (process.env.SEED_DEMO_DATA !== "false") {
    await seedDemoData(center.id);
  }

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
      locale: "ar",
      authId,
    },
  });

  const existingMembership = await prisma.membership.findFirst({
    where: { userId: owner.id, centerId: center.id, role: "OWNER" },
  });

  const membership =
    existingMembership ??
    (await prisma.membership.create({
      data: {
        userId: owner.id,
        centerId: center.id,
        role: "OWNER",
        active: true,
        joinedAt: new Date(),
      },
    }));

  console.log(`  Owner        ${OWNER_EMAIL} — membership ${membership.id}`);
  console.log("");

  if (authId) {
    console.log(`Password for every account below: ${OWNER_PASSWORD}`);
    console.log("Sign in at /en/login with any of:");
    console.log(`  Owner         ${OWNER_EMAIL}`);
    for (const login of seededLogins) {
      console.log(`  ${login.role.padEnd(12)}  ${login.email}`);
    }
    console.log("These are development credentials — change them before any real use.");
  } else {
    console.log("SUPABASE_SERVICE_ROLE_KEY is not set, so no Auth users were created.");
    console.log("Create them manually: Supabase dashboard → Authentication → Users →");
    console.log(`Add user → ${OWNER_EMAIL}, and any of these to test other roles (tick \"Auto Confirm User\"):`);
    for (const login of seededLogins) {
      console.log(`  ${login.role.padEnd(12)}  ${login.email}`);
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
