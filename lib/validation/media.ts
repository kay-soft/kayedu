import { z } from "zod";

import { localeSchema } from "./auth.ts";

/**
 * Teacher photo and class cover inputs (U9). A record id from a form is opaque
 * to the UI; the action re-resolves it through the actor's own context and the
 * scoped lookup decides. The image itself is read from the `File` and typed by
 * its bytes (`readRasterImage`), never validated here.
 */
const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const base = { locale: localeSchema };

/** Branch side: one teacher membership of the active branch. */
export const teacherPhotoSchema = z.object({
  ...base,
  membershipId: recordId,
});

/** Branch side: one class of the active branch. */
export const classCoverSchema = z.object({
  ...base,
  classGroupId: recordId,
});

/** Teacher side: the branch is named by the form and re-resolved (never trusted). */
export const ownTeacherPhotoSchema = z.object({
  ...base,
  centerId: recordId,
  /** "Use this photo at all my branches" — a checkbox. */
  allBranches: z
    .string()
    .optional()
    .transform((value) => value === "on" || value === "true"),
});

export const ownClassCoverSchema = z.object({
  ...base,
  centerId: recordId,
  classGroupId: recordId,
});
