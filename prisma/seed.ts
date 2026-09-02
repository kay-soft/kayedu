/**
 * Seed: one center, its CenterSettings, and one owner (M1).
 *
 * Run with:  npm run db:seed
 *
 * If SUPABASE_SERVICE_ROLE_KEY is set, this also creates the matching
 * **Supabase Auth** user (email confirmed) and links it to the User row, so the
 * owner can sign in immediately. Without that key it creates the app-side User
 * only — the mirror in lib/auth/session.ts then links by email on first login.
 *
 * Override the defaults with env vars:
 *   SEED_CENTER_NAME, SEED_CENTER_SLUG, SEED_CENTER_THEME,
 *   SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD,
 *   SEED_OWNER_FIRST_NAME, SEED_OWNER_LAST_NAME, SEED_OWNER_PHONE
 */
import { PrismaClient, type Grade } from "@prisma/client";
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

/**
 * Creates (or finds) the Supabase Auth user for the owner and returns its id.
 * Returns null when the service-role key isn't configured.
 */
async function ensureAuthUser(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || serviceRoleKey.startsWith("[")) {
    return null;
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    user_metadata: {
      first_name: OWNER_FIRST_NAME,
      last_name: OWNER_LAST_NAME,
      locale: "ar",
    },
  });

  if (!error && data.user) {
    console.log(`  Auth user    created — password: ${OWNER_PASSWORD}`);
    return data.user.id;
  }

  // Already registered: find the existing auth user instead of failing.
  for (let page = 1; page <= 10; page += 1) {
    const { data: list, error: listError } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (listError) throw listError;

    const match = list.users.find(
      (user) => user.email?.toLowerCase() === OWNER_EMAIL,
    );
    if (match) {
      console.log("  Auth user    already existed — password unchanged");
      return match.id;
    }
    if (list.users.length < 200) break;
  }

  throw error ?? new Error(`Could not create or find auth user ${OWNER_EMAIL}`);
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
async function seedDemoData(centerId: string, branchId: string) {
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

  const educationSystem = await findOrCreateByName(
    "Education system: الثانوية العامة",
    () => prisma.educationSystem.findFirst({ where: { centerId, name: "الثانوية العامة" } }),
    () => prisma.educationSystem.create({ data: { centerId, name: "الثانوية العامة", basePrice: 0 } }),
  );

  const gradeNames = ["الصف الأول الثانوي", "الصف الثاني الثانوي", "الصف الثالث الثانوي"];
  const grades: Grade[] = [];
  for (const name of gradeNames) {
    grades.push(
      await findOrCreateByName(
        `Grade: ${name}`,
        () => prisma.grade.findFirst({ where: { centerId, name } }),
        () => prisma.grade.create({ data: { centerId, name, educationSystemId: educationSystem.id } }),
      ),
    );
  }

  const subjectDefs = [
    { name: "رياضيات", gradeIndex: 0 },
    { name: "فيزياء", gradeIndex: 1 },
    { name: "كيمياء", gradeIndex: 1 },
    { name: "لغة عربية", gradeIndex: 0 },
    { name: "لغة إنجليزية", gradeIndex: 2 },
  ];
  const subjects = [];
  for (const def of subjectDefs) {
    subjects.push(
      await findOrCreateByName(
        `Subject: ${def.name}`,
        () => prisma.subject.findFirst({ where: { centerId, name: def.name } }),
        () => prisma.subject.create({ data: { centerId, name: def.name, gradeId: grades[def.gradeIndex].id } }),
      ),
    );
  }

  const roomNames = ["قاعة 1", "قاعة 2", "قاعة 3"];
  const rooms = [];
  for (const name of roomNames) {
    rooms.push(
      await findOrCreateByName(
        `Room: ${name}`,
        () => prisma.room.findFirst({ where: { centerId, name } }),
        () => prisma.room.create({ data: { centerId, branchId, name, capacity: 20 } }),
      ),
    );
  }

  const teacherDefs = [
    { first: "أحمد", last: "حسن", email: "demo-teacher1@alnoor-demo.test" },
    { first: "منى", last: "سليم", email: "demo-teacher2@alnoor-demo.test" },
    { first: "خالد", last: "عبدالله", email: "demo-teacher3@alnoor-demo.test" },
    { first: "سارة", last: "يوسف", email: "demo-teacher4@alnoor-demo.test" },
  ];
  const teachers = [];
  for (const def of teacherDefs) {
    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "ar" },
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

  // A manager and a receptionist for role variety in the demo — app-side
  // only (no Auth user), the same as any staff member who has not yet
  // accepted their invite; not the seed's job to provision logins for them.
  const staffDefs = [
    { first: "ليلى", last: "مراد", email: "demo-manager@alnoor-demo.test", role: "MANAGER" as const },
    { first: "عمر", last: "فتحي", email: "demo-receptionist@alnoor-demo.test", role: "RECEPTIONIST" as const },
  ];
  for (const def of staffDefs) {
    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: {},
      create: { firstName: def.first, lastName: def.last, email: def.email, locale: "ar" },
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
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const profile = await prisma.studentProfile.findFirst({ where: { userId: existingUser.id, centerId } });
      if (profile) {
        students.push({ userId: existingUser.id, profileId: profile.id });
        continue;
      }
    }
    const { user, profile } = await prisma.$transaction(async (tx) => {
      const user = existingUser ?? (await tx.user.create({
        data: { firstName: studentFirstNames[i], lastName: "الطالب", email, locale: "ar" },
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
      console.log(`  + Class: ${subject.name} (${teacher.firstName} ${teacher.lastName})`);
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

  const branch = await prisma.branch.upsert({
    where: { id: `${center.id}-main` },
    update: {},
    create: {
      id: `${center.id}-main`,
      centerId: center.id,
      name: "الفرع الرئيسي",
      active: true,
    },
  });

  console.log("Seed complete:");
  console.log(`  Center       ${center.name} (${center.slug}) — ${center.id}`);
  console.log(
    `  Settings     share ${settings.defaultShareType} ${settings.defaultShareValue}`,
  );
  console.log(`  Branch       ${branch.name}`);

  if (process.env.SEED_DEMO_DATA !== "false") {
    await seedDemoData(center.id, branch.id);
  }

  const authId = await ensureAuthUser();

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
    console.log(`Sign in at /en/login with ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    console.log("This is a development credential — change it before any real use.");
  } else {
    console.log("SUPABASE_SERVICE_ROLE_KEY is not set, so no Auth user was created.");
    console.log("Create one manually: Supabase dashboard → Authentication → Users →");
    console.log(`Add user → ${OWNER_EMAIL} (tick \"Auto Confirm User\").`);
    console.log("The User mirror links to it by email on first login.");
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
