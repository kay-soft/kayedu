"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  branchSchema,
  branchUpdateSchema,
  cardLayoutSchema,
  educationSystemSchema,
  educationSystemUpdateSchema,
  generalSettingsSchema,
  gradeSchema,
  gradeUpdateSchema,
  permissionGrantsSchema,
  recordDeleteSchema,
  recordToggleSchema,
  roomSchema,
  roomUpdateSchema,
  subjectSchema,
  subjectUpdateSchema,
} from "@/lib/validation/settings";

/**
 * Center configuration (M2). Every action follows docs/02 §7:
 * getTenantContext() → permission check → zod → scoped write → audit if
 * sensitive → revalidate.
 *
 * Nothing here reads a centerId from the client. Foreign keys arriving from a
 * form (a grade's education system, a room's branch) are re-resolved through
 * the scoped helpers, so an id belonging to another center simply does not
 * exist as far as this center is concerned.
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

/** Resolves the context and enforces `center.settings.edit`. */
async function editorScope(): Promise<Scope | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "center.settings.edit")) return null;
  return { ctx, db: scoped(ctx) };
}

/** The whole settings subtree shares one revalidation. */
function revalidateSettings(locale: string): void {
  revalidatePath(`/${locale}/settings`, "layout");
}

// ── Generic master-data plumbing ───────────────────────────────────────────

type MasterDataKind =
  | "educationSystem"
  | "grade"
  | "subject"
  | "branch"
  | "room";

/**
 * The slice of a scoped collection the shared toggle/delete paths need.
 * Structural on purpose — each concrete collection satisfies it.
 */
type ManagedCollection = {
  findById: (id: string) => Promise<{ id: string; active: boolean } | null>;
  update: (id: string, data: { active: boolean }) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
};

function collectionFor(db: ScopedDb, kind: MasterDataKind): ManagedCollection {
  switch (kind) {
    case "educationSystem":
      return db.educationSystems;
    case "grade":
      return db.grades;
    case "subject":
      return db.subjects;
    case "branch":
      return db.branches;
    case "room":
      return db.rooms;
  }
}

/**
 * Rows that point at this one. Prisma's default action for these optional
 * relations is SET NULL, which would silently orphan a grade's subjects — so
 * we refuse the delete ourselves and let the center deactivate instead.
 */
async function referenceCount(
  db: ScopedDb,
  kind: MasterDataKind,
  id: string,
): Promise<number> {
  switch (kind) {
    case "educationSystem": {
      const [grades, classes] = await Promise.all([
        db.grades.count({ educationSystemId: id }),
        db.classGroups.count({ educationSystemId: id }),
      ]);
      return grades + classes;
    }
    case "grade": {
      const [subjects, classes, students] = await Promise.all([
        db.subjects.count({ gradeId: id }),
        db.classGroups.count({ gradeId: id }),
        db.students.count({ gradeId: id }),
      ]);
      return subjects + classes + students;
    }
    case "subject":
      return db.classGroups.count({ subjectId: id });
    case "branch": {
      const [rooms, sessions] = await Promise.all([
        db.rooms.count({ branchId: id }),
        db.sessions.count({ branchId: id }),
      ]);
      return rooms + sessions;
    }
    case "room": {
      const [classes, sessions] = await Promise.all([
        db.classGroups.count({ roomId: id }),
        db.sessions.count({ roomId: id }),
      ]);
      return classes + sessions;
    }
  }
}

/**
 * Names are what staff pick from in every later dropdown, so two identical
 * ones would be a daily papercut. Case-insensitive, within this center only.
 */
async function nameTaken(
  db: ScopedDb,
  kind: MasterDataKind,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const where = {
    name: { equals: name, mode: "insensitive" as const },
    ...(exceptId ? { NOT: { id: exceptId } } : {}),
  };
  switch (kind) {
    case "educationSystem":
      return (await db.educationSystems.count(where)) > 0;
    case "grade":
      return (await db.grades.count(where)) > 0;
    case "subject":
      return (await db.subjects.count(where)) > 0;
    case "branch":
      return (await db.branches.count(where)) > 0;
    case "room":
      return (await db.rooms.count(where)) > 0;
  }
}

/** Re-resolves a form-supplied foreign key inside the active center. */
async function resolveRef(
  lookup: (id: string) => Promise<unknown>,
  id: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (id === null) return { ok: true, id: null };
  const row = await lookup(id);
  return row ? { ok: true, id } : { ok: false };
}

