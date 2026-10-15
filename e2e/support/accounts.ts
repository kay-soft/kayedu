/**
 * The seed accounts the suite signs in as (docs/dev-accounts.md — the
 * blueprint is prisma/seed-data/plan.ts). Every one uses `SEED_PASSWORD`
 * except the platform admin (`SEED_ADMIN_PASSWORD`, D-21).
 */
export const SEED_DOMAIN = process.env.SEED_EMAIL_DOMAIN || "example.com";

export const ACCOUNTS = {
  admin: { email: `admin@${SEED_DOMAIN}`, admin: true },
  owner: { email: `owner.center60@${SEED_DOMAIN}` },
  manager: { email: `manager.downtown@${SEED_DOMAIN}` },
  receptionist: { email: `receptionist.downtown@${SEED_DOMAIN}` },
  accountant: { email: `accountant.downtown@${SEED_DOMAIN}` },
  managerNasr: { email: `manager.nasrcity@${SEED_DOMAIN}` },
  ownerOnboarding: { email: `owner.onboarding@${SEED_DOMAIN}` },
  ownerSuspended: { email: `owner.suspended@${SEED_DOMAIN}` },
  teacherShared: { email: `teacher.shared@${SEED_DOMAIN}` },
  teacherDowntown: { email: `teacher.downtown@${SEED_DOMAIN}` },
  teacherNew: { email: `teacher.new@${SEED_DOMAIN}` },
  studentDowntown: { email: `student.downtown@${SEED_DOMAIN}` },
  studentNew: { email: `student.new@${SEED_DOMAIN}` },
  parentFamily: { email: `parent.family@${SEED_DOMAIN}` },
  parentNokhba: { email: `parent.nokhba@${SEED_DOMAIN}` },
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

export function passwordFor(key: AccountKey): string {
  const account = ACCOUNTS[key];
  const password = "admin" in account && account.admin ? process.env.SEED_ADMIN_PASSWORD : process.env.SEED_PASSWORD;
  if (!password) {
    throw new Error(
      "e2e: SEED_PASSWORD / SEED_ADMIN_PASSWORD are not set — put them in .env (see .env.example) and seed the dev database (npm run db:seed).",
    );
  }
  return password;
}

export function storageStatePath(key: AccountKey): string {
  return `e2e/.auth/${key}.json`;
}

/** Seed data the journeys read (docs/dev-accounts.md "The world behind them"). */
export const SEED = {
  downtown: "Center 60 — Downtown",
  nasrCity: "Center 60 — Nasr City",
  organization: "Center 60",
  nokhba: "Al Nokhba Academy",
};

/** A short unique tag for the data a write step creates (and later removes). */
export function uniqueTag(prefix = "E2E"): string {
  return `${prefix}${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`;
}
