"use server";

import { revalidatePath } from "next/cache";

import { studentBranches, type StudentBranch } from "@/app/[locale]/(student)/student/assessments/scope";
import { getCurrentUser } from "@/lib/auth/session";
import { attemptHeartbeat, saveAnswer, startAttempt, submitAttempt } from "@/lib/db/assessment-attempts";
import type { HeartbeatResult } from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { ROUTES } from "@/lib/routes";
import {
  heartbeatArgs,
  saveAnswerArgs,
  startAttemptSchema,
  submitAttemptArgs,
  type StartAttemptState,
} from "@/lib/validation/student-assessments";

/**
 * A student's own attempts (W3a, D-W07, D-W09). Every action resolves the
 * person's profiles on the server and tries each branch: an attempt or an
 * assessment is found only at the branch that holds it, and only if it is
 * theirs. No answer here ever carries correctness (rule 11).
 */

type Failure = { ok: false; error: string };

/** The first branch where this is not "not found" — a union of per-branch writes (U7). */
async function atOwnBranch<T extends { ok: boolean }>(
  branches: StudentBranch[],
  run: (branch: StudentBranch) => Promise<T | Failure>,
): Promise<T | Failure> {
  for (const branch of branches) {
    const result = await run(branch);
    if (result.ok || (result as Failure).error !== "notFound") return result;
  }
  return { ok: false, error: "notFound" };
}

function withinLimit(userId: string): Promise<boolean> {
  const { limit, windowMs } = RATE_LIMITS.assessmentWritePerUser;
  return checkRateLimit(`assessmentWritePerUser:${userId}`, limit, windowMs);
}

function revalidateStudentPages(locale: string) {
  revalidatePath(`/${locale}${ROUTES.studentAssessments}`, "layout");
}

/** Start, or resume the one attempt. The confirmation is the dialog in front of this. */
export async function startAttemptAction(_state: StartAttemptState, formData: FormData): Promise<StartAttemptState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };
  const parsed = startAttemptSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  if (!(await withinLimit(user.id))) return { error: "rateLimited" };
  const { locale, assessmentId } = parsed.data;

  const branches = await studentBranches(user.id);
  if (branches.length === 0) return { error: "forbidden" };
  const result = await atOwnBranch(branches, ({ student }) => startAttempt(prisma, student, assessmentId, new Date()));
  if (!result.ok) return { error: (result as Failure).error };
  revalidateStudentPages(locale);
  return { status: "started" };
}

/** Autosave of one answer. Answers only whether it was saved. */
export async function saveAnswerAction(...raw: unknown[]): Promise<{ ok: true } | Failure> {
  const parsed = saveAnswerArgs.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const [attemptId, questionId, optionId] = parsed.data;
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "forbidden" };
  if (!(await withinLimit(user.id))) return { ok: false, error: "rateLimited" };

  const branches = await studentBranches(user.id);
  return atOwnBranch(branches, ({ student }) => saveAnswer(prisma, student, attemptId, { questionId, optionId }, new Date()));
}

/** "Still here" from an open exam: refreshes `lastSeenAt` and answers the server's clock. */
export async function attemptHeartbeatAction(...raw: unknown[]): Promise<HeartbeatResult | Failure> {
  const parsed = heartbeatArgs.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const [attemptId] = parsed.data;
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "forbidden" };

  const branches = await studentBranches(user.id);
  return atOwnBranch<Extract<HeartbeatResult, { ok: true }>>(branches, ({ student }) =>
    attemptHeartbeat(prisma, student, attemptId, new Date()),
  );
}

/** The student's own submit, or the client's when the countdown ends. The server decides what it counts as. */
export async function submitAttemptAction(...raw: unknown[]): Promise<{ ok: true } | Failure> {
  const parsed = submitAttemptArgs.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const [locale, attemptId] = parsed.data;
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "forbidden" };

  const branches = await studentBranches(user.id);
  const result = await atOwnBranch(branches, ({ student }) => submitAttempt(prisma, student, attemptId, new Date()));
  if (!result.ok) return { ok: false, error: (result as Failure).error };
  revalidateStudentPages(locale);
  return { ok: true };
}
