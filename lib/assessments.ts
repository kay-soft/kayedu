/**
 * The assessment rules (W2, D-W01–D-W06, D-W30) — pure, no database, so
 * `check:assessments` runs them directly. Relative imports on purpose (the
 * lib/money.ts discipline). Data access lives in lib/db/assessments.ts.
 *
 * Also the ONE student-facing shape of an assessment (`toStudentAssessment`,
 * D-W09): it never carries `isCorrect` or any per-option correctness. The
 * student reads in lib/db/assessment-attempts.ts all go through it.
 *
 * W3a adds what an attempt derives and never stores (D-W31): its end, when it
 * is due, the student-facing state, the reveal moment, grading and the seeded
 * shuffle.
 */
import type { AssessmentFinalisedBy, AssessmentType } from "@prisma/client";

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

// ── "Ready to publish" (computed; enforced at publish, W3a) ────────────────

export type ReadinessKey = "hasQuestions" | "allTextFilled" | "oneCorrectEach" | "windowSet" | "windowEndInFuture" | "deadlineInFuture";
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
  if (type === "EXAM") {
    items.push({ key: "windowSet", ok: draft.windowStart !== null && draft.windowEnd !== null });
    // An exam may be published while its window is already open, never after it closed.
    items.push({ key: "windowEndInFuture", ok: draft.windowEnd !== null && draft.windowEnd.getTime() > now.getTime() });
  } else items.push({ key: "deadlineInFuture", ok: draft.deadline !== null && draft.deadline.getTime() > now.getTime() });
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
 * flag on the source row cannot ride along. `order` (an attempt's seeded
 * order, D-W05; the preview: a fresh draw) lists question ids and, per
 * question, option ids; omitted = stored order.
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
 * Fisher–Yates with an injected `random`, so a gate can pin it. An attempt
 * derives its order from its own id (`attemptOrder`); the preview draws a
 * fresh one per view.
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

// ── An attempt's time (D-W02, D-W03, D-W09, D-W10, D-W31) ──────────────────

/** One constant: a one-sitting attempt silent for longer than this was left (D-W31). */
export const ONE_SITTING_GRACE_SECONDS = 120;
/** How often an open one-sitting exam tells the server it is still there. */
export const ONE_SITTING_HEARTBEAT_SECONDS = 15;

/** The fields every time rule reads — never a question, never a correct mark. */
export type AssessmentTiming = {
  type: AssessmentType;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  durationMinutes: number | null;
  oneSitting: boolean;
};

/** When the assessment itself closes: an exam's window end, a homework's deadline. */
export function assessmentClosesAt(assessment: Pick<AssessmentTiming, "type" | "windowEnd" | "deadline">): Date | null {
  return assessment.type === "EXAM" ? assessment.windowEnd : assessment.deadline;
}

export function hasClosed(assessment: Pick<AssessmentTiming, "type" | "windowEnd" | "deadline">, now: Date): boolean {
  const closes = assessmentClosesAt(assessment);
  return closes !== null && now.getTime() >= closes.getTime();
}

/**
 * Joined the class after it closed: they could never have taken it, so it is not
 * shown to them and not counted against them (D-W31, D-W33).
 */
export function joinedAfterClose(enrolledAt: Date, closes: Date | null): boolean {
  return closes !== null && enrolledAt.getTime() > closes.getTime();
}

/**
 * The attempt's end — derived, never stored. EXAM: min(startedAt + duration,
 * windowEnd). HOMEWORK: the deadline when untimed, else min(startedAt +
 * duration, deadline). A published row always has its window or deadline
 * (`readiness`); were one missing, the attempt ends at once rather than never.
 */
export function attemptEnd(assessment: AssessmentTiming, startedAt: Date): Date {
  const closes = assessmentClosesAt(assessment) ?? startedAt;
  if (assessment.durationMinutes === null) return closes;
  const timed = startedAt.getTime() + assessment.durationMinutes * MINUTE_MS;
  return new Date(Math.min(timed, closes.getTime()));
}

export type DueDecision = { finalisedBy: Extract<AssessmentFinalisedBy, "DEADLINE" | "ONE_SITTING_GAP">; submittedAt: Date };

/**
 * Is this open attempt already over, and how? A one-sitting attempt silent for
 * longer than the grace ended when it was last seen — unless the student was
 * still there within the grace of its end, which is an ordinary deadline. Any
 * other attempt past its end stops at its end, not at this read, so the time
 * taken is capped (D-W10).
 */
