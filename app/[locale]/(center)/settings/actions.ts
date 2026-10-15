"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { MATRIX_ROLES, PERMISSIONS, editableActionsFor } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { scoped, scopedIgnoringVisibilityWindow, type ScopedDb } from "@/lib/db/scoped";
import {
  listPermissionGrants,
  savePermissionGrants,
  type PermissionGrantWrite,
} from "@/lib/db/permissions";
import {
  roomCombinationUsage,
  setRoomLinks,
} from "@/lib/db/room-sets";
import { DEFAULT_TIMEZONE, dateKey } from "@/lib/scheduling";
import { createTerm, deleteTerm, setTermActive, updateTerm } from "@/lib/db/terms";
import {
  createPaymentMethod,
  deletePaymentMethod,
  renamePaymentMethod,
  setPaymentMethodActive,
} from "@/lib/db/payment-methods";
import {
  countCenterGradeSelectionsUnderSystem,
  countCenterSubjectSelectionsUnderGrade,
  findSelectionById,
  removeCatalogSelection,
  selectCatalogEntry,
  setCatalogSelectionActive,
  updateCatalogSelection,
} from "@/lib/db/catalog";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  cardLayoutSchema,
  catalogDeselectSchema,
  catalogSelectSchema,
  catalogSelectionToggleSchema,
  catalogSelectionUpdateSchema,
  generalSettingsSchema,
  paymentMethodSchema,
  paymentMethodUpdateSchema,
  permissionMatrixSchema,
  recordDeleteSchema,
  recordToggleSchema,
  roomLinksSchema,
  roomSchema,
  roomUpdateSchema,
  termSchema,
  termUpdateSchema,
} from "@/lib/validation/settings";
import { nameClashes } from "@/lib/like";

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

// ── Rooms — the one master-data entity still centre-authored; education
// systems/grades/subjects moved to the global catalog at M13, see the
// "Academic catalog" section below. ─────────────────────────────────────────

/** "Now" at the centre — what "a future session" is measured against (R3). */
function centreClock(ctx: TenantContext) {
  return { now: new Date(), timeZone: ctx.settings?.timezone ?? DEFAULT_TIMEZONE };
}

/**
 * R3: a room an active class or a non-closed future session uses as part of
 * a **combined** room set cannot be deactivated or deleted — the refusal
 * names how many, so staff know what to move first.
 */
async function roomInCombinationRefusal(
  ctx: TenantContext,
  roomId: string,
): Promise<ActionState | null> {
  const usage = await roomCombinationUsage(prisma, ctx.center.id, roomId, centreClock(ctx));
  if (usage.classes + usage.sessions === 0) return null;
  return { error: "roomInCombination", errorValues: usage };
}

async function toggleRoomRecord(formData: FormData): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const row = await scope.db.rooms.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  if (!parsed.data.active) {
    const refusal = await roomInCombinationRefusal(scope.ctx, row.id);
    if (refusal) return refusal;
  }

  await scope.db.rooms.update(row.id, { active: parsed.data.active });
  revalidateSettings(parsed.data.locale);
  return { status: "saved" };
}

