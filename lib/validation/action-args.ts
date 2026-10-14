import { z } from "zod";

/**
 * Raw-argument Server Actions (SEC-2c, SEC-52) — the type-aheads and lookups a
 * client component calls with plain arguments instead of a FormData. A Server
 * Action is a public endpoint: whatever its TypeScript signature says, each
 * argument arrives as whatever the caller posted (an object, a number, a
 * 10,000-character string). Each such action parses its arguments here first
 * and answers "nothing" (an empty list, "not found") to anything else — so a
 * crafted value never reaches a Prisma `where`, and an over-long search never
 * fans out into the database.
 */

/** The longest search a type-ahead accepts; longer is refused, not truncated. */
export const SEARCH_QUERY_MAX = 80;

const recordId = z.string().trim().min(1).max(64);
const searchQuery = z.string().trim().max(SEARCH_QUERY_MAX);
const locale = z.enum(["ar", "en"]).catch("en");

/** `(query)` */
export const searchArgs = z.tuple([searchQuery]);
/** `(recordId, query)` — a search bound to one class, session or teacher. */
export const boundSearchArgs = z.tuple([recordId, searchQuery]);
/** `(currentParams, query)` — the teacher session list keeps its own query string. */
export const paramsSearchArgs = z.tuple([z.string().max(500), searchQuery]);
/** `(phone)` — normalized afterwards by `lib/phone.ts`, the one normalizer. */
export const phoneLookupArgs = z.tuple([z.string().max(40)]);
/** `(sessionId, typedOrScanned, locale)` — reception session mode. */
export const receptionInputArgs = z.tuple([recordId, z.string().max(200), locale]);
/** `(sessionId, studentProfileId, locale)` — reception session mode. */
export const receptionStudentArgs = z.tuple([recordId, recordId, locale]);

/** The parsed arguments, or null when they are not what the action takes. */
export function parseActionArgs<S extends z.ZodType>(schema: S, args: unknown[]): z.output<S> | null {
  const parsed = schema.safeParse(args);
  return parsed.success ? parsed.data : null;
}
