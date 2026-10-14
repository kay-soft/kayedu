/**
 * A03-1 — Student/teacher record takeover by registering the record's email (SEC-1, area A03).
 *
 * What it proves:
 *   1. The dev Supabase project has email confirmation OFF (`mailer_autoconfirm: true`,
 *      `disable_signup: false`) — read from GoTrue's public `/auth/v1/settings` with the
 *      PUBLIC anon key. So `supabase.auth.signUp({ email })` (app/[locale]/(auth)/actions.ts:115)
 *      returns a live session for ANY email, without proving ownership of it.
 *   2. A student created by a receptionist (createStudentAction → `createPerson`,
 *      lib/db/identity.ts:216 — IMPORTED here, the real function) is a `User` row with the typed
 *      email and `authId = null`.
 *   3. `syncUserFromAuth` (lib/auth/session.ts:40-80 — REPLICATED here, query for query, because
 *      that module imports `react` cache + `@/` and cannot be loaded outside Next) links an
 *      unlinked `User` to whatever auth identity presents the same email, with no check of
 *      `email_confirmed_at`. The attacker's fresh auth id therefore becomes the student's identity
 *      and every StudentProfile of that User (all centres) resolves as the attacker's own
 *      (resolveCenterRelations' student shape: studentProfile where userId + active).
 *
 * No Supabase Auth user is created: the attacker's auth user is a synthetic object with a random
 * id, which is exactly what GoTrue would return from signUp under (1).
 *
 * Fixtures: centre slug `secrepro-a03-1-*`, users `secrepro-a03-*@kayedu.test`; pre-cleaned and
 * deleted in finally. Never touches seed data.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-01.ts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/db/client.ts";
import { createPerson } from "../../lib/db/identity.ts";
import { scopedData } from "../../lib/db/tenant-scope.ts";

const SLUG = "secrepro-a03-1-centre";
const VICTIM_EMAIL = "secrepro-a03-victim-student@kayedu.test";

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { startsWith: "secrepro-a03-1-" } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: "secrepro-a03-1-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "secrepro-a03-" } } });
}

type FakeAuthUser = { id: string; email?: string; user_metadata: Record<string, unknown> };

/** lib/auth/session.ts:40-80, replicated verbatim in query shape (email branch only needs 40-62). */
async function syncUserFromAuthReplica(authUser: FakeAuthUser) {
  const email = authUser.email?.trim().toLowerCase() ?? null; // :41
  const linked = await prisma.user.findUnique({ where: { authId: authUser.id } }); // :43
  if (linked) return linked;
  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } }); // :52
    if (byEmail) {
      if (byEmail.authId && byEmail.authId !== authUser.id) throw new Error("already linked"); // :54
      return prisma.user.update({ where: { id: byEmail.id }, data: { authId: authUser.id } }); // :59
    }
  }
  throw new Error("unexpected: would create a new User (no takeover)");
}

async function main() {
  // (1) Is email confirmation required by the live Supabase project?
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let autoconfirm: boolean | null = null;
  if (base && anon) {
    const res = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: anon } });
    const json = (await res.json()) as { mailer_autoconfirm?: boolean; disable_signup?: boolean };
    autoconfirm = json.mailer_autoconfirm === true && json.disable_signup === false;
    console.log(`supabase settings: mailer_autoconfirm=${json.mailer_autoconfirm} disable_signup=${json.disable_signup}`);
  }

  await cleanup();
  const center = await prisma.center.create({
    data: { slug: SLUG, name: "secrepro-a03-1-centre", organization: { create: { name: "secrepro-a03-1-org" } } },
  });

  // (2) Receptionist adds a student with an email (createStudentAction's exact person write).
  const victim = await createPerson(
    { firstName: "Victim", lastName: "Child", email: VICTIM_EMAIL, phone: null, altPhone: null, locale: "ar" },
    prisma,
  );
  const profile = await prisma.studentProfile.create({
    data: scopedData(center.id, {
      userId: victim.id,
      studentCode: "SECREPRO-A03-1",
      firstName: "Victim",
      lastName: "Child",
      email: VICTIM_EMAIL,
      parentPhone: null,
    }),
  });
  console.log(`victim User authId before = ${victim.authId}`);

  // (3) Attacker signs up with the victim's email (case-varied) → GoTrue issues a session →
  //     the app's first getCurrentUser()/signInAction runs syncUserFromAuth.
  const attackerAuth: FakeAuthUser = {
    id: randomUUID(),
    email: VICTIM_EMAIL.toUpperCase(),
    user_metadata: { first_name: "Attacker", last_name: "X", phone: "", locale: "en" },
  };
  const resolved = await syncUserFromAuthReplica(attackerAuth);
  const sameUser = resolved.id === victim.id && resolved.authId === attackerAuth.id;
  console.log(`syncUserFromAuth returned victim User: ${sameUser}`);

  // The attacker's relations (lib/auth/relations.ts student shape).
  const attackerProfiles = await prisma.studentProfile.findMany({
    where: { userId: resolved.id, active: true },
    select: { id: true, centerId: true },
  });
  const ownsVictimProfile = attackerProfiles.some((p) => p.id === profile.id);
  console.log(`attacker now resolves the victim's StudentProfile: ${ownsVictimProfile}`);

  const reproduced = sameUser && ownsVictimProfile;
  if (autoconfirm === false) {
    console.log("note: confirmation is ON in this project — linking still happens, but only for a confirmed email owner");
  }
  console.log(reproduced && autoconfirm !== false ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.log("NOT REPRODUCED");
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  });
