/**
 * The one definition of the accounts the e2e journeys sign up, and the one way
 * to remove them again.
 *
 * Every account-creating journey (`e2e/parent|claim|student.spec.ts`) builds its
 * email from `uniqueTag(E2E_USER_PREFIX)` on `E2E_EMAIL_DOMAIN`, and the person's
 * surname carries the same tag. `removeE2eUsers` deletes by that shape only:
 * the seed world is `@<SEED_EMAIL_DOMAIN>` and gate fixtures are `<gate>-check…`,
 * so neither can match. Deleting a User cascades its profile, enrolments, family
 * links and claims; audit rows keep their ids (`actorUserId` is `ON DELETE SET NULL`
 * and the append-only trigger lets the foreign key do that).
 */
import { createClient } from "@supabase/supabase-js";
import type { PrismaClient } from "@prisma/client";

/** First characters of every e2e tag, hence of every e2e account's email. */
export const E2E_USER_PREFIX = "e2e";
export const E2E_EMAIL_DOMAIN = "example.com";

export function e2eEmail(tag: string, kind: string): string {
  return `${tag}-${kind}@${E2E_EMAIL_DOMAIN}`;
}

/**
 * Who `needle` names: a whole tag (one journey's accounts) or the bare prefix
 * (every e2e account). Matches the email, or the surname the journeys give
 * (`<Kind> <tag>`, which also finds a desk-registered student whose email was moved off).
 */
function whereE2e(needle: string) {
  return {
    isPlatformAdmin: false,
    OR: [
      { email: { startsWith: needle, endsWith: `@${E2E_EMAIL_DOMAIN}` } },
      { lastName: { contains: ` ${needle}` } },
    ],
  };
}

/** Deletes the e2e accounts `needle` names, with their Supabase logins. Idempotent; returns how many rows went. */
export async function removeE2eUsers(db: PrismaClient, needle: string = E2E_USER_PREFIX): Promise<number> {
  if (!needle.startsWith(E2E_USER_PREFIX)) throw new Error(`removeE2eUsers: "${needle}" is not an e2e tag`);
  const users = await db.user.findMany({ where: whereE2e(needle), select: { id: true, authId: true } });
  if (users.length === 0) return 0;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    for (const user of users) {
      if (user.authId) await admin.auth.admin.deleteUser(user.authId);
    }
  }
  const { count } = await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  return count;
}
