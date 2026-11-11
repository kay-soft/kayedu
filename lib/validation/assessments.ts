import { z } from "zod";

// Relative imports on purpose, matching lib/validation/teacher.ts: this module
// stays resolvable outside the Next.js runtime (`check:assessments`).
import { localeSchema } from "./auth.ts";
import type { AssessmentDraft, DraftError } from "../assessments.ts";
import { toAsciiDigits } from "../digits.ts";
import { isValidTime, parseTimeToMinutes, zonedClock, zonedDateTimeToUtc } from "../scheduling.ts";

/**
 * The builder's Server Action input (W2). The form posts its identity fields
 * plus one `payload` field — the whole draft as JSON (a question set does not
 * fit flat form fields). This schema is **structural only** (types and a
 * generous size cap against an oversized post); the real limits are
 * lib/assessments.ts's `draftErrors`, which name the question and option they
 * concern. No `teacherId` is ever read from the form (lib/validation/teacher.ts).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");
const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

export const assessmentFormSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  assessmentId: optionalRef,
  type: z.enum(["EXAM", "HOMEWORK"]),
  classGroupId: optionalRef,
  sessionId: optionalRef,
  payload: z.string().max(2_000_000, "invalid"),
});

export const assessmentDeleteSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  assessmentId: recordId,
});

/** Publish and unpublish carry the same identity as a delete. */
export const assessmentPublishSchema = assessmentDeleteSchema;

/** An extension: the new end, typed as a date and a time in the row's timezone. */
export const assessmentExtendSchema = assessmentDeleteSchema.extend({
  date: z.string().max(10),
  time: z.string().max(5),
});

const text = (max: number) => z.string().max(max);

/** A date + time pair as the builder holds it: "YYYY-MM-DD" and "HH:mm", either may be "". */
const dateTimeFields = z.object({ date: text(10), time: text(5) });

export const assessmentPayloadSchema = z.object({
  title: text(1_000),
  instructions: text(10_000),
  windowStart: dateTimeFields,
  windowEnd: dateTimeFields,
  deadline: dateTimeFields,
  durationMinutes: text(6),
  oneSitting: z.boolean(),
  shuffle: z.boolean(),
  showScore: z.boolean(),
  showCorrectAnswers: z.boolean(),
  questions: z
    .array(
      z.object({
        text: text(10_000),
        points: z.number(),
        options: z.array(z.object({ text: text(5_000), isCorrect: z.boolean() })).max(20),
      }),
    )
    .max(500),
});

export type AssessmentPayload = z.infer<typeof assessmentPayloadSchema>;
export type DateTimeFields = z.infer<typeof dateTimeFields>;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A typed date + time in `timeZone` → its UTC instant. Both empty = not set
 * (null); one without the other, or a malformed one, is `"invalid"`.
 */
export function instantFromFields(fields: DateTimeFields, timeZone: string): Date | null | "invalid" {
  const date = toAsciiDigits(fields.date.trim());
  const time = toAsciiDigits(fields.time.trim());
  if (date === "" && time === "") return null;
  if (!DAY_KEY.test(date) || !isValidTime(time)) return "invalid";
  return zonedDateTimeToUtc(date, parseTimeToMinutes(time), timeZone);
}

/** A stored instant → the date + time fields the builder shows, in `timeZone`. */
export function fieldsFromInstant(instant: Date | null, timeZone: string): DateTimeFields {
  if (!instant) return { date: "", time: "" };
  const clock = zonedClock(instant, timeZone);
  const hours = String(Math.floor(clock.minutes / 60)).padStart(2, "0");
  const minutes = String(clock.minutes % 60).padStart(2, "0");
  return { date: clock.dayKey, time: `${hours}:${minutes}` };
}

/**
 * The payload → a draft for `draftErrors` and the writers, with every time
 * read in `timeZone` (the session's frozen zone, else the branch's). A field
 * that is not a valid date-time comes back in `badFields`.
 */
export function draftFromPayload(
  payload: AssessmentPayload,
  timeZone: string,
): { draft: AssessmentDraft; badFields: string[] } {
  const badFields: string[] = [];
  const instant = (name: "windowStart" | "windowEnd" | "deadline") => {
    const value = instantFromFields(payload[name], timeZone);
    if (value === "invalid") {
      badFields.push(name);
      return null;
    }
    return value;
  };
  const durationText = toAsciiDigits(payload.durationMinutes.trim());
  let durationMinutes: number | null = null;
  if (durationText !== "") {
    durationMinutes = /^\d+$/.test(durationText) ? Number(durationText) : Number.NaN;
  }
  return {
    draft: {
      title: payload.title,
      instructions: payload.instructions,
      windowStart: instant("windowStart"),
      windowEnd: instant("windowEnd"),
      deadline: instant("deadline"),
      durationMinutes,
      oneSitting: payload.oneSitting,
      shuffle: payload.shuffle,
      showScore: payload.showScore,
      showCorrectAnswers: payload.showCorrectAnswers,
      questions: payload.questions.map((question) => ({
        text: question.text,
        points: question.points,
        options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect })),
      })),
    },
    badFields,
  };
}

/** One result shape (docs/02 §7), plus the draft errors keyed by their path. */
export type AssessmentActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  draftErrors?: DraftError[];
  status?: "saved" | "deleted" | "published" | "unpublished" | "extended";
  /** Bumped on every successful save, so the form can mark itself clean. */
  savedAt?: number;
};

export const IDLE_ASSESSMENT_STATE: AssessmentActionState = {};
