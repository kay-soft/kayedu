import { z } from "zod";

/**
 * Teacher-ratings schemas (M17). Every Server Action under
 * `app/[locale]/(student)/actions.ts` parses its input through one of these
 * before touching the database (docs/02 §7). No `centerId` and no `locale`
 * here — a rating write is identity-scoped by the caller's own
 * `studentUserId`, re-derived server-side, never a client-sent one
 * (`lib/db/ratings.ts`'s `submitSessionRating` re-checks attendance itself),
 * and neither action redirects, so there is no locale-prefixed path to build.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

export const submitSessionRatingSchema = z.object({
  sessionId: recordId,
  score: z.coerce.number().int().min(1, "invalidScore").max(5, "invalidScore"),
});

export const skipSessionRatingSchema = z.object({
  sessionId: recordId,
});

export type RatingActionState = {
  error?: string;
  status?: "rated" | "skipped";
};

export const IDLE_RATING_STATE: RatingActionState = {};
