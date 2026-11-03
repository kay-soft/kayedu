/**
 * The assessment rules (W2, D-W01–D-W06, D-W30) — pure, no database, so
 * `check:assessments` runs them directly. Relative imports on purpose (the
 * lib/money.ts discipline). Data access lives in lib/db/assessments.ts.
 *
 * Also the ONE student-facing shape of an assessment (`toStudentAssessment`,
 * D-W09): it never carries `isCorrect` or any per-option correctness. W3's
 * student reads must go through it.
 */
import type { AssessmentType } from "@prisma/client";

import { dateKey, parseTimeToMinutes, zonedDateTimeToUtc } from "./scheduling.ts";

// ── Limits (D-W04, the W2 prompt's validation list) ────────────────────────

export const ASSESSMENT_LIMITS = {
  minOptions: 2,
  maxOptions: 5,
  /** A new question starts with this many empty options. */
  defaultOptions: 4,
  minPoints: 1,
  maxPoints: 100,
  defaultPoints: 1,
  maxQuestions: 200,
  questionText: 2_000,
  optionText: 500,
  title: 200,
  instructions: 2_000,
  minDuration: 1,
  maxDuration: 600,
} as const;

export const EXAM_DEFAULT_DURATION_MINUTES = 30;
/** D-W03: the default deadline is the next session's start minus this. */
export const HOMEWORK_DEADLINE_LEAD_MINUTES = 30;
/** D-W03: with no next session, the homework session's end plus this. */
export const HOMEWORK_FALLBACK_DAYS = 7;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ── Defaults per type (D-W02, D-W03, D-W05, D-W06) ─────────────────────────

export type AssessmentSettings = {
  durationMinutes: number | null;
  oneSitting: boolean;
  shuffle: boolean;
  showScore: boolean;
  showCorrectAnswers: boolean;
};

export function assessmentDefaults(type: AssessmentType): AssessmentSettings {
  return type === "EXAM"
    ? { durationMinutes: EXAM_DEFAULT_DURATION_MINUTES, oneSitting: false, shuffle: true, showScore: false, showCorrectAnswers: false }
    : { durationMinutes: null, oneSitting: false, shuffle: false, showScore: true, showCorrectAnswers: true };
}

// ── The default homework deadline (D-W03) ──────────────────────────────────

export type SessionSlot = { date: Date; startTime: string; endTime: string };

/** A session's start or end as a UTC instant, in its own frozen timezone (D-14). */
export function sessionInstant(slot: SessionSlot, edge: "start" | "end", timeZone: string): Date {
  const minutes = parseTimeToMinutes(edge === "start" ? slot.startTime : slot.endTime);
  return zonedDateTimeToUtc(dateKey(slot.date), minutes, timeZone);
}

export type NextSessionCandidate = {
  status: string;
  rescheduledToId: string | null;
  start: Date;
};

/**
 * The class's next session after `after`: SCHEDULED (never cancelled, live or
 * held) and not moved away. The earliest start wins.
 */
export function pickNextSessionStart(candidates: readonly NextSessionCandidate[], after: Date): Date | null {
  let best: Date | null = null;
  for (const candidate of candidates) {
    if (candidate.status !== "SCHEDULED" || candidate.rescheduledToId !== null) continue;
    if (candidate.start.getTime() <= after.getTime()) continue;
    if (!best || candidate.start.getTime() < best.getTime()) best = candidate.start;
  }
  return best;
}

export type HomeworkDeadlineBasis = "nextSession" | "fallback";

/** D-W03: the next session's start − 30 minutes, else this session's end + 7 days. */
export function defaultHomeworkDeadline(input: {
  sessionEnd: Date;
  nextSessionStart: Date | null;
}): { deadline: Date; basis: HomeworkDeadlineBasis } {
  if (input.nextSessionStart) {
    return {
      deadline: new Date(input.nextSessionStart.getTime() - HOMEWORK_DEADLINE_LEAD_MINUTES * MINUTE_MS),
      basis: "nextSession",
    };
  }
  return { deadline: new Date(input.sessionEnd.getTime() + HOMEWORK_FALLBACK_DAYS * DAY_MS), basis: "fallback" };
}

// ── A draft and its validation (saved on every "Save draft") ───────────────

export type DraftOption = { text: string; isCorrect: boolean };
export type DraftQuestion = { text: string; points: number; options: DraftOption[] };

