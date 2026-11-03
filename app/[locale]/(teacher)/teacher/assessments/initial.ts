import type { AssessmentType } from "@prisma/client";

import { assessmentDefaults } from "@/lib/assessments";
import type { TeacherAssessment } from "@/lib/db/assessments";
import { fieldsFromInstant, type AssessmentPayload } from "@/lib/validation/assessments";

/** The builder's starting point for a new draft: the per-type defaults (D-W02–D-W06). */
export function newPayload(type: AssessmentType, deadline: Date | null, zone: string): AssessmentPayload {
  const defaults = assessmentDefaults(type);
  return {
    title: "",
    instructions: "",
    windowStart: { date: "", time: "" },
    windowEnd: { date: "", time: "" },
    deadline: fieldsFromInstant(deadline, zone),
    durationMinutes: defaults.durationMinutes === null ? "" : String(defaults.durationMinutes),
    oneSitting: defaults.oneSitting,
    shuffle: defaults.shuffle,
    showScore: defaults.showScore,
    showCorrectAnswers: defaults.showCorrectAnswers,
    questions: [],
  };
}

/** A saved draft as the builder edits it, its times shown in `zone`. */
export function payloadFromRow(row: TeacherAssessment, zone: string): AssessmentPayload {
  return {
    title: row.title,
    instructions: row.instructions ?? "",
    windowStart: fieldsFromInstant(row.windowStart, zone),
    windowEnd: fieldsFromInstant(row.windowEnd, zone),
    deadline: fieldsFromInstant(row.deadline, zone),
    durationMinutes: row.durationMinutes === null ? "" : String(row.durationMinutes),
    oneSitting: row.oneSitting,
    shuffle: row.shuffle,
    showScore: row.showScore,
    showCorrectAnswers: row.showCorrectAnswers,
    questions: row.questions.map((question) => ({
      text: question.text,
      points: question.points,
      options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect })),
    })),
  };
}