async function toggleRecord(
  kind: MasterDataKind,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const collection = collectionFor(scope.db, kind);
  const row = await collection.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  await collection.update(row.id, { active: parsed.data.active });
  revalidateSettings(parsed.data.locale);
  return { status: "saved" };
}

async function deleteRecord(
  kind: MasterDataKind,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const collection = collectionFor(scope.db, kind);
  const row = await collection.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  if ((await referenceCount(scope.db, kind, row.id)) > 0) {
    return { error: "inUse" };
  }

  try {
    await collection.remove(row.id);
  } catch (error) {
    // A reference we did not think to count still must not corrupt anything.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return { error: "inUse" };
    }
    throw error;
  }

  revalidateSettings(parsed.data.locale);
  return { status: "deleted" };
}

// ── Education systems ──────────────────────────────────────────────────────

export async function createEducationSystemAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = educationSystemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, basePrice, locale } = parsed.data;
  if (await nameTaken(scope.db, "educationSystem", name)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.educationSystems.create({ name, basePrice });
  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateEducationSystemAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = educationSystemUpdateSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, basePrice, locale } = parsed.data;
  const existing = await scope.db.educationSystems.findById(id);
  if (!existing) return NOT_FOUND;

  if (await nameTaken(scope.db, "educationSystem", name, id)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.educationSystems.update(id, { name, basePrice });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleEducationSystemAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRecord("educationSystem", formData);
}

export async function deleteEducationSystemAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRecord("educationSystem", formData);
}

// ── Grades ─────────────────────────────────────────────────────────────────

export async function createGradeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = gradeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, educationSystemId, locale } = parsed.data;
  const ref = await resolveRef(
    (id) => scope.db.educationSystems.findById(id),
    educationSystemId,
  );
  if (!ref.ok) return { fieldErrors: { educationSystemId: "notFound" } };
  if (await nameTaken(scope.db, "grade", name)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.grades.create({ name, educationSystemId: ref.id });
  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateGradeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = gradeUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, educationSystemId, locale } = parsed.data;
  if (!(await scope.db.grades.findById(id))) return NOT_FOUND;

  const ref = await resolveRef(
    (refId) => scope.db.educationSystems.findById(refId),
    educationSystemId,
  );
  if (!ref.ok) return { fieldErrors: { educationSystemId: "notFound" } };
  if (await nameTaken(scope.db, "grade", name, id)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.grades.update(id, { name, educationSystemId: ref.id });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleGradeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRecord("grade", formData);
}

export async function deleteGradeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRecord("grade", formData);
}

// ── Subjects ───────────────────────────────────────────────────────────────

export async function createSubjectAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = subjectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, gradeId, locale } = parsed.data;
  const ref = await resolveRef((id) => scope.db.grades.findById(id), gradeId);
  if (!ref.ok) return { fieldErrors: { gradeId: "notFound" } };

  // A subject name repeats legitimately across grades (Maths in every year),
  // so uniqueness is per grade rather than per center.
  const clash = await scope.db.subjects.count({
    name: { equals: name, mode: "insensitive" },
    gradeId: ref.id,
  });
  if (clash > 0) return { fieldErrors: { name: "duplicateName" } };

  await scope.db.subjects.create({ name, gradeId: ref.id });
  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateSubjectAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = subjectUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, gradeId, locale } = parsed.data;
  if (!(await scope.db.subjects.findById(id))) return NOT_FOUND;

  const ref = await resolveRef(
    (refId) => scope.db.grades.findById(refId),
    gradeId,
  );
  if (!ref.ok) return { fieldErrors: { gradeId: "notFound" } };

  const clash = await scope.db.subjects.count({
    name: { equals: name, mode: "insensitive" },
    gradeId: ref.id,
    NOT: { id },
  });
  if (clash > 0) return { fieldErrors: { name: "duplicateName" } };

  await scope.db.subjects.update(id, { name, gradeId: ref.id });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleSubjectAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRecord("subject", formData);
}

export async function deleteSubjectAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRecord("subject", formData);
}

// ── Branches ───────────────────────────────────────────────────────────────

export async function createBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = branchSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, address, locale } = parsed.data;
  if (await nameTaken(scope.db, "branch", name)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.branches.create({ name, address });
  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = branchUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, address, locale } = parsed.data;
  if (!(await scope.db.branches.findById(id))) return NOT_FOUND;
  if (await nameTaken(scope.db, "branch", name, id)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.branches.update(id, { name, address });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRecord("branch", formData);
}

export async function deleteBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRecord("branch", formData);
}

