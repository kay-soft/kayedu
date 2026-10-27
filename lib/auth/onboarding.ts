import type { SignupIntent } from "@prisma/client";

// Relative import: the routing rule is pure and loadable outside Next, so a
// gate can run the REAL function (same reasoning as lib/auth/relations.ts).
import { ROUTES } from "../routes.ts";

/**
 * Where a person who declared a sign-up intent (F4) is sent when they belong
 * to no branch yet — and only then. It is **routing and nothing else**: the
 * intent is not a role, grants nothing, and no permission check reads it
 * (`check:people` asserts the intent changes no `can()` answer). Null intent
 * → null here → today's behaviour (the branch hub).
 *
 * - STUDENT  → "Your studies" until an account grade is set; afterwards the
 *   hub's own Discover link serves them.
 * - PARENT   → the parent portal, whose empty state is "Link your child".
 * - TEACHER  → the centre directory.
 */
export function onboardingPath(user: {
  signupIntent: SignupIntent | null;
  gradeId: string | null;
}): string | null {
  switch (user.signupIntent) {
    case "STUDENT":
      return user.gradeId ? null : ROUTES.studentOnboarding;
    case "PARENT":
      return ROUTES.parentHome;
    case "TEACHER":
      return ROUTES.teacherCenters;
    default:
      return null;
  }
}
