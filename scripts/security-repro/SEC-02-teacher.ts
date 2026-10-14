/**
 * A01-1 — Identity pre-claim: duplicate-matching keys on UNVERIFIED contacts, so a
 * self-registered user gets linked into another centre's teacher/student record
 * (SEC-1 audit, area A01: tenant isolation / cross-tenant identity).
 *
 * What it proves:
 *   `signUpAction` (app/[locale]/(auth)/actions.ts:100-144) and `syncUserFromAuth`
 *   (lib/auth/session.ts:66-77) write a phone the user merely TYPED (never verified)
 *   onto the global `User.phone`. `findPeopleByContact` (lib/db/identity.ts:48-98)
 *   matches on that field (and on any centre's self-edited local StudentProfile.phone),
 *   with no verification flag, contrary to spec §5 "keyed on verified phone/email".
 *   When centre X later adds the real person by that phone, the match panel offers the
 *   attacker's account (with the attacker-chosen name), and "Use this person"
 *   (`linkUserId`) attaches centre X's new Membership/StudentProfile to the attacker.
 *
 * IMPORTED (real code): addTeacherMembership (lib/db/teacher-membership.ts) and
 *   resolveContact/describeMatch (lib/db/identity.ts) — the exact functions
 *   createTeacherAction / createStudentAction / lookupPersonByPhoneAction call.
 * REPLICATED: the attacker's sign-up is simulated by inserting the `User` row exactly
 *   as syncUserFromAuth/signUpAction would (authId + email + unverified phone + chosen
 *   name); no Supabase Auth user is created.
 *
 * Fixtures: org + centre slug `secrepro-a01-x`, user `secrepro-a01-attacker@kayedu.test`;
 * pre-cleaned and deleted in finally. Never touches seed data.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-02-teacher.ts
 * Final line: REPRODUCED | NOT REPRODUCED
 */
import { PrismaClient } from "@prisma/client";
import { addTeacherMembership } from "../../lib/db/teacher-membership.ts";
import { describeMatch, resolveContact } from "../../lib/db/identity.ts";

const prisma = new PrismaClient();
const SLUG = "secrepro-a01-x";
const EMAIL = "secrepro-a01-attacker@kayedu.test";

async function cleanup(): Promise<void> {
  const centers = await prisma.center.findMany({ where: { slug: SLUG }, select: { id: true, organizationId: true } });
  for (const c of centers) {
    await prisma.auditLog.deleteMany({ where: { centerId: c.id } });
    await prisma.membership.deleteMany({ where: { centerId: c.id } });
    await prisma.center.delete({ where: { id: c.id } });
    await prisma.organization.deleteMany({ where: { id: c.organizationId } });
  }
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function freePhone(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const p = `0109${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const taken =
      (await prisma.user.count({ where: { phone: p } })) +
      (await prisma.studentProfile.count({ where: { phone: p } })) +
      (await prisma.membership.count({ where: { phone: p } }));
    if (taken === 0) return p;
  }
  throw new Error("no free phone found");
}

async function main(): Promise<void> {
  await cleanup();
  let reproduced = false;
  try {
    const victimPhone = await freePhone();

    // 1. Attacker self-registers, typing the victim's (not-yet-known) phone and name.
    const attacker = await prisma.user.create({
      data: {
        authId: "secrepro-a01-fake-auth-id",
        email: EMAIL,
        phone: victimPhone, // unverified — exactly what signUpAction/syncUserFromAuth store
        firstName: "Ahmed",
        lastName: "Victim",
        locale: "en",
      },
    });

    // 2. An unrelated centre X (attacker has no relation to it).
    const org = await prisma.organization.create({ data: { name: "SecRepro A01 Org" } });
    const center = await prisma.center.create({
      data: { slug: SLUG, name: "SecRepro A01 X", organizationId: org.id },
    });

    // 3. Centre X staff look the real person up by phone (student + teacher forms).
    const resolution = await resolveContact({ phone: victimPhone });
    if (resolution.kind === "matched") {
      const match = await describeMatch(center.id, resolution.match, { phone: victimPhone });
      console.log(`lookup match -> userId=${match.userId === attacker.id ? "ATTACKER" : match.userId} name="${match.name}" matchedOn=${match.matchedOn.join(",")}`);
    } else {
      console.log(`lookup -> ${resolution.kind}`);
    }

    // 4. Staff add the teacher: first submit shows the match, second ("Use this person") links.
    const input = { firstName: "Ahmed", lastName: "Victim", email: null, phone: victimPhone, altPhone: null, locale: "en" };
    const first = await prisma.$transaction((tx) =>
      addTeacherMembership(tx, center.id, input, { actorUserId: null, linkUserId: null, via: "teacher.add", refusePrivileged: false }),
    );
    console.log(`first submit -> ${first.ok ? "ok" : first.error}`);
    const linkId = !first.ok && first.match ? first.match.userId : null;
    if (linkId) {
      const second = await prisma.$transaction((tx) =>
        addTeacherMembership(tx, center.id, input, { actorUserId: null, linkUserId: linkId, via: "teacher.add", refusePrivileged: false }),
      );
      console.log(`second submit -> ${second.ok ? `ok outcome=${second.outcome}` : second.error}`);
      if (second.ok) {
        const m = await prisma.membership.findFirst({ where: { id: second.membershipId, centerId: center.id } });
        console.log(`centre X TEACHER membership userId is attacker: ${m?.userId === attacker.id}`);
        reproduced = m?.userId === attacker.id;
      }
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(reproduced ? "REPRODUCED" : "NOT REPRODUCED");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  console.log("NOT REPRODUCED");
  process.exit(1);
});
