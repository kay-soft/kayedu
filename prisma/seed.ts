/**
 * Seed: one center, its CenterSettings, and one owner (M1).
 *
 * Run with:  npm run db:seed
 *
 * The owner's User row is created without an `authId`. On their first Supabase
 * login the mirror in lib/auth/session.ts links the two by email — identity
 * stays global, and no duplicate person is created.
 *
 * Override the defaults with env vars:
 *   SEED_CENTER_NAME, SEED_CENTER_SLUG, SEED_CENTER_THEME,
 *   SEED_OWNER_EMAIL, SEED_OWNER_FIRST_NAME, SEED_OWNER_LAST_NAME, SEED_OWNER_PHONE
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CENTER_NAME = process.env.SEED_CENTER_NAME ?? "مركز النور التعليمي";
const CENTER_SLUG = process.env.SEED_CENTER_SLUG ?? "al-noor";
const CENTER_THEME = process.env.SEED_CENTER_THEME ?? "#2563EB";
const OWNER_EMAIL = (process.env.SEED_OWNER_EMAIL ?? "owner@kayedu.test")
  .trim()
  .toLowerCase();
const OWNER_FIRST_NAME = process.env.SEED_OWNER_FIRST_NAME ?? "محمد";
const OWNER_LAST_NAME = process.env.SEED_OWNER_LAST_NAME ?? "الكيالي";
const OWNER_PHONE = process.env.SEED_OWNER_PHONE ?? null;

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

  const owner = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: {},
    create: {
      email: OWNER_EMAIL,
      firstName: OWNER_FIRST_NAME,
      lastName: OWNER_LAST_NAME,
      phone: OWNER_PHONE,
      locale: "ar",
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

  console.log("Seed complete:");
  console.log(`  Center       ${center.name} (${center.slug}) — ${center.id}`);
  console.log(`  Settings     share ${settings.defaultShareType} ${settings.defaultShareValue}`);
  console.log(`  Branch       ${branch.name}`);
  console.log(`  Owner        ${OWNER_EMAIL} — membership ${membership.id}`);
  console.log("");
  console.log("Next: create a Supabase Auth user with this same email");
  console.log("(Supabase dashboard → Authentication → Users → Add user),");
  console.log("then sign in — the User mirror links by email on first login.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
