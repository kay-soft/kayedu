import { cache } from "react";

import type { TenantContext } from "@/lib/auth/tenant";
import {
  pendingApprovalCounts,
  pendingTeacherApprovalCounts,
} from "@/lib/db/approval-counts";

/**
 * The request-scoped reads of the pending counts (F7). The shell (sidebar
 * badge) and the Approvals page (tab counts) both ask in the same render;
 * `cache()` — keyed on the request's one `TenantContext`, itself `cache()`d —
 * makes that one set of queries, never two, and never shared across requests
 * (`center_id` is the sole isolation key).
 */
export const getPendingApprovalCounts = cache((ctx: TenantContext) => pendingApprovalCounts(ctx));

export const getPendingTeacherApprovalCounts = cache((ctx: TenantContext) =>
  pendingTeacherApprovalCounts(ctx, ctx.user.id),
);