async function deleteRoomRecord(formData: FormData): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const row = await scope.db.rooms.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  const refusal = await roomInCombinationRefusal(scope.ctx, row.id);
  if (refusal) return refusal;

  // Rows that point at this one. Prisma's default action for this optional
  // relation is SET NULL, which would silently orphan a class's room — so we
  // refuse the delete ourselves and let the center deactivate instead. R3:
  // a class or session that uses it as an *extra* room counts too (their
  // cascade would silently shrink a recorded room set). Its links alone do
  // not block: they cascade with the room.
  // Every session counts, however old (SEC-62's "integrity" opt-out).
  const history = scopedIgnoringVisibilityWindow(scope.ctx, "integrity");
  const [classes, sessions, classExtras, sessionExtras] = await Promise.all([
    scope.db.classGroups.count({ roomId: row.id }),
    history.sessions.count({ roomId: row.id }),
    scope.db.classGroupRooms.countForRoom(row.id),
    scope.db.sessionRooms.countForRoom(row.id),
  ]);
  if (classes + sessions + classExtras + sessionExtras > 0) {
    return { error: "inUse" };
  }

  try {
    await scope.db.rooms.remove(row.id);
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

// ── The academic catalog (M13, R8) ──────────────────────────────────────────
// A centre picks from the platform-owned global catalog and edits only its own
// display names (Arabic and English) + price for that pick. Nothing here ever
// writes to a canonical CatalogEducationSystem/CatalogGrade/CatalogSubject
// row, and there is no way to suggest one: a centre that needs an entry
// contacts the platform, and a platform admin adds it (/admin/catalog,
// docs/00-master-product-spec.md §5.1).

export async function selectCatalogEntryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = catalogSelectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { kind, catalogId, basePrice, locale } = parsed.data;
  const result = await selectCatalogEntry(
    prisma,
    scope.ctx.center.id,
    kind,
    catalogId,
    null,
    basePrice,
  );
  if (!result.ok) {
    return result.error === "alreadySelected"
      ? { error: "catalogAlreadySelected" }
      : NOT_FOUND;
  }

  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateCatalogSelectionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = catalogSelectionUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { selectionId, displayNameAr, displayNameEn, basePrice, locale } = parsed.data;
  const existing = await findSelectionById(prisma, scope.ctx.center.id, selectionId);
  if (!existing) return NOT_FOUND;

  const nextBasePrice = existing.kind === "EDUCATION_SYSTEM" ? basePrice : null;
  const updated = await updateCatalogSelection(prisma, selectionId, {
    displayNameAr,
    displayNameEn,
    basePrice: nextBasePrice,
  });

  // A rename (or a price change) is a centre-visible change to what staff,
  // teachers and students read — audited with before/after (CLAUDE.md rule 7).
  // D-20: the typed display names stay on the selection; the audit row says
  // which one changed, and carries the price itself.
  const renamedAr = existing.displayNameAr !== updated.displayNameAr;
  const renamedEn = existing.displayNameEn !== updated.displayNameEn;
  if (renamedAr || renamedEn || existing.basePrice !== updated.basePrice) {
    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: "catalog.selection.update",
      entityType: "CenterCatalogSelection",
      entityId: selectionId,
      before: { kind: existing.kind, basePrice: existing.basePrice },
      after: { kind: existing.kind, basePrice: updated.basePrice, renamedAr, renamedEn },
    });
  }
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleCatalogSelectionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = catalogSelectionToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { selectionId, active, locale } = parsed.data;
  const existing = await findSelectionById(prisma, scope.ctx.center.id, selectionId);
  if (!existing) return NOT_FOUND;

  await setCatalogSelectionActive(prisma, selectionId, active);
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function deselectCatalogEntryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = catalogDeselectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { selectionId, locale } = parsed.data;
  const existing = await findSelectionById(prisma, scope.ctx.center.id, selectionId);
  if (!existing) return NOT_FOUND;

  // Rows that point at this one — refuse the deselect rather than silently
  // orphaning a class/session/student that still relies on it.
  let inUse = 0;
  if (existing.kind === "EDUCATION_SYSTEM" && existing.educationSystemId) {
    const [grades, classes] = await Promise.all([
      countCenterGradeSelectionsUnderSystem(prisma, scope.ctx.center.id, existing.educationSystemId),
      scope.db.classGroups.count({ educationSystemId: existing.educationSystemId }),
    ]);
    inUse = grades + classes;
  } else if (existing.kind === "GRADE" && existing.gradeId) {
    const [subjects, classes, students] = await Promise.all([
      countCenterSubjectSelectionsUnderGrade(prisma, scope.ctx.center.id, existing.gradeId),
      scope.db.classGroups.count({ gradeId: existing.gradeId }),
      scope.db.students.count({ gradeId: existing.gradeId }),
    ]);
    inUse = subjects + classes + students;
  } else if (existing.kind === "SUBJECT" && existing.subjectId) {
    inUse = await scope.db.classGroups.count({ subjectId: existing.subjectId });
  }
  if (inUse > 0) return { error: "inUse" };

  await removeCatalogSelection(prisma, selectionId);
  revalidateSettings(locale);
  return { status: "deleted" };
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

  const { name, capacity, locale } = parsed.data;
  // SEC-61: compared by the one name key, never with an (I)LIKE.
  if (nameClashes(name, await scope.db.rooms.list())) return { fieldErrors: { name: "duplicateName" } };

  await scope.db.rooms.create({ name, capacity });
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

  const { id, name, capacity, locale } = parsed.data;
  if (!(await scope.db.rooms.findById(id))) return NOT_FOUND;

  if (nameClashes(name, await scope.db.rooms.list({ NOT: { id } }))) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.rooms.update(id, { name, capacity });
  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return toggleRoomRecord(formData);
}

export async function deleteRoomAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteRoomRecord(formData);
}

