"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  createPerson,
  deletePersonIfOrphaned,
  describeMatch,
  resolveContact,
  seedLocalName,
} from "@/lib/db/identity";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import {
  studentSearchWhere,
  teacherDeleteBlockers,
  teacherSearchWhere,
} from "@/lib/db/students";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { scopedData } from "@/lib/db/tenant-scope";
import { fullName, localName } from "@/lib/identity";
import { redirect } from "@/lib/i18n/navigation";
import { normalizePhone } from "@/lib/phone";
import { checkRateLimit } from "@/lib/rate-limit";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  blockCreateSchema,
  blockRemoveSchema,
  membershipActionSchema,
  membershipActiveSchema,
  teacherCreateSchema,
  teacherUpdateSchema,
  type PeopleActionState,
  type PhoneLookupResult,
} from "@/lib/validation/people";

/**
 * Teachers (M3, revised). Every action follows docs/02 §7: getTenantContext()
 * → permission check → zod → scoped write → audit if sensitive → revalidate.
 *
 * A teacher is a **Membership**, not a user (CLAUDE.md rule 4). Adding one who
 * already exists on the platform links a membership to that person; it never
 * creates a second identity (spec §5), and the match is always shown to staff
 * before it is acted on.
 *
 * Name and contact details (firstName/lastName/email/phone/altPhone) are
 * **this center's own local record** for the person (docs/01-data-model.md
 * §6) — seeded from the global `User` at creation, then always editable here,
 * independently of any other center, with no lock of any kind.
 */

const FORBIDDEN: PeopleActionState = { error: "forbidden" };
const NOT_FOUND: PeopleActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

async function teacherScope(): Promise<Scope | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "teacher.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateTeacherList(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerTeachers}`);
}

