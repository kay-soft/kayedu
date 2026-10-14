/**
 * A12-2 — Parent-link origination trusts an UNVERIFIED registration phone, across
 * every centre; the staff "verify" screen has no signal to tell the real parent
 * from an impostor, and the impostor also squats the real parent's phone.
 *
 * What it proves
 *   1. signUpAction (app/[locale]/(auth)/actions.ts:95-153) takes `phone` from
 *      the form, stores it only as Supabase user_metadata (no OTP), writes it to
 *      User.phone (:143-146) and calls `originateParentLinks` with it (:153).
 *      The only pre-check is "is this phone already some User's phone" (:104-108).
 *   2. `originateParentLinks` (lib/db/parents.ts:76-112) then creates a PENDING
 *      ParentLink to EVERY StudentProfile in EVERY centre whose parentPhone /
 *      parentAltPhone equals that number (here: two unrelated centres).
 *   3. What staff see before clicking Verify (`parentLinksForStudent`,
 *      lib/db/parents.ts:133-139, rendered at app/[locale]/(center)/students/[id]/page.tsx:372-393)
 *      is the account's self-chosen name + `matchedPhone`, which by construction
 *      always equals the parent phone on file — i.e. it looks identical for the
 *      real parent and for anyone who typed that number.
 *   4. After one Verify click (`verifyParentLinkPlaceholder`) the impostor's
 *      `verifiedChildLinks` returns the child (the parent portal's only gate).
 *   5. The real parent can no longer register with their own phone: the
 *      signUpAction pre-check (User.phone unique) now answers "phoneInUse".
 *
 * Imported vs replicated
 *   - IMPORTED: originateParentLinks, parentLinksForStudent,
 *     verifyParentLinkPlaceholder, verifiedChildLinks (lib/db/parents.ts — pure).
 *   - REPLICATED: signUpAction's DB writes/pre-check (it imports next/* and
 *     Supabase): `prisma.user.findUnique({ where: { phone } })` (:105) and the
 *     User row carrying `phone` (:143-146). No Supabase Auth user is created.
 *
 * Fixtures: two Organizations + Centers (slug `secrepro-a12b-`), users with
 * emails `secrepro-a12b-*@kayedu.test`; all removed in `finally` (and pre-cleaned).
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-03-squat.ts
 */
import { PrismaClient } from "@prisma/client";

import {
  originateParentLinks,
  parentLinksForStudent,
  verifiedChildLinks,
  verifyParentLinkPlaceholder,
} from "../../lib/db/parents.ts";

