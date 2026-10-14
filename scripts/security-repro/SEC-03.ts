/**
 * A03-3 — Anyone who knows a parent's phone becomes a PENDING parent of that child at every
 * centre, and the only remaining gate is a staff click on attacker-controlled evidence
 * (SEC-1, area A03).
 *
 * What it proves (all IMPORTED, real functions from lib/db/parents.ts — relative imports only):
 *   1. `originateParentLinks` (lib/db/parents.ts:76) — called by signUpAction
 *      (app/[locale]/(auth)/actions.ts:153) with the UNVERIFIED phone the registrant typed —
 *      creates a PENDING ParentLink for an unrelated stranger account against every
 *      StudentProfile whose parentPhone/parentAltPhone equals that phone, across all centres.
 *   2. What staff see on /students/[id] (page.tsx:372-391, `parentLinksForStudent`): the
 *      attacker's self-chosen name + `matchedPhone` (= the real parent phone on file) + a Verify
 *      button. Nothing distinguishes a stranger from the real parent.
 *   3. `verifyParentLinkPlaceholder` (lib/db/parents.ts:159) flips it to VERIFIED with no further
 *      check, and `verifiedChildLinks` (:121) — the parent portal's only read — then returns the
 *      child's StudentProfile + User + Center to the attacker.
 *
 * Fixtures: centre slug `secrepro-a03-3-*`, users `secrepro-a03-*@kayedu.test`; pre-cleaned and
 * deleted in finally. Never touches seed data.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-03.ts
 */
import { randomInt } from "node:crypto";
import { prisma } from "../../lib/db/client.ts";
import {
  originateParentLinks,
  parentLinksForStudent,
  verifiedChildLinks,
  verifyParentLinkPlaceholder,
} from "../../lib/db/parents.ts";
import { normalizePhone } from "../../lib/phone.ts";
import { scopedData } from "../../lib/db/tenant-scope.ts";

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { startsWith: "secrepro-a03-3-" } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: "secrepro-a03-3-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "secrepro-a03-" } } });
}

async function freePhone(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = normalizePhone(`011${String(randomInt(0, 99_999_999)).padStart(8, "0")}`)!;
    const [u, s, m] = await Promise.all([
      prisma.user.count({ where: { OR: [{ phone: candidate }, { altPhone: candidate }] } }),
      prisma.studentProfile.count({ where: { OR: [{ phone: candidate }, { parentPhone: candidate }, { parentAltPhone: candidate }] } }),
      prisma.membership.count({ where: { OR: [{ phone: candidate }, { altPhone: candidate }] } }),
    ]);
    if (u + s + m === 0) return candidate;
  }
  throw new Error("no free phone found");
}

async function main() {
  await cleanup();
  const parentPhone = await freePhone();
  const centerA = await prisma.center.create({
    data: { slug: "secrepro-a03-3-a", name: "secrepro-a03-3-a", organization: { create: { name: "secrepro-a03-3-org-a" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: "secrepro-a03-3-b", name: "secrepro-a03-3-b", organization: { create: { name: "secrepro-a03-3-org-b" } } },
  });
  const manager = await prisma.user.create({
    data: { email: "secrepro-a03-manager3@kayedu.test", firstName: "M", lastName: "gr", locale: "en" },
  });

  const profiles = [];
  for (const [i, c] of [centerA, centerB].entries()) {
    const child = await prisma.user.create({
      data: { email: `secrepro-a03-child3-${i}@kayedu.test`, firstName: "Child", lastName: String(i), locale: "ar" },
    });
    profiles.push(
      await prisma.studentProfile.create({
        data: scopedData(c.id, {
          userId: child.id,
          studentCode: `SECREPRO-A03-3-${i}`,
          firstName: "Child",
          lastName: String(i),
          parentPhone,
        }),
      }),
    );
  }

  // A stranger registers, typing the parent's phone (no OTP anywhere).
  const stranger = await prisma.user.create({
    data: { email: "secrepro-a03-stranger3@kayedu.test", firstName: "Ahmed", lastName: "(Father)", locale: "ar" },
  });
  const origin = await originateParentLinks(prisma, { parentUserId: stranger.id, phone: parentPhone });
  const created = origin.refused ? 0 : origin.createdLinkIds.length;
  console.log(`PENDING links created for the stranger across centres: ${created}`);

  const staffView = await parentLinksForStudent(prisma, centerA.id, profiles[0].id);
  const row = staffView[0];
  console.log(
    `staff sees: name="${row.parentUser.firstName} ${row.parentUser.lastName}" matchedPhone==parentPhoneOnFile=${row.matchedPhone === parentPhone} status=${row.status}`,
  );

  const before = await verifiedChildLinks(prisma, stranger.id);
  console.log(`stranger reads before verify: ${before.length} children`);

  const v = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: row.id,
    centerId: centerA.id,
    verifiedByUserId: manager.id,
  });
  const after = await verifiedChildLinks(prisma, stranger.id);
  console.log(`verify ok=${v.ok}; stranger reads after one staff click: ${after.length} child(ren), incl. profile ${after[0]?.studentProfileId === profiles[0].id}`);

  console.log(created === 2 && before.length === 0 && after.length === 1 ? "REPRODUCED" : "NOT REPRODUCED");
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
