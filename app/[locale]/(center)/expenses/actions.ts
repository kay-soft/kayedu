"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { expenseDateError } from "@/lib/db/visibility";
import { dateKey } from "@/lib/scheduling";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  expenseCategoryDeleteSchema,
  expenseCategorySchema,
  expenseCategoryToggleSchema,
  expenseCategoryUpdateSchema,
  expenseCreateSchema,
  expenseVoidSchema,
} from "@/lib/validation/analytics";
import { nameClashes } from "@/lib/like";

/**
 * Expenses (M6, spec §4.1 item 6): category CRUD + append-and-audit expense
 * entries. Every action follows docs/02 §7: getTenantContext() → permission
 * check → zod → scoped write → audit → revalidate. `expense.manage` is
 * OWNER/MANAGER only (lib/auth/permissions.ts) — a receptionist has no path
 * to this module at all, matching the profit-denial pattern (spec §3).
 *
 * SEC-2b (D-24, SEC-51): an expense may be **backdated within the centre's
 * visibility window** (never into a closed-off month the centre can no longer
 * see, never into the future), and is **voided — never deleted** — with who,
 * when and why kept on the row. Category create/rename/toggle/delete are
 * audited like every other money-adjacent change. Audit rows carry ids and
 * amounts only (D-20); the note and the void reason stay on the row.
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

async function editorScope(): Promise<Scope | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "expense.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateExpenses(locale: string): void {
  revalidatePath(`/${locale}/expenses`);
}

async function nameTaken(db: ScopedDb, name: string, exceptId?: string): Promise<boolean> {
  // SEC-61: compared by the one name key, never with an (I)LIKE.
  const others = await db.expenseCategories.list(exceptId ? { NOT: { id: exceptId } } : undefined);
  return nameClashes(name, others);
}

// ── Expense categories ──────────────────────────────────────────────────────

export async function createExpenseCategoryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseCategorySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { name, locale } = parsed.data;
  if (await nameTaken(scope.db, name)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  const category = await scope.db.expenseCategories.create({ name });
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "expenseCategory.create",
    entityType: "ExpenseCategory",
    entityId: category.id,
    after: { active: true },
  });
  revalidateExpenses(locale);
  return { status: "created" };
}

export async function updateExpenseCategoryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseCategoryUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { id, name, locale } = parsed.data;
  if (!(await scope.db.expenseCategories.findById(id))) return NOT_FOUND;
  if (await nameTaken(scope.db, name, id)) {
    return { fieldErrors: { name: "duplicateName" } };
  }

  await scope.db.expenseCategories.update(id, { name });
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "expenseCategory.rename",
    entityType: "ExpenseCategory",
    entityId: id,
  });
  revalidateExpenses(locale);
  return { status: "saved" };
}

export async function toggleExpenseCategoryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseCategoryToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const row = await scope.db.expenseCategories.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  await scope.db.expenseCategories.update(row.id, { active: parsed.data.active });
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: parsed.data.active ? "expenseCategory.activate" : "expenseCategory.deactivate",
    entityType: "ExpenseCategory",
    entityId: row.id,
    before: { active: row.active },
    after: { active: parsed.data.active },
  });
  revalidateExpenses(parsed.data.locale);
  return { status: "saved" };
}

export async function deleteExpenseCategoryAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseCategoryDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const row = await scope.db.expenseCategories.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  // A voided expense still references its category — it is a record, so the
  // category stays (deactivate it instead).
  const inUse = await scope.db.expenses.count({ categoryId: row.id });
  if (inUse > 0) return { error: "inUse" };

  try {
    await scope.db.expenseCategories.remove(row.id);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return { error: "inUse" };
    }
    throw error;
  }
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "expenseCategory.delete",
    entityType: "ExpenseCategory",
    entityId: row.id,
    before: { active: row.active },
  });

  revalidateExpenses(parsed.data.locale);
  return { status: "deleted" };
}

// ── Expenses ─────────────────────────────────────────────────────────────

export async function createExpenseAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { categoryId, amount, date, note, locale } = parsed.data;
  const dateError = expenseDateError(scope.ctx, date);
  if (dateError) return { fieldErrors: { date: dateError } };
  if (categoryId && !(await scope.db.expenseCategories.findById(categoryId))) {
    return { fieldErrors: { categoryId: "notFound" } };
  }

  // A financial change — audited (CLAUDE.md rule 7) in the same transaction
  // as the row (SEC-60), even though Expense carries no snapshot machinery.
  await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        centerId: scope.ctx.center.id,
        categoryId,
        amount,
        date,
        note,
        recordedBy: scope.ctx.user.id,
      },
    });
    await writeAuditLog(
      {
        centerId: scope.ctx.center.id,
        actorUserId: scope.ctx.user.id,
        action: "expense.create",
        entityType: "Expense",
        entityId: expense.id,
        after: { categoryId, amount, date: dateKey(date) },
      },
      tx,
    );
  });

  revalidateExpenses(locale);
  return { status: "created" };
}

/**
 * Voids an expense (D-24): it stays on the list, struck through, with who,
 * when and why — and leaves every total. Never a delete.
 */
export async function voidExpenseAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseVoidSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { id, reason, locale } = parsed.data;

  const row = await scope.db.expenses.findById(id);
  if (!row) return NOT_FOUND;
  if (row.voided) return { error: "alreadyVoided" };

  const voided = await prisma.$transaction(async (tx) => {
    const changed = await tx.expense.updateMany({
      where: { id, centerId: scope.ctx.center.id, voided: false },
      data: { voided: true, voidReason: reason, voidedAt: new Date(), voidedBy: scope.ctx.user.id },
    });
    if (changed.count !== 1) return false;
    await writeAuditLog(
      {
        centerId: scope.ctx.center.id,
        actorUserId: scope.ctx.user.id,
        action: "expense.void",
        entityType: "Expense",
        entityId: id,
        before: { amount: row.amount, voided: false },
        after: { voided: true },
      },
      tx,
    );
    return true;
  });
  if (!voided) return { error: "alreadyVoided" };

  revalidateExpenses(locale);
  return { status: "voided" };
}
