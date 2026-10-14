/**
 * A03-2 — Unverified phone squatting → a centre's "add student" links the child to the attacker
 * (SEC-1, area A03).
 *
 * What it proves:
 *   1. Self-registration lets anyone claim any free phone number as their global `User.phone`:
 *      signUpAction (app/[locale]/(auth)/actions.ts:107-112) only refuses a phone that another
 *      User already holds, then writes it (:142) — there is no SMS/OTP step anywhere
 *      (phone_autoconfirm is irrelevant: the phone never goes to Supabase as a credential, it is
 *      only `user_metadata`). REPLICATED: the two queries at :108 and :142.
 *   2. When a receptionist later adds the real child with that phone, the duplicate matcher
 *      (`resolveContact`, lib/db/identity.ts:170 — IMPORTED, the real function) returns the
 *      ATTACKER as the existing person, and `seedLocalName` (lib/db/identity.ts:188 — IMPORTED)
 *      seeds the new profile with the attacker-chosen name. A staff "link" click
 *      (createStudentAction, app/[locale]/(center)/students/actions.ts:220-229, linkUserId must
 *      equal the matched user — it does) then creates the child's StudentProfile ON the attacker's
 *      User: the attacker signs in and reads it in the student portal.
 *
 * Fixtures: centre slug `secrepro-a03-2-*`, users `secrepro-a03-*@kayedu.test`; pre-cleaned and
 * deleted in finally. Never touches seed data.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-02.ts
 */
import { randomInt } from "node:crypto";
import { prisma } from "../../lib/db/client.ts";
import { resolveContact, seedLocalName } from "../../lib/db/identity.ts";
import { normalizePhone } from "../../lib/phone.ts";
import { scopedData } from "../../lib/db/tenant-scope.ts";

const SLUG = "secrepro-a03-2-centre";
const ATTACKER_EMAIL = "secrepro-a03-attacker2@kayedu.test";

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { startsWith: "secrepro-a03-2-" } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: "secrepro-a03-2-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "secrepro-a03-" } } });
}

async function freePhone(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = normalizePhone(`010${String(randomInt(0, 99_999_999)).padStart(8, "0")}`)!;
    const [u, s, m] = await Promise.all([
      prisma.user.count({ where: { OR: [{ phone: candidate }, { altPhone: candidate }] } }),
      prisma.studentProfile.count({ where: { OR: [{ phone: candidate }, { parentPhone: candidate }] } }),
      prisma.membership.count({ where: { phone: candidate } }),
    ]);
    if (u + s + m === 0) return candidate;
  }
  throw new Error("no free phone found");
}

async function main() {
  await cleanup();
  const childPhone = await freePhone();
  const center = await prisma.center.create({
    data: { slug: SLUG, name: "secrepro-a03-2-centre", organization: { create: { name: "secrepro-a03-2-org" } } },
  });

  // (1) Attacker registers with the child's (or parent's) phone and the child's name.
  const owner = await prisma.user.findUnique({ where: { phone: childPhone } }); // actions.ts:108
  if (owner) throw new Error("phone unexpectedly taken");
  const attacker = await prisma.user.create({
    data: { authId: null, email: ATTACKER_EMAIL, firstName: "Mariam", lastName: "Hassan", locale: "ar" },
  }); // syncUserFromAuth create (session.ts:75)
  await prisma.user.update({ where: { id: attacker.id }, data: { phone: childPhone } }); // actions.ts:142
  console.log("attacker holds the phone as User.phone with no verification: true");

  // (2) Receptionist adds the real child, typing the child's phone (and no email).
  const resolution = await resolveContact({ email: null, phone: childPhone });
  const matchedAttacker = resolution.kind === "matched" && resolution.match.user.id === attacker.id;
  console.log(`resolveContact kind=${resolution.kind} matched attacker=${matchedAttacker}`);
  const seeded = seedLocalName(resolution, { firstName: "Real", lastName: "Child" });
  console.log(`seeded local name = ${seeded.firstName} ${seeded.lastName} (attacker-chosen)`);

  // Staff click "link" → linkUserId === resolution.match.user.id → profile on attacker's User.
  if (resolution.kind !== "matched") throw new Error("no match");
  const profile = await prisma.studentProfile.create({
    data: scopedData(center.id, {
      userId: resolution.match.user.id,
      studentCode: "SECREPRO-A03-2",
      firstName: seeded.firstName,
      lastName: seeded.lastName,
      phone: childPhone,
      parentPhone: null,
    }),
  });
  const attackerSees = await prisma.studentProfile.findFirst({
    where: { userId: attacker.id, active: true, id: profile.id },
  });
  console.log(`attacker's account now resolves the child's StudentProfile: ${attackerSees !== null}`);

  // Side effect: the real child can no longer self-register with their own phone.
  const realOwnerBlocked = (await prisma.user.findUnique({ where: { phone: childPhone } }))?.email !== "real-child@example.com";
  console.log(`real owner registering this phone gets phoneInUse: ${realOwnerBlocked}`);

  console.log(matchedAttacker && attackerSees ? "REPRODUCED" : "NOT REPRODUCED");
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
