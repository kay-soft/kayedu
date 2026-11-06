/**
 * The teacher's results rules (W4, D-W11, D-W33): pure, no database, so
 * `check:assessments` runs them directly. Relative imports on purpose (the
 * lib/money.ts discipline). The reads are lib/db/assessment-results.ts.
 *
 * Nothing here is ever stored. Status, percentage, time taken and every summary
 * figure are derived from the frozen `score`, `maxScore`, `startedAt` and
 * `submittedAt` of the attempt, and never from the current questions (D-W09).
 * These shapes carry correctness, so they are never given to a student or parent.
 */
import type { AssessmentFinalisedBy } from "@prisma/client";

import { assessmentClosesAt, attemptEnd, hasClosed, joinedAfterClose, percentage, type AssessmentTiming } from "./assessments.ts";
import { todayInTimezone } from "./scheduling.ts";

// ── The history window (U6, D-W33) ─────────────────────────────────────────

/**
 * Whether the teacher's own history preference hides this row: a PUBLISHED
 * assessment whose closing day, in its own timezone, is before the floor. A draft
 * is never hidden (it has no results yet), and a null floor hides nothing.
 */
export function outsideTeacherHistory(
  row: { status: "DRAFT" | "PUBLISHED" } & Pick<AssessmentTiming, "type" | "windowEnd" | "deadline">,
  zone: string,
  floor: Date | null,
): boolean {
  if (!floor || row.status !== "PUBLISHED") return false;
  const closes = assessmentClosesAt(row);
  return closes !== null && todayInTimezone(zone, closes).getTime() < floor.getTime();
}

// ── One row per student ────────────────────────────────────────────────────

export type ResultStatus = "SUBMITTED" | "IN_PROGRESS" | "NOT_STARTED" | "MISSED";

export const RESULT_STATUSES: readonly ResultStatus[] = ["SUBMITTED", "IN_PROGRESS", "NOT_STARTED", "MISSED"];

/** Semantic colours (rule 8): submitted green, in progress amber, missed red. */
export const RESULT_STATUS_BADGE = {
  SUBMITTED: "success",
  IN_PROGRESS: "warning",
  NOT_STARTED: "neutral",
  MISSED: "danger",
} as const satisfies Record<ResultStatus, "success" | "warning" | "neutral" | "danger">;

/** An ACTIVE enrolment of an active student, now. */
export type RosterEnrolment = { studentProfileId: string; name: string; enrolledAt: Date };

export type RosterAttempt = {
  id: string;
  studentProfileId: string;
  name: string;
  startedAt: Date;
  submittedAt: Date | null;
  finalisedBy: AssessmentFinalisedBy | null;
  score: number | null;
  maxScore: number | null;
};

export type ResultRow = {
  studentProfileId: string;
  name: string;
  status: ResultStatus;
  /** Counts in "Eligible now": an ACTIVE enrolment that could have taken it. */
  eligible: boolean;
  /** Has an attempt but no ACTIVE enrolment now. */
  left: boolean;
  attemptId: string | null;
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
  timeTakenMs: number | null;
  finalisedBy: AssessmentFinalisedBy | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  /** Set only while in progress. */
  timeLeftMs: number | null;
};

/**
 * The roster: everyone with an attempt, whether or not they are still enrolled,
 * and everyone with an ACTIVE enrolment and no attempt. A student who joined after
 * it closed could never have taken it and is left out, the same rule as their own
 * list (D-W31, D-W33), so joining late never reads as missed.
 */
export function buildResultRows(
  assessment: AssessmentTiming,
  enrolments: readonly RosterEnrolment[],
  attempts: readonly RosterAttempt[],
  now: Date,
): ResultRow[] {
  const closes = assessmentClosesAt(assessment);
  const closed = hasClosed(assessment, now);
  const enrolled = new Set(enrolments.map((enrolment) => enrolment.studentProfileId));
  const attempted = new Set(attempts.map((attempt) => attempt.studentProfileId));

  const fromAttempts = attempts.map((attempt): ResultRow => {
    const final = attempt.submittedAt !== null;
    const scored = final && attempt.score !== null && attempt.maxScore !== null;
    return {
      studentProfileId: attempt.studentProfileId,
      name: attempt.name,
      status: final ? "SUBMITTED" : "IN_PROGRESS",
      eligible: enrolled.has(attempt.studentProfileId),
      left: !enrolled.has(attempt.studentProfileId),
      attemptId: attempt.id,
      score: scored ? attempt.score : null,
      maxScore: scored ? attempt.maxScore : null,
      percentage: scored ? percentage(attempt.score!, attempt.maxScore!) : null,
      timeTakenMs: attempt.submittedAt ? Math.max(0, attempt.submittedAt.getTime() - attempt.startedAt.getTime()) : null,
      finalisedBy: final ? attempt.finalisedBy : null,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      timeLeftMs: final ? null : Math.max(0, attemptEnd(assessment, attempt.startedAt).getTime() - now.getTime()),
    };
  });

  const noAttempt = enrolments
    .filter((enrolment) => !attempted.has(enrolment.studentProfileId) && !joinedAfterClose(enrolment.enrolledAt, closes))
    .map((enrolment): ResultRow => ({
      studentProfileId: enrolment.studentProfileId,
      name: enrolment.name,
      status: closed ? "MISSED" : "NOT_STARTED",
      eligible: true,
      left: false,
      attemptId: null,
      score: null,
      maxScore: null,
      percentage: null,
      timeTakenMs: null,
      finalisedBy: null,
      startedAt: null,
      submittedAt: null,
      timeLeftMs: null,
    }));

  return [...fromAttempts, ...noAttempt];
}

