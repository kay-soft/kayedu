"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { dateKey } from "@/lib/scheduling";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  expenseCategoryDeleteSchema,
  expenseCategorySchema,
  expenseCategoryToggleSchema,
  expenseCategoryUpdateSchema,
  expenseCreateSchema,
  expenseDeleteSchema,
} from "@/lib/validation/analytics";

/**
 * Expenses (M6, spec §4.1 item 6): category CRUD + append-and-audit expense
 * entries. Every action follows docs/02 §7: getTenantContext() → permission
 * check → zod → scoped write → audit → revalidate. `expense.manage` is
 * OWNER/MANAGER only (lib/auth/permissions.ts) — a receptionist has no path
 * to this module at all, matching the profit-denial pattern (spec §3).
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
  const where = {
    name: { equals: name, mode: "insensitive" as const },
    ...(exceptId ? { NOT: { id: exceptId } } : {}),
  };
  return (await db.expenseCategories.count(where)) > 0;
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

  await scope.db.expenseCategories.create({ name });
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
  if (categoryId && !(await scope.db.expenseCategories.findById(categoryId))) {
    return { fieldErrors: { categoryId: "notFound" } };
  }

  const expense = await scope.db.expenses.create({
    categoryId,
    amount,
    date: new Date(`${date}T00:00:00.000Z`),
    note,
    recordedBy: scope.ctx.user.id,
  });

  // A financial change — audited (CLAUDE.md rule 7), same as recording a
  // Payment, even though Expense carries no snapshot machinery of its own.
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "expense.create",
    entityType: "Expense",
    entityId: expense.id,
    before: null,
    after: { categoryId, amount, date, note },
  });

  revalidateExpenses(locale);
  return { status: "created" };
}

export async function deleteExpenseAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await editorScope();
  if (!scope) return FORBIDDEN;

  const parsed = expenseDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const row = await scope.db.expenses.findById(parsed.data.id);
  if (!row) return NOT_FOUND;

  await scope.db.expenses.remove(row.id);

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "expense.delete",
    entityType: "Expense",
    entityId: row.id,
    before: {
      categoryId: row.categoryId,
      amount: row.amount,
      date: dateKey(row.date),
      note: row.note,
    },
    after: null,
  });

  revalidateExpenses(parsed.data.locale);
  return { status: "deleted" };
}