export function finalisationDue(
  assessment: AssessmentTiming,
  attempt: { startedAt: Date; lastSeenAt: Date },
  now: Date,
): DueDecision | null {
  const end = attemptEnd(assessment, attempt.startedAt);
  if (assessment.oneSitting) {
    const silentUntil = attempt.lastSeenAt.getTime() + ONE_SITTING_GRACE_SECONDS * 1_000;
    if (silentUntil < Math.min(now.getTime(), end.getTime())) {
      return { finalisedBy: "ONE_SITTING_GAP", submittedAt: attempt.lastSeenAt };
    }
  }
  if (now.getTime() >= end.getTime()) return { finalisedBy: "DEADLINE", submittedAt: end };
  return null;
}

export type StartRefusal = "notOpenYet" | "closed";

/** Start is refused before an exam's window, and after the window or deadline. */
export function startRefusal(assessment: AssessmentTiming, now: Date): StartRefusal | null {
  if (hasClosed(assessment, now)) return "closed";
  if (assessment.type === "EXAM" && assessment.windowStart && now.getTime() < assessment.windowStart.getTime()) {
    return "notOpenYet";
  }
  return null;
}

/**
 * Upcoming: an exam before its window. Open: startable. In progress: an attempt
 * not yet final. Submitted: final while the assessment is still open. Closed:
 * final and the assessment has closed, which is when a reveal can follow.
 * Missed: closed with no attempt.
 */
export type StudentAssessmentState = "UPCOMING" | "OPEN" | "IN_PROGRESS" | "SUBMITTED" | "MISSED" | "CLOSED";

export function studentAssessmentState(
  assessment: AssessmentTiming,
  attempt: { submittedAt: Date | null } | null,
  now: Date,
): StudentAssessmentState {
  if (attempt) {
    if (attempt.submittedAt === null) return "IN_PROGRESS";
    return hasClosed(assessment, now) ? "CLOSED" : "SUBMITTED";
  }
  const refusal = startRefusal(assessment, now);
  if (refusal === "closed") return "MISSED";
  return refusal === "notOpenYet" ? "UPCOMING" : "OPEN";
}

// ── The reveal moment (D-W06, CLAUDE.md rule 11) ───────────────────────────

/**
 * Correctness may leave the server only when ALL hold: the attempt is final,
 * the assessment has closed, and the teacher left showCorrectAnswers on. An
 * extension moves the close, so it moves this too.
 */
export function revealAllowed(
  assessment: Pick<AssessmentTiming, "type" | "windowEnd" | "deadline"> & { showCorrectAnswers: boolean },
  attempt: { submittedAt: Date | null },
  now: Date,
): boolean {
  return attempt.submittedAt !== null && hasClosed(assessment, now) && assessment.showCorrectAnswers;
}

/** The percentage is always derived from the frozen points, never stored (D-W04). */
export function percentage(score: number, maxScore: number): number {
  return maxScore > 0 ? Math.round((score * 100) / maxScore) : 0;
}

// ── Grading (D-W09) ────────────────────────────────────────────────────────

export type GradableQuestion = { id: string; points: number; options: readonly { id: string; isCorrect: boolean }[] };
export type GradedAnswer = { questionId: string; optionId: string | null; isCorrect: boolean; pointsAwarded: number };

/** Grades the saved answers. A question with no saved option scores 0. */
export function gradeAnswers(
  questions: readonly GradableQuestion[],
  saved: readonly { questionId: string; optionId: string | null }[],
): { score: number; maxScore: number; answers: GradedAnswer[] } {
  const chosen = new Map(saved.map((answer) => [answer.questionId, answer.optionId]));
  const answers = questions.map((question): GradedAnswer => {
    const optionId = chosen.get(question.id) ?? null;
    const isCorrect = optionId !== null && question.options.some((option) => option.id === optionId && option.isCorrect);
    return { questionId: question.id, optionId, isCorrect, pointsAwarded: isCorrect ? question.points : 0 };
  });
  return {
    score: answers.reduce((sum, answer) => sum + answer.pointsAwarded, 0),
    maxScore: totalPoints(questions),
    answers,
  };
}

// ── The shuffled order of one attempt (D-W05) ──────────────────────────────

/** A small seeded generator (FNV-1a into mulberry32): the same seed, the same sequence. */
function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * An attempt's order, computed on the server from its own id and stored
 * nowhere: stable on refresh, because the questions are locked from the first
 * attempt (D-W08), and different from another attempt's.
 */
export function attemptOrder(
  attemptId: string,
  source: Pick<StudentAssessmentSource, "questions">,
): { questions: string[]; options: Record<string, string[]> } {
  const byPosition = <T extends { position: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.position - b.position);
  return drawOrder(
    { questions: byPosition(source.questions).map((question) => ({ ...question, options: byPosition(question.options) })) },
    seededRandom(attemptId),
  );
}