// ── The summary ────────────────────────────────────────────────────────────

export type ResultSummary = {
  eligible: number;
  started: number;
  submitted: number;
  inProgress: number;
  notStarted: number;
  missed: number;
  /** Over submitted attempts only; null with none ("No submissions yet"). */
  averagePercentage: number | null;
  highestPercentage: number | null;
  lowestPercentage: number | null;
};

export function summariseResults(rows: readonly ResultRow[]): ResultSummary {
  const count = (status: ResultStatus) => rows.filter((row) => row.status === status).length;
  const scored = rows.filter((row) => row.status === "SUBMITTED" && row.score !== null && row.maxScore !== null);
  const exact = scored.map((row) => (row.maxScore! > 0 ? (row.score! * 100) / row.maxScore! : 0));
  const percentages = scored.map((row) => row.percentage!);
  return {
    eligible: rows.filter((row) => row.eligible).length,
    started: rows.filter((row) => row.attemptId !== null).length,
    submitted: count("SUBMITTED"),
    inProgress: count("IN_PROGRESS"),
    notStarted: count("NOT_STARTED"),
    missed: count("MISSED"),
    averagePercentage: exact.length > 0 ? Math.round(exact.reduce((sum, value) => sum + value, 0) / exact.length) : null,
    highestPercentage: percentages.length > 0 ? Math.max(...percentages) : null,
    lowestPercentage: percentages.length > 0 ? Math.min(...percentages) : null,
  };
}

// ── Search, filter and sort (the URL's state, in memory) ───────────────────

export const RESULT_SORTS = ["name", "scoreDesc", "scoreAsc", "timeAsc", "timeDesc"] as const;
export type ResultSort = (typeof RESULT_SORTS)[number];

/** Null sorts last in either direction: nobody with no score ranks above a score. */
function byNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * direction;
}

export function filterAndSortResults(
  rows: readonly ResultRow[],
  input: { query: string; status: ResultStatus | null; sort: ResultSort },
  locale: string,
): ResultRow[] {
  const query = input.query.trim().toLocaleLowerCase(locale);
  const collator = new Intl.Collator(locale);
  const byName = (a: ResultRow, b: ResultRow) => collator.compare(a.name, b.name) || a.studentProfileId.localeCompare(b.studentProfileId);
  const compare: Record<ResultSort, (a: ResultRow, b: ResultRow) => number> = {
    name: byName,
    scoreDesc: (a, b) => byNullable(a.score, b.score, -1) || byName(a, b),
    scoreAsc: (a, b) => byNullable(a.score, b.score, 1) || byName(a, b),
    timeAsc: (a, b) => byNullable(a.timeTakenMs, b.timeTakenMs, 1) || byName(a, b),
    timeDesc: (a, b) => byNullable(a.timeTakenMs, b.timeTakenMs, -1) || byName(a, b),
  };
  return rows
    .filter((row) => !input.status || row.status === input.status)
    .filter((row) => !query || row.name.toLocaleLowerCase(locale).includes(query))
    .sort(compare[input.sort]);
}

// ── One student's answers ──────────────────────────────────────────────────

export type AnswerOutcome = "CORRECT" | "INCORRECT" | "UNANSWERED";

/** The frozen outcome of one final answer. A cleared or missing answer is Unanswered. */
export function answerOutcome(answer: { optionId: string | null; isCorrect: boolean | null } | null | undefined): AnswerOutcome {
  if (!answer || answer.optionId === null) return "UNANSWERED";
  return answer.isCorrect ? "CORRECT" : "INCORRECT";
}

/** Semantic colours (rule 8), always beside a text label, never colour alone. */
export const ANSWER_OUTCOME_BADGE = {
  CORRECT: "success",
  INCORRECT: "danger",
  UNANSWERED: "neutral",
} as const satisfies Record<AnswerOutcome, "success" | "danger" | "neutral">;

// ── Per-question analysis, over submitted attempts only ────────────────────

export type AnswerGroup = { questionId: string; optionId: string | null; isCorrect: boolean | null; count: number };

export type AnalysisQuestion = {
  id: string;
  text: string;
  points: number;
  correctCount: number;
  /** Null with no submissions. */
  correctPercentage: number | null;
  unanswered: number;
  options: { id: string; text: string; isCorrect: boolean; count: number }[];
};

export function analyseQuestions(
  questions: readonly {
    id: string;
    text: string;
    points: number;
    options: readonly { id: string; text: string; isCorrect: boolean }[];
  }[],
  groups: readonly AnswerGroup[],
  submitted: number,
): AnalysisQuestion[] {
  return questions.map((question) => {
    const own = groups.filter((group) => group.questionId === question.id);
    const correctCount = own.filter((group) => group.optionId !== null && group.isCorrect).reduce((sum, group) => sum + group.count, 0);
    return {
      id: question.id,
      text: question.text,
      points: question.points,
      correctCount,
      correctPercentage: submitted > 0 ? percentage(correctCount, submitted) : null,
      unanswered: own.filter((group) => group.optionId === null).reduce((sum, group) => sum + group.count, 0),
      options: question.options.map((option) => ({
        id: option.id,
        text: option.text,
        isCorrect: option.isCorrect,
        count: own.filter((group) => group.optionId === option.id).reduce((sum, group) => sum + group.count, 0),
      })),
    };
  });
}
