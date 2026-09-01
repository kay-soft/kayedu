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
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

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