export type AssessmentDraft = AssessmentSettings & {
  title: string;
  instructions: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  questions: DraftQuestion[];
};

export function newDraftQuestion(): DraftQuestion {
  return {
    text: "",
    points: ASSESSMENT_LIMITS.defaultPoints,
    options: Array.from({ length: ASSESSMENT_LIMITS.defaultOptions }, () => ({ text: "", isCorrect: false })),
  };
}

export type DraftErrorCode =
  | "titleRequired"
  | "titleTooLong"
  | "instructionsTooLong"
  | "tooManyQuestions"
  | "questionTooLong"
  | "pointsRange"
  | "optionCount"
  | "optionTooLong"
  | "multipleCorrect"
  | "durationRange"
  | "windowOrder"
  | "durationLongerThanWindow"
  | "deadlineRequired"
  | "fieldsForType";

/** `path` is "title", "durationMinutes", "questions.3", "questions.3.options.1" … */
export type DraftError = { path: string; code: DraftErrorCode };

/**
 * Every limit a draft must meet to be saved at all. Publishing has its own,
 * stricter list (`readiness`, enforced in W3). An empty array = savable.
 */
export function draftErrors(type: AssessmentType, draft: AssessmentDraft): DraftError[] {
  const errors: DraftError[] = [];
  const L = ASSESSMENT_LIMITS;

  if (draft.title.trim() === "") errors.push({ path: "title", code: "titleRequired" });
  else if (draft.title.length > L.title) errors.push({ path: "title", code: "titleTooLong" });
  if ((draft.instructions ?? "").length > L.instructions) errors.push({ path: "instructions", code: "instructionsTooLong" });

  if (draft.durationMinutes !== null) {
    const d = draft.durationMinutes;
    if (!Number.isInteger(d) || d < L.minDuration || d > L.maxDuration) {
      errors.push({ path: "durationMinutes", code: "durationRange" });
    }
  }

  if (type === "EXAM") {
    if (draft.deadline !== null) errors.push({ path: "deadline", code: "fieldsForType" });
    const { windowStart, windowEnd } = draft;
    if (windowStart && windowEnd) {
      if (windowEnd.getTime() <= windowStart.getTime()) {
        errors.push({ path: "windowEnd", code: "windowOrder" });
      } else if (
        draft.durationMinutes !== null &&
        draft.durationMinutes * MINUTE_MS > windowEnd.getTime() - windowStart.getTime()
      ) {
        errors.push({ path: "durationMinutes", code: "durationLongerThanWindow" });
      }
    }
  } else {
    if (draft.windowStart !== null || draft.windowEnd !== null || draft.oneSitting) {
      errors.push({ path: "windowStart", code: "fieldsForType" });
    }
    if (draft.deadline === null) errors.push({ path: "deadline", code: "deadlineRequired" });
  }

  if (draft.questions.length > L.maxQuestions) errors.push({ path: "questions", code: "tooManyQuestions" });
  draft.questions.forEach((question, q) => {
    const at = `questions.${q}`;
    if (question.text.length > L.questionText) errors.push({ path: at, code: "questionTooLong" });
    if (!Number.isInteger(question.points) || question.points < L.minPoints || question.points > L.maxPoints) {
      errors.push({ path: `${at}.points`, code: "pointsRange" });
    }
    if (question.options.length < L.minOptions || question.options.length > L.maxOptions) {
      errors.push({ path: `${at}.options`, code: "optionCount" });
    }
    if (question.options.filter((option) => option.isCorrect).length > 1) {
      errors.push({ path: `${at}.options`, code: "multipleCorrect" });
    }
    question.options.forEach((option, o) => {
      if (option.text.length > L.optionText) errors.push({ path: `${at}.options.${o}`, code: "optionTooLong" });
    });
  });
  return errors;
}

// ── "Ready to publish" (computed; enforced at publish in W3) ───────────────

export type ReadinessKey = "hasQuestions" | "allTextFilled" | "oneCorrectEach" | "windowSet" | "deadlineInFuture";
export type ReadinessItem = { key: ReadinessKey; ok: boolean };

