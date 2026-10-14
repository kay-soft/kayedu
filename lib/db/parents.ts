import type { Prisma, PrismaClient, ParentLinkStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:parent` exercises this module
// directly, outside the Next.js runtime (same reasoning as
// lib/db/student-portal.ts and lib/db/reservations.ts).
import { normalizePhone } from "../phone.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "./platform.ts";

/**
 * ParentLink resolution (M16, docs/01-data-model.md "People layer, continued",
 * docs/00-master-product-spec.md §5.1 "Parent role & portal"). Two hard rules
 * live here, on the write path, never in the UI:
 *
 * 1. A phone already belonging to a teacher, staff member or platform admin
 *    can never originate a parent link — `isPrivilegedPhone` is checked
 *    *before* any student match, so a privileged phone is refused even when
 *    it also happens to sit in some student's `parentPhone` field (a
 *    teacher's own child attending the centre is the exact scenario this
 *    guards).
 * 2. A phone match alone never grants access — `originateParentLinks` only
 *    ever writes PENDING rows. `verifiedChildLinks` is the **only** read any
 *    parent-portal page/route is allowed to build on, and it is filtered to
 *    VERIFIED — an unverified link yields zero rows here, by construction.
 *
 * The verification mechanism itself is OD-6 (00-master-product-spec.md
 * §2.2), still open. `verifyParentLinkPlaceholder` below is a deliberately
 * temporary seam, not that decision.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const PENDING: ParentLinkStatus = "PENDING";
const VERIFIED: ParentLinkStatus = "VERIFIED";
const REVOKED: ParentLinkStatus = "REVOKED";

/** The phones on the student's record a link may still stand on. */
function currentParentPhones(profile: {
  parentPhone: string | null;
  parentAltPhone: string | null;
}): Set<string> {
  return new Set(
    [normalizePhone(profile.parentPhone), normalizePhone(profile.parentAltPhone)].filter(
      (phone): phone is string => Boolean(phone),
    ),
  );
}

/**
 * Is this (already-normalized) phone number privileged — does it belong to a
 * platform admin, or to an active Membership of any role, at either the
 * global `User.phone` or a centre's own local Membership contact record?
 * Checked against both because a teacher's centre-local phone (M3, "contact
 * details are centre-local") can differ from their global login number, and
 * either one appearing on a student's parent-phone field must be refused.
 */
export async function isPrivilegedPhone(db: Db, phone: string): Promise<boolean> {
  const [globalMatch, localMatch] = await Promise.all([
    db.user.findFirst({
      where: {
        phone,
        OR: [{ isPlatformAdmin: true }, { memberships: { some: { active: true } } }],
      },
      select: { id: true },
    }),
    db.membership.findFirst({
      where: { active: true, OR: [{ phone }, { altPhone: phone }] },
      select: { id: true },
    }),
  ]);
  return globalMatch !== null || localMatch !== null;
}

export type OriginateParentLinksResult =
  | { ok: true; refused: false; createdLinkIds: string[] }
  | { ok: true; refused: true; reason: "privilegedPhone" };

/**
 * Account origination (spec §4.5 item 0 / §5.1 "Parent role & portal"): given
 * the phone a person just registered/logged in with, find every
 * `StudentProfile` that lists it as a parent phone, across every centre —
 * this is identity-scoped by an exact normalized phone value, the same
 * category of cross-centre lookup `lib/identity.ts`'s `contactMatchWhere`
 * already makes for duplicate-person matching, never a tenant-isolation
 * bypass (it can only ever return rows whose parent-phone field literally
 * equals this one number).
 *
 * Idempotent: re-running this for the same parent/phone never duplicates a
 * row (`@@unique([parentUserId, studentProfileId])`, `skipDuplicates`).
 * Every row created here starts PENDING — origination is not verification.
 */
export async function originateParentLinks(
  db: Db,
  params: { parentUserId: string; phone: string | null },
): Promise<OriginateParentLinksResult> {
  const phone = normalizePhone(params.phone);
  if (!phone) return { ok: true, refused: false, createdLinkIds: [] };

  if (await isPrivilegedPhone(db, phone)) {
    return { ok: true, refused: true, reason: "privilegedPhone" };
  }

  const matches = await db.studentProfile.findMany({
    where: { OR: [{ parentPhone: phone }, { parentAltPhone: phone }] },
    select: { id: true, centerId: true },
  });
  if (matches.length === 0) return { ok: true, refused: false, createdLinkIds: [] };

  await db.parentLink.createMany({
    data: matches.map((match) => ({
      parentUserId: params.parentUserId,
      studentProfileId: match.id,
      centerId: match.centerId,
      matchedPhone: phone,
      status: PENDING,
    })),
    skipDuplicates: true,
  });

  const rows = await db.parentLink.findMany({
    where: {
      parentUserId: params.parentUserId,
      studentProfileId: { in: matches.map((match) => match.id) },
    },
    select: { id: true },
  });
  return { ok: true, refused: false, createdLinkIds: rows.map((row) => row.id) };
}

/**
 * The **only** read a parent-portal page/route may build on. Filtered to
 * VERIFIED — a PENDING link (including the parent's own, on a child they
 * really do have a pending match for) yields zero rows here, which is what
 * makes "inert until verified" true by construction rather than by a check
 * some future caller could forget.
 *
 * SEC-2a re-checks every link on every read, so nothing stale is ever served
 * (SEC-04, SEC-16; decisions D-04 (a), D-10 (a)):
 * - the child's profile must still be **active**;
 * - the child's centre must still be in an accessible lifecycle state (a
 *   SUSPENDED or ARCHIVED centre disappears from the parent portal);
 * - the phone the link was made on must still be the student's parent phone
 *   or parent alt phone. A changed number reads as nothing here even before
 *   `revokeStaleParentLinks` has marked the link REVOKED.
 */
export async function verifiedChildLinks(db: Db, parentUserId: string) {
  const links = await db.parentLink.findMany({
    where: {
      parentUserId,
      status: VERIFIED,
      studentProfile: { active: true },
      center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    },
    orderBy: { createdAt: "asc" },
    include: {
      studentProfile: { include: { user: true } },
      center: true,
    },
  });
  return links.filter((link) =>
    currentParentPhones(link.studentProfile).has(normalizePhone(link.matchedPhone) ?? ""),
  );
}

/**
 * D-04 (a): when a student's parent phones change, every link (pending or
 * verified) whose matched phone is no longer on the record is **revoked** —
 * final, audited (`parentLink.revoke`), in the caller's transaction when it
 * passes one. Called by every write path that can change a parent phone:
 * staff editing the student and the student's one-time profile completion.
 */
export async function revokeStaleParentLinks(
  db: Db,
  params: {
    centerId: string;
    studentProfileId: string;
    actorUserId: string | null;
  },
): Promise<number> {
  const profile = await db.studentProfile.findFirst({
    where: { id: params.studentProfileId, centerId: params.centerId },
    select: { parentPhone: true, parentAltPhone: true },
  });
  if (!profile) return 0;

  const phones = currentParentPhones(profile);
  const links = await db.parentLink.findMany({
    where: {
      centerId: params.centerId,
      studentProfileId: params.studentProfileId,
      status: { in: [PENDING, VERIFIED] },
    },
    select: { id: true, status: true, matchedPhone: true },
  });
  const stale = links.filter((link) => !phones.has(normalizePhone(link.matchedPhone) ?? ""));

  const now = new Date();
  for (const link of stale) {
    const updated = await db.parentLink.updateMany({
      where: { id: link.id, centerId: params.centerId, status: link.status },
      data: { status: REVOKED, revokedAt: now, revokedReason: "parentPhoneChanged" },
    });
    if (updated.count === 0) continue;
    await db.auditLog.create({
      data: {
        centerId: params.centerId,
        actorUserId: params.actorUserId,
        action: "parentLink.revoke",
        entityType: "ParentLink",
        entityId: link.id,
        before: { status: link.status },
        after: { status: REVOKED, reason: "parentPhoneChanged" },
      },
    });
  }
  return stale.length;
}

/** Every link (any status) against one student — the staff-side detail view. */
export function parentLinksForStudent(db: Db, centerId: string, studentProfileId: string) {
  return db.parentLink.findMany({
    where: { centerId, studentProfileId },
    orderBy: { createdAt: "asc" },
    include: { parentUser: true },
  });
}

export type VerifyParentLinkResult =
  | { ok: true; linkId: string; studentProfileId: string }
  | { ok: false; error: "notFound" | "alreadyVerified" | "verificationUnavailable" };

/**
 * ─────────────────────────────── OD-6 PLACEHOLDER ───────────────────────────
 * The real parent↔child verification mechanism (staff approval from the
 * student's own profile, an OTP to the parent's phone, or a centre-issued
 * code) is **OD-6** (00-master-product-spec.md §2.2) and is explicitly still
 * open — blocked on OD-2, the minors'-data legal review. This function is
 * NOT that decision. It is the "obvious, clearly-commented seam" the M16
 * brief calls for: a centre staff member with `parent.link.manage` manually
 * flips one PENDING link to VERIFIED from `/students/[id]`, audited like any
 * other permission-adjacent write. When OD-6 resolves, replace this
 * function's body (and however it is invoked) — its callers and the
 * `verifiedChildLinks` read path above should not need to change.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function verifyParentLinkPlaceholder(
  db: Db,
  params: { parentLinkId: string; centerId: string; verifiedByUserId: string },
): Promise<VerifyParentLinkResult> {
  const link = await db.parentLink.findFirst({
    where: { id: params.parentLinkId, centerId: params.centerId },
  });
  if (!link) return { ok: false, error: "notFound" };
  if (link.status === VERIFIED) return { ok: false, error: "alreadyVerified" };

  // SEC-03 / D-03 (d): disabled until OD-6 is decided. A staff click on
  // evidence the registrant controls (their own name, the phone they typed)
  // cannot tell a parent from an impostor, so no staff action may turn a
  // phone match into access. Links verified before SEC-2a keep working
  // (`verifiedChildLinks` still re-checks them on every read).
  return { ok: false, error: "verificationUnavailable" };
}