function revalidateTeacherDetail(locale: string, teacherId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerTeacher(teacherId)}`);
}

/** Both unique columns on User are contact details, so P2002 is a duplicate. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

export async function searchTeachersTypeAheadAction(
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await teacherScope();
  if (!scope) return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const rows = await scope.db.teachers.search({
    where: teacherSearchWhere(trimmed),
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.phone ?? row.email ?? undefined,
    href: ROUTES.centerTeacher(row.id),
  }));
}

/**
 * Candidates for a teacher's block-list (a student not already blocked from
 * them). Bound to `teacherMembershipId` via `.bind(null, teacher.id)` where
 * it's passed to `TypeAheadSearch` — the component's own `search` prop only
 * ever supplies the typed query. Selecting a result re-navigates to this
 * same detail page with `?q=<exact student code>`, which reuses the page's
 * own existing candidate-rendering (`BlockList`) unchanged — a self-
 * referencing link is simpler than teaching this screen a second render path.
 */
export async function searchBlockCandidatesAction(
  teacherMembershipId: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.block")) return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const db = scoped(ctx);
  const teacher = await db.teachers.findById(teacherMembershipId);
  if (!teacher) return [];

  const blocks = await db.studentBlocks.list({ scope: "TEACHER", refId: teacher.userId });
  const blockedUserIds = blocks.map((block) => block.blockedUserId);

  const rows = await db.students.search({
    where: {
      ...studentSearchWhere(trimmed),
      active: true,
      ...(blockedUserIds.length > 0 ? { NOT: { userId: { in: blockedUserIds } } } : {}),
    },
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: `${ROUTES.centerTeacher(teacherMembershipId)}?q=${encodeURIComponent(row.studentCode)}`,
  }));
}

// ── Receptionist phone lookup (M18, spec §5.1) ──────────────────────────────
// Same shape as the students screen's own (`students/actions.ts`) — the
// existing duplicate-match workflow, reachable from a phone alone.

export async function lookupPersonByPhoneAction(
  phone: string,
): Promise<PhoneLookupResult> {
  const scope = await teacherScope();
  if (!scope) return { status: "notFound" };

  const normalized = normalizePhone(phone);
  if (!normalized) return { status: "notFound" };

  if (!checkRateLimit(`people.phoneLookup:${scope.ctx.user.id}`, 20, 60_000)) {
    return { status: "rateLimited" };
  }

  const resolution = await resolveContact({ phone: normalized });
  if (resolution.kind !== "matched") return { status: "notFound" };

  const match = await describeMatch(scope.ctx.center.id, resolution.match, {
    phone: normalized,
  });
  return { status: "found", match };
}

// ── Add ────────────────────────────────────────────────────────────────────

export async function createTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = teacherCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, firstName, lastName, email, phone, altPhone, linkUserId } =
    parsed.data;
  const centerId = scope.ctx.center.id;

  const contact = { email, phone };
  const resolution = await resolveContact(contact);

  // The email belongs to one person and the phone to another — merging two
  // identities is a manual, audited admin action (docs/02 §3), not this form.
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  // The name to seed onto this center's record: the existing person's real
  // name when linking to a match, or the form's own input for a brand-new
  // person (docs/01 §6) — editable here immediately either way, no lock.
  const name = seedLocalName(resolution, { firstName, lastName });

  // Nothing matched: create the person (seeding the global User from the
  // entered contact — docs/01 §6) and this center's membership, atomically.
  if (resolution.kind === "none") {
    if (linkUserId) return { error: "matchGone" };
    try {
      const membership = await prisma.$transaction(async (tx) => {
        const person = await createPerson(
          { firstName, lastName, email, phone, altPhone, locale },
          tx,
        );
        return tx.membership.create({
          data: scopedData(centerId, {
            userId: person.id,
            role: "TEACHER",
            joinedAt: new Date(),
            firstName: name.firstName,
            lastName: name.lastName,
            email,
            phone,
            altPhone,
          }),
        });
      });

      await writeAuditLog({
        centerId,
        actorUserId: scope.ctx.user.id,
        action: "membership.create",
        entityType: "Membership",
        entityId: membership.id,
        after: { role: "TEACHER", via: "teacher.add", linked: false },
      });

      revalidateTeacherList(locale);
      return { status: "created" };
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "contactInUse" };
      throw error;
    }
  }

  // Someone matched. Show them before doing anything — "this person already
  // exists", never a silent merge (spec §5).
  const match = await describeMatch(centerId, resolution.match, contact);
  if (linkUserId !== resolution.match.user.id) {
    return { status: "matchFound", match };
  }

  if (match.existingHere === "teacher") return { error: "alreadyTeacher" };

  // Re-activating a former teacher is the same membership coming back, not a
  // second one — Membership is unique on (userId, centerId, role). Either
  // way, this center's own contact record is written fresh from the form.
  const existing = await scope.db.teachers.findByUserId(resolution.match.user.id);
  if (existing) {
    await scope.db.teachers.update(existing.id, {
      active: true,
      joinedAt: existing.joinedAt ?? new Date(),
      firstName: name.firstName,
      lastName: name.lastName,
      email,
      phone,
      altPhone,
    });

    await writeAuditLog({
      centerId,
      actorUserId: scope.ctx.user.id,
      action: "membership.activate",
      entityType: "Membership",
      entityId: existing.id,
      before: { active: existing.active },
      after: { active: true, via: "teacher.add", linked: true },
    });

    revalidateTeacherList(locale);
    return { status: "created" };
  }

  const membership = await scope.db.teachers.create({
    userId: resolution.match.user.id,
    role: "TEACHER",
    joinedAt: new Date(),
    firstName: name.firstName,
    lastName: name.lastName,
    email,
    phone,
    altPhone,
  });

  await writeAuditLog({
    centerId,
    actorUserId: scope.ctx.user.id,
    action: "membership.create",
    entityType: "Membership",
    entityId: membership.id,
    after: {
      role: "TEACHER",
      via: "teacher.add",
      linked: true,
      matchedOn: match.matchedOn,
    },
  });

  revalidateTeacherList(locale);
  return { status: "created" };
}

// ── Edit ───────────────────────────────────────────────────────────────────

export async function updateTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = teacherUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    membershipId,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    isTrustedTeacher,
  } = parsed.data;

  const teacher = await scope.db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;

  // This center's own record — name included — is always editable, with no
  // lock of any kind (docs/01 §6).
  await scope.db.teachers.update(teacher.id, {
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    isTrustedTeacher,
  });

  revalidateTeacherDetail(locale, teacher.id);
  revalidateTeacherList(locale);
  return { status: "saved" };
}

export async function setTeacherActiveAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = membershipActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { membershipId, active, locale } = parsed.data;
  const teacher = await scope.db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;
  if (teacher.active === active) return { status: "saved" };

  await scope.db.teachers.update(teacher.id, {
    active,
    ...(active && !teacher.joinedAt ? { joinedAt: new Date() } : {}),
  });

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: active ? "membership.activate" : "membership.deactivate",
    entityType: "Membership",
    entityId: teacher.id,
    before: { active: teacher.active },
    after: { active },
  });

  // Active/inactive shows on the list row and the detail header only.
  revalidateTeacherList(locale);
  revalidateTeacherDetail(locale, teacher.id);
  return { status: "saved" };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  // Delete is a Manager/Owner action, never a receptionist's (spec §3).
  if (!ctxCan(ctx, "teacher.delete")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = membershipActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { membershipId, locale } = parsed.data;
  const teacher = await db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;

  // A teacher who already carries classes or sessions is deactivated, not
  // deleted — the schedule and its money history must keep resolving.
  if ((await teacherDeleteBlockers(db, teacher.userId)) > 0) {
    return { error: "teacherInUse" };
  }

  await db.teachers.remove(teacher.id);
  // Their block-list here goes with the relationship.
  const blocks = await db.studentBlocks.list({
    scope: "TEACHER",
    refId: teacher.userId,
  });
  for (const block of blocks) await db.studentBlocks.remove(block.id);

  const personDeleted = await deletePersonIfOrphaned(teacher.userId);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "membership.delete",
    entityType: "Membership",
    entityId: teacher.id,
    before: {
      role: "TEACHER",
      userId: teacher.userId,
      name: fullName(localName(teacher, teacher.user)),
    },
    after: { personDeleted, blocksRemoved: blocks.length },
  });

  revalidateTeacherList(locale);
  // Same fix as deleteStudentAction (M18, docs/00 §7.1): the delete control
  // lives on /teachers/[id] itself, so without a redirect the implicit
  // post-action refresh re-fetches the deleted row and 404s.
  redirect({ href: ROUTES.centerTeachers, locale });
  return { status: "deleted" };
}

// ── Block-list (block a student from this teacher) ─────────────────────────

export async function blockStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.block")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = blockCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, teacherUserId, studentProfileId, reason } = parsed.data;

  // Both sides are re-resolved inside this center: a teacher or a student from
  // another center simply does not exist here.
  const teacher = await db.teachers.findByUserId(teacherUserId);
  if (!teacher) return NOT_FOUND;

  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  if (
    await db.studentBlocks.isBlocked("TEACHER", teacherUserId, student.userId)
  ) {
    return { error: "alreadyBlocked" };
  }

  const block = await db.studentBlocks.create({
    scope: "TEACHER",
    refId: teacherUserId,
    blockedUserId: student.userId,
    reason,
  });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.block",
    entityType: "StudentBlock",
    entityId: block.id,
    after: {
      scope: "TEACHER",
      teacherUserId,
      studentProfileId: student.id,
      reason,
    },
  });

  revalidateTeacherDetail(locale, teacher.id);
  return { status: "created" };
}

export async function unblockStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "student.block")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = blockRemoveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const block = await db.studentBlocks.findById(parsed.data.blockId);
  if (!block) return NOT_FOUND;

  await db.studentBlocks.remove(block.id);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.unblock",
    entityType: "StudentBlock",
    entityId: block.id,
    before: {
      scope: block.scope,
      refId: block.refId,
      blockedUserId: block.blockedUserId,
      reason: block.reason,
    },
  });

  const teacher = await db.teachers.findByUserId(block.refId);
  if (teacher) revalidateTeacherDetail(parsed.data.locale, teacher.id);
  return { status: "deleted" };
}