const SLUG_PREFIX = "secrepro-a12b-";
const EMAIL_PREFIX = "secrepro-a12b-";
const REAL_PARENT_PHONE = "01599990011"; // throwaway, checked unused below

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  const centers = await prisma.center.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, organizationId: true },
  });
  const centerIds = centers.map((c) => c.id);
  const orgIds = [...new Set(centers.map((c) => c.organizationId))];
  if (centerIds.length) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: centerIds } } });
    await prisma.center.deleteMany({ where: { id: { in: centerIds } } });
  }
  if (orgIds.length) {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds }, centers: { none: {} } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function makeCentreWithChild(tag: string) {
  const center = await prisma.center.create({
    data: {
      slug: `${SLUG_PREFIX}${tag}`,
      name: `SecRepro A12b ${tag}`,
      organization: { create: { name: `SecRepro A12b ${tag}` } },
    },
  });
  const manager = await prisma.user.create({
    data: { firstName: "Mgr", lastName: tag, email: `${EMAIL_PREFIX}${tag}-mgr@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({ data: { centerId: center.id, userId: manager.id, role: "MANAGER" } });
  const childUser = await prisma.user.create({
    data: { firstName: "Child", lastName: tag, email: `${EMAIL_PREFIX}${tag}-child@kayedu.test`, locale: "en" },
  });
  const child = await prisma.studentProfile.create({
    data: {
      centerId: center.id,
      userId: childUser.id,
      studentCode: `A12B-${tag}`,
      firstName: "Child",
      lastName: tag,
      parentFirstName: "Real",
      parentLastName: "Parent",
      parentPhone: REAL_PARENT_PHONE,
    },
  });
  return { center, manager, child };
}

async function main(): Promise<boolean> {
  await cleanup();
  const clash =
    (await prisma.user.count({ where: { phone: REAL_PARENT_PHONE } })) +
    (await prisma.studentProfile.count({ where: { OR: [{ parentPhone: REAL_PARENT_PHONE }, { parentAltPhone: REAL_PARENT_PHONE }] } })) +
    (await prisma.membership.count({ where: { OR: [{ phone: REAL_PARENT_PHONE }, { altPhone: REAL_PARENT_PHONE }] } }));
  if (clash > 0) throw new Error("throwaway phone already in use — pick another");

  // Two unrelated centres (different organizations), same parent phone on file.
  const a = await makeCentreWithChild("x");
  const b = await makeCentreWithChild("y");

  // ── Impostor signs up typing the real parent's phone (no OTP anywhere) ──
  // signUpAction pre-check (actions.ts:104-108): nobody owns it as User.phone yet.
  const preOwner = await prisma.user.findUnique({ where: { phone: REAL_PARENT_PHONE } });
  console.log(`signup pre-check for impostor: phone owner = ${preOwner ? "someone" : "none"} -> allowed`);
  const impostor = await prisma.user.create({
    data: {
      firstName: "Real", // self-chosen display name, copied from what the impostor typed
      lastName: "Parent",
      email: `${EMAIL_PREFIX}impostor@kayedu.test`,
      phone: REAL_PARENT_PHONE,
      locale: "ar",
    },
  });
  const origin = await originateParentLinks(prisma, { parentUserId: impostor.id, phone: REAL_PARENT_PHONE });
  if (!origin.ok || origin.refused) throw new Error("origination refused");
  console.log(`PENDING links created for impostor: ${origin.createdLinkIds.length} (across 2 unrelated centres)`);

  // ── What a centre manager sees on /students/[id] before clicking Verify ──
  const staffView = await parentLinksForStudent(prisma, a.center.id, a.child.id);
  for (const link of staffView) {
    console.log(
      `  staff view @ ${a.center.name}: account="${link.parentUser.firstName} ${link.parentUser.lastName}" matchedPhone=${link.matchedPhone} ` +
        `(student's parentPhone on file=${a.child.parentPhone}, parent name on file=${a.child.parentFirstName} ${a.child.parentLastName}) status=${link.status}`,
    );
  }
  const indistinguishable = staffView.every(
    (l) => l.matchedPhone === a.child.parentPhone && l.parentUser.firstName === a.child.parentFirstName,
  );

  // ── One click at centre A ──
  const v = await verifyParentLinkPlaceholder(prisma, {
    parentLinkId: staffView[0].id,
    centerId: a.center.id,
    verifiedByUserId: a.manager.id,
  });
  if (!v.ok) throw new Error("verify failed");
  const readable = await verifiedChildLinks(prisma, impostor.id);
  console.log(`impostor now reads ${readable.length} child(ren): ${readable.map((l) => `${l.studentProfile.firstName} ${l.studentProfile.lastName} @ ${l.center.name}`).join(", ")}`);
  const stillPendingAtB = await prisma.parentLink.count({ where: { parentUserId: impostor.id, centerId: b.center.id, status: "PENDING" } });
  console.log(`still-PENDING link waiting at the unrelated centre B: ${stillPendingAtB}`);

  // ── The real parent now tries to register with their own phone ──
  const owner = await prisma.user.findUnique({ where: { phone: REAL_PARENT_PHONE } });
  const realParentBlocked = owner !== null && owner.email !== `${EMAIL_PREFIX}realparent@kayedu.test`;
  console.log(`real parent signup with own phone -> ${realParentBlocked ? 'fieldErrors.phone = "phoneInUse"' : "allowed"}`);

  return origin.createdLinkIds.length === 2 && indistinguishable && readable.length === 1 && realParentBlocked;
}

let reproduced = false;
try {
  reproduced = await main();
} catch (error) {
  console.error("error:", error instanceof Error ? error.message : error);
} finally {
  try {
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
}
console.log(reproduced ? "REPRODUCED" : "NOT REPRODUCED");