// ── Rooms ──────────────────────────────────────────────────────────────────

export async function createRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = roomSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, capacity, branchId, locale } = parsed.data;
  const ref = await resolveRef(
    (id) => scope.db.branches.findById(id),
    branchId,
  );
  if (!ref.ok) return { fieldErrors: { branchId: "notFound" } };

  // Room names repeat across branches ("Room 1" in each), so scope the clash
  // check to the branch the room sits in.
  const clash = await scope.db.rooms.count({
    name: { equals: name, mode: "insensitive" },
    branchId: ref.id,
  });
  if (clash > 0) return { fieldErrors: { name: "duplicateName" } };

  await scope.db.rooms.create({ name, capacity, branchId: ref.id });
  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = roomUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, capacity, branchId, locale } = parsed.data;
  if (!(await scope.db.rooms.findById(id))) return NOT_FOUND;

  const ref = await resolveRef(
    (refId) => scope.db.branches.findById(refId),
    branchId,
  );
  if (!ref.ok) return { fieldErrors: { branchId: "notFound" } };

  const clash = await scope.db.rooms.count({
    name: { equals: name, mode: "insensitive" },
    branchId: ref.id,
    NOT: { id },
  });
  if (clash > 0) return { fieldErrors: { name: "duplicateName" } };

  await scope.db.rooms.update(id, { name, capacity, branchId: ref.id });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRecord("room", formData);
}

export async function deleteRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRecord("room", formData);
}

// ── General settings (default center cut, timeout, late threshold) ─────────

export async function saveGeneralSettingsAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = generalSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    defaultShareType,
    defaultShareValue,
    teacherTimeoutDays,
    defaultLateThreshold,
    timezone,
    scheduleConflictPolicy,
  } = parsed.data;

  const before = await scope.db.settings.get();
  await scope.db.settings.save({
    defaultShareType,
    defaultShareValue,
    teacherTimeoutDays,
    defaultLateThreshold,
    timezone,
    scheduleConflictPolicy,
  });

  // The default center cut is money configuration, so the change is audited
  // (CLAUDE.md rule 7). It never rewrites recorded payments — those carry
  // their own frozen snapshots.
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "center.settings.update",
    entityType: "CenterSettings",
    entityId: scope.ctx.center.id,
    before: before
      ? {
          defaultShareType: before.defaultShareType,
          defaultShareValue: before.defaultShareValue,
          teacherTimeoutDays: before.teacherTimeoutDays,
          defaultLateThreshold: before.defaultLateThreshold,
          timezone: before.timezone,
          scheduleConflictPolicy: before.scheduleConflictPolicy,
        }
      : null,
    after: {
      defaultShareType,
      defaultShareValue,
      teacherTimeoutDays,
      defaultLateThreshold,
      timezone,
      scheduleConflictPolicy,
    },
  });

  revalidateSettings(locale);
  return { status: "saved" };
}

// ── ID-card customization ──────────────────────────────────────────────────

export async function saveCardLayoutAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = cardLayoutSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { cardLayout, locale } = parsed.data;
  await scope.db.settings.save({
    // Prisma distinguishes "JSON null" from "clear the column"; an empty
    // editor means no customization at all.
    cardLayout:
      cardLayout === null
        ? Prisma.DbNull
        : (cardLayout as Prisma.InputJsonValue),
  });

  revalidateSettings(locale);
  return { status: "saved" };
}

// ── Receptionist permission grants ─────────────────────────────────────────

export async function savePermissionGrantsAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTenantContext("center");
  // Widening a role is a permission change, so it needs staff authority on
  // top of settings authority.
  if (!ctxCan(ctx, "center.settings.edit") || !ctxCan(ctx, "staff.manage")) {
    return FORBIDDEN;
  }
  const db = scoped(ctx);

  const parsed = permissionGrantsSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    receptionistCanViewProfit,
    receptionistCanCorrectAttendance,
  } = parsed.data;

  const before = await db.settings.get();
  await db.settings.save({
    receptionistCanViewProfit,
    receptionistCanCorrectAttendance,
  });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "center.permissions.update",
    entityType: "CenterSettings",
    entityId: ctx.center.id,
    before: before
      ? {
          receptionistCanViewProfit: before.receptionistCanViewProfit,
          receptionistCanCorrectAttendance:
            before.receptionistCanCorrectAttendance,
        }
      : null,
    after: { receptionistCanViewProfit, receptionistCanCorrectAttendance },
  });

  revalidateSettings(locale);
  return { status: "saved" };
}
