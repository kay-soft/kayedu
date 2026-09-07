import type { Prisma, PrismaClient, ParentLinkStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:parent` exercises this module
// directly, outside the Next.js runtime (same reasoning as
// lib/db/student-portal.ts and lib/db/reservations.ts).
import { normalizePhone } from "../phone.ts";

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
 */
export function verifiedChildLinks(db: Db, parentUserId: string) {
  return db.parentLink.findMany({
    where: { parentUserId, status: VERIFIED },
    orderBy: { createdAt: "asc" },
    include: {
      studentProfile: { include: { user: true } },
      center: true,
    },
  });
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
  | { ok: false; error: "notFound" | "alreadyVerified" };

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

  await db.parentLink.update({
    where: { id: link.id },
    data: { status: VERIFIED, verifiedAt: new Date(), verifiedBy: params.verifiedByUserId },
  });
  return { ok: true, linkId: link.id, studentProfileId: link.studentProfileId };
}
