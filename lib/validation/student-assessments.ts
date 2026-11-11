import { z } from "zod";

// Relative import on purpose: stays resolvable outside the Next.js runtime.
import { localeSchema } from "./auth.ts";

/**
 * A student's assessment actions (W3a). A Server Action is a public endpoint
 * (SEC-52): the ones called with plain arguments parse them here first. No
 * `centerId`, profile or time is ever taken from the client — the branch comes
 * from the person's own profiles, and time from the server (D-W09).
 */

const recordId = z.string().trim().min(1).max(64);

export const startAttemptSchema = z.object({ locale: localeSchema, assessmentId: recordId });

/** `(attemptId, questionId, optionId | null)` */
export const saveAnswerArgs = z.tuple([recordId, recordId, recordId.nullable()]);
/** `(attemptId)` */
export const heartbeatArgs = z.tuple([recordId]);
/** `(locale, attemptId)` */
export const submitAttemptArgs = z.tuple([localeSchema, recordId]);
/** The close route's path segment. */
export const attemptIdSchema = recordId;

export type StartAttemptState = { error?: string; status?: "started" };
export const IDLE_START_STATE: StartAttemptState = {};
