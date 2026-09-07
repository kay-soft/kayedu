import { z } from "zod";

import { localeSchema } from "./auth";

/**
 * The OD-6 placeholder seam's own input (M16, `verifyParentLinkAction`,
 * `app/[locale]/(center)/students/actions.ts`) — just which link, resolved
 * server-side against `ctx.center.id`/`ctx.user.id`, never a client-sent
 * center or actor.
 */
export const verifyParentLinkSchema = z.object({
  locale: localeSchema,
  parentLinkId: z.string().trim().min(1).max(64),
});