/**
 * "Can be combined with" (R3) — makes one room's links exactly the posted
 * set. Same gate as the rest of rooms (`center.settings.edit`); every rule
 * that can refuse (self-link, a room from another centre, unlinking a pair
 * an active class or a non-closed future session still uses) lives in
 * `lib/db/room-sets.ts`. Each link and unlink is audited.
 */
export async function setRoomLinksAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = roomLinksSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, roomId, linkedRoomIds } = parsed.data;

  const result = await setRoomLinks(
    prisma,
    scope.ctx.center.id,
    roomId,
    linkedRoomIds,
    centreClock(scope.ctx),
  );
  if (!result.ok) {
    if (result.error === "combinationInUse") {
      return {
        error: "combinationInUse",
        errorValues: { classes: result.classes ?? 0, sessions: result.sessions ?? 0 },
      };
    }
    return { error: result.error === "roomNotFound" ? "notFound" : result.error };
  }

  for (const [action, ids] of [
    ["room.link", result.added],
    ["room.unlink", result.removed],
  ] as const) {
    for (const otherRoomId of ids) {
      await writeAuditLog({
        centerId: scope.ctx.center.id,
        actorUserId: scope.ctx.user.id,
        action,
        entityType: "Room",
        entityId: roomId,
        after: { roomId, otherRoomId },
      });
    }
  }

  revalidateSettings(locale);
  return { status: "saved" };
}

// ── Payment methods (R1) ───────────────────────────────────────────────────
// Same gate as rooms (`center.settings.edit` — no new matrix action). Every
// rule that can refuse a change (last active method, referenced → deactivate
// instead of delete) lives in lib/db/payment-methods.ts; these actions only
// resolve the scope, validate, call in, and audit. A recorded payment keeps
// its own frozen `methodLabelSnapshot`, so nothing here can relabel history.

export async function createPaymentMethodAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = paymentMethodSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, locale } = parsed.data;
  const result = await createPaymentMethod(prisma, scope.ctx.center.id, name);
  if (!result.ok) return { fieldErrors: { name: result.error } };

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "paymentMethod.create",
    entityType: "CenterPaymentMethod",
    entityId: result.method.id,
    after: { active: result.method.active },
  });

  revalidateSettings(locale);
  return { status: "created" };
}

export async function updatePaymentMethodAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = paymentMethodUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, locale } = parsed.data;
  const result = await renamePaymentMethod(prisma, scope.ctx.center.id, id, name);
  if (!result.ok) {
    return result.error === "duplicateName"
      ? { fieldErrors: { name: "duplicateName" } }
      : NOT_FOUND;
  }

  if (result.before.name !== name) {
    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: "paymentMethod.rename",
      entityType: "CenterPaymentMethod",
      entityId: id,
      after: { renamed: true },
    });
  }

  revalidateSettings(locale);
  return { status: "saved" };
}

export async function togglePaymentMethodAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, active, locale } = parsed.data;
  const result = await setPaymentMethodActive(prisma, scope.ctx.center.id, id, active);
  if (!result.ok) return { error: result.error };

  if (result.before.active !== active) {
    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: active ? "paymentMethod.activate" : "paymentMethod.deactivate",
      entityType: "CenterPaymentMethod",
      entityId: id,
      before: { active: result.before.active },
      after: { active },
    });
  }

  revalidateSettings(locale);
  return { status: "saved" };
}

export async function deletePaymentMethodAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale } = parsed.data;
  const result = await deletePaymentMethod(prisma, scope.ctx.center.id, id);
  if (!result.ok) return { error: result.error };

  // A referenced method is deactivated instead (M18 convention) — audited as
  // what actually happened, with the delete request noted.
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action:
      result.outcome === "deleted" ? "paymentMethod.delete" : "paymentMethod.deactivate",
    entityType: "CenterPaymentMethod",
    entityId: id,
    before: { active: result.before.active },
    after:
      result.outcome === "deleted"
        ? null
        : { active: false, trigger: "deleteRequestedButReferencedByPayments" },
  });

  revalidateSettings(locale);
  return { status: result.outcome };
}

// ── Terms (R4) ─────────────────────────────────────────────────────────────
// Same gate as rooms and payment methods (`center.settings.edit`). A term is
// a preset whose dates a class COPIES — nothing references it — so renaming
// or redating one moves no class and a delete is always a hard delete. The
// case-insensitive name rule and the period rule live in lib/db/terms.ts.
// Every change is audited.

/** A term's audit shape — its dates and state; never its typed name (D-20). */
function termJson(term: { startDate: Date; endDate: Date; active: boolean }) {
  return {
    startDate: dateKey(term.startDate),
    endDate: dateKey(term.endDate),
    active: term.active,
  };
}

