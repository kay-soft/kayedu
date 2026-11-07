import { cache } from "react";
import { getLocale } from "next-intl/server";
import type { User } from "@prisma/client";

import { getCurrentUser } from "@/lib/auth/session";
import { findEffectiveAssistantLink, type EffectiveAssistantLink } from "@/lib/db/assistants";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

export type AssistantSession = { user: User; link: EffectiveAssistantLink };

/**
 * The assistant experience's gate (W7a, D-W36). The link is resolved **on the
 * server from the session's user and the route's teacherId** — never from a
 * posted id — and only an effective one counts: live, and the teacher premium
 * on this request (`findEffectiveAssistantLink`, D-W15). `null` means "not
 * yours": no link, a removed or left one, a lapsed teacher, or someone else's
 * teacher id; the route answers not-found for all of them alike.
 *
 * It resolves **no tenant context**: an assistant is no member of any branch
 * and holds no centre permission in W7a (decision 9).
 */
export const getAssistantSession = cache(async (teacherUserId: string): Promise<AssistantSession | null> => {
  const user = await getCurrentUser();
  if (!user) {
    redirect({ href: ROUTES.login, locale: await getLocale() });
    throw new Error("redirect failed");
  }
  const link = await findEffectiveAssistantLink(prisma, { assistantUserId: user.id, teacherUserId });
  return link ? { user, link } : null;
});
