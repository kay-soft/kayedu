import type { CenterLifecycleState } from "@prisma/client";
import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "@/components/ui/badge";

/**
 * Semantic-color mapping for the five lifecycle states (M19, docs/04
 * §5 "Semantic colors are fixed"): ONBOARDING reads as "not live yet" (info,
 * the same family as "upcoming"), ACTIVE is success, GRACE is a warning (a
 * lapse under notice, not yet a hard stop), SUSPENDED/ARCHIVED are both
 * danger/neutral — refused access, just at different severities.
 *
 * A plain lookup, not a component: the pages that render it are Server
 * Components resolving their own `t()` for the label (the pattern every
 * other Badge in this admin surface already uses), so this only owns the
 * color decision.
 */
export const LIFECYCLE_BADGE_VARIANT: Record<
  CenterLifecycleState,
  VariantProps<typeof badgeVariants>["variant"]
> = {
  ONBOARDING: "info",
  ACTIVE: "success",
  GRACE: "warning",
  SUSPENDED: "danger",
  ARCHIVED: "neutral",
};