export async function createTermAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = termSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, name, startDate, endDate } = parsed.data;
  const result = await createTerm(prisma, scope.ctx.center.id, { name, startDate, endDate });
  if (!result.ok) {
    return { fieldErrors: { [result.error === "duplicateName" ? "name" : "endDate"]: result.error } };
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "term.create",
    entityType: "CenterTerm",
    entityId: result.term.id,
    after: termJson(result.term),
  });

  revalidateSettings(locale);
  return { status: "created" };
}

export async function updateTermAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = termUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, id, name, startDate, endDate } = parsed.data;
  const result = await updateTerm(prisma, scope.ctx.center.id, id, { name, startDate, endDate });
  if (!result.ok) {
    if (result.error === "notFound") return NOT_FOUND;
    return { fieldErrors: { [result.error === "duplicateName" ? "name" : "endDate"]: result.error } };
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "term.update",
    entityType: "CenterTerm",
    entityId: id,
    before: termJson(result.before),
    after: termJson(result.term),
  });

  revalidateSettings(locale);
  return { status: "saved" };
}

export async function toggleTermAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, active, locale } = parsed.data;
  const result = await setTermActive(prisma, scope.ctx.center.id, id, active);
  if (!result.ok) return NOT_FOUND;

  if (result.before.active !== active) {
    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: active ? "term.activate" : "term.deactivate",
      entityType: "CenterTerm",
      entityId: id,
      before: termJson(result.before),
      after: { active },
    });
  }

  revalidateSettings(locale);
  return { status: "saved" };
}

export async function deleteTermAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = recordDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale } = parsed.data;
  const result = await deleteTerm(prisma, scope.ctx.center.id, id);
  if (!result.ok) return NOT_FOUND;

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "term.delete",
    entityType: "CenterTerm",
    entityId: id,
    before: termJson(result.before),
  });

  revalidateSettings(locale);
  return { status: "deleted" };
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
    teacherEditDeadlineHours,
    dataVisibilityDays,
  } = parsed.data;

  const before = await scope.db.settings.get();
  await scope.db.settings.save({
    defaultShareType,
    defaultShareValue,
    teacherTimeoutDays,
    defaultLateThreshold,
    timezone,
    scheduleConflictPolicy,
    teacherEditDeadlineHours,
    dataVisibilityDays,
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
          dataVisibilityDays: before.dataVisibilityDays,
          teacherEditDeadlineHours: before.teacherEditDeadlineHours,
        }
      : null,
    after: {
      defaultShareType,
      defaultShareValue,
      teacherTimeoutDays,
      defaultLateThreshold,
      timezone,
      scheduleConflictPolicy,
      dataVisibilityDays,
      // SEC-74: the edit deadline is a setting too — it was missing here.
      teacherEditDeadlineHours,
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

// ── The permission matrix (M12) ────────────────────────────────────────────

/**
 * `/settings/permissions` — OWNER only, by UI (the page redirects a non-owner
 * away) **and** here, by direct action call (docs/03-build-order.md M12
 * "Done when"). `permission.manage` is one of the ceiling-forced ownership
 * actions (`lib/auth/permissions.ts`), so this `ctxCan` check can never be
 * satisfied by any stored grant — only by actually being OWNER.
 */
export async function savePermissionMatrixAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "permission.manage")) return FORBIDDEN;

  const parsed = permissionMatrixSchema.safeParse({
    locale: formData.get("locale"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale } = parsed.data;

  const before = await listPermissionGrants(prisma, ctx.center.id);

  // The grid submits one `grant__<role>__<action>` checkbox per editable
  // cell. Which cells are editable is decided here, server-side, from the
  // same `editableActionsFor()` the page rendered the grid from — a forged
  // field for a role/action pair outside that set (an owner-only action, or
  // one on that role's forbidden ceiling) is silently dropped, never written,
  // so the ceiling holds even against a hand-crafted POST.
  const writes: PermissionGrantWrite[] = [];
  for (const role of MATRIX_ROLES) {
    const editable = new Set(editableActionsFor(role));
    for (const action of PERMISSIONS) {
      if (!editable.has(action)) continue;
      writes.push({
        role,
        action,
        allowed: formData.get(`grant__${role}__${action}`) === "on",
      });
    }
  }

  await savePermissionGrants(prisma, ctx.center.id, writes);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "permission.matrix.update",
    entityType: "PermissionGrant",
    entityId: ctx.center.id,
    before,
    after: writes,
  });

  revalidateSettings(locale);
  return { status: "saved" };
}