export function readiness(
  type: AssessmentType,
  draft: Pick<AssessmentDraft, "windowStart" | "windowEnd" | "deadline" | "questions">,
  now: Date,
): ReadinessItem[] {
  const questions = draft.questions;
  const items: ReadinessItem[] = [
    { key: "hasQuestions", ok: questions.length > 0 },
    {
      key: "allTextFilled",
      ok: questions.length > 0 && questions.every((q) => q.text.trim() !== "" && q.options.every((o) => o.text.trim() !== "")),
    },
    {
      key: "oneCorrectEach",
      ok: questions.length > 0 && questions.every((q) => q.options.filter((o) => o.isCorrect).length === 1),
    },
  ];
  if (type === "EXAM") items.push({ key: "windowSet", ok: draft.windowStart !== null && draft.windowEnd !== null });
  else items.push({ key: "deadlineInFuture", ok: draft.deadline !== null && draft.deadline.getTime() > now.getTime() });
  return items;
}

export function isReady(items: readonly ReadinessItem[]): boolean {
  return items.every((item) => item.ok);
}

export function totalPoints(questions: readonly { points: number }[]): number {
  return questions.reduce((sum, question) => sum + question.points, 0);
}

// ── The student-facing shape (D-W09) ───────────────────────────────────────

/**
 * The only select a student-reachable read may use. It never names
 * `isCorrect` (`check:assessments` asserts it, and that the serializer below
 * strips it from a row that carries it anyway).
 */
export const STUDENT_ASSESSMENT_SELECT = {
  id: true,
  type: true,
  title: true,
  instructions: true,
  windowStart: true,
  windowEnd: true,
  deadline: true,
  durationMinutes: true,
  oneSitting: true,
  shuffle: true,
  questions: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      text: true,
      points: true,
      options: { orderBy: { position: "asc" }, select: { id: true, position: true, text: true } },
    },
  },
} as const;

export type StudentOption = { id: string; text: string };
export type StudentQuestion = { id: string; text: string; points: number; options: StudentOption[] };
export type StudentAssessment = {
  id: string;
  type: AssessmentType;
  title: string;
  instructions: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  durationMinutes: number | null;
  oneSitting: boolean;
  totalPoints: number;
  questions: StudentQuestion[];
};

/** Anything at least as wide as the student select — a teacher row included. */
export type StudentAssessmentSource = {
  id: string;
  type: AssessmentType;
  title: string;
  instructions: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  durationMinutes: number | null;
  oneSitting: boolean;
  questions: readonly {
    id: string;
    position: number;
    text: string;
    points: number;
    options: readonly { id: string; position: number; text: string }[];
  }[];
};

/**
 * Builds the student view field by field — never a spread — so a correctness
 * flag on the source row cannot ride along. `order` (W3: the order drawn at
 * the attempt's start, D-W05; the preview: a fresh draw) lists question ids
 * and, per question, option ids; omitted = stored order.
 */
export function toStudentAssessment(
  source: StudentAssessmentSource,
  order?: { questions: string[]; options: Record<string, string[]> },
): StudentAssessment {
  const byPosition = <T extends { position: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.position - b.position);
  const arrange = <T extends { id: string }>(rows: T[], ids: string[] | undefined): T[] => {
    if (!ids) return rows;
    const index = new Map(ids.map((id, i) => [id, i]));
    return [...rows].sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  };
  const questions = arrange(byPosition(source.questions), order?.questions).map((question) => ({
    id: question.id,
    text: question.text,
    points: question.points,
    options: arrange(byPosition(question.options), order?.options[question.id]).map((option) => ({
      id: option.id,
      text: option.text,
    })),
  }));
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    instructions: source.instructions,
    windowStart: source.windowStart,
    windowEnd: source.windowEnd,
    deadline: source.deadline,
    durationMinutes: source.durationMinutes,
    oneSitting: source.oneSitting,
    totalPoints: totalPoints(questions),
    questions,
  };
}

/**
 * A shuffled order of questions and of each question's options (D-W05) —
 * Fisher–Yates with an injected `random`, so a gate can pin it. W3 draws it
 * once per attempt and stores it; the preview draws a fresh one per view.
 */
export function drawOrder(
  source: Pick<StudentAssessmentSource, "questions">,
  random: () => number = Math.random,
): { questions: string[]; options: Record<string, string[]> } {
  const shuffled = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return {
    questions: shuffled(source.questions.map((question) => question.id)),
    options: Object.fromEntries(
      source.questions.map((question) => [question.id, shuffled(question.options.map((option) => option.id))]),
    ),
  };
}
