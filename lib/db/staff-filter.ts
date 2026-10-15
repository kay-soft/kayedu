/**
 * What "centre staff" means to a query (R9).
 *
 * Users & Roles lists and invites OWNER / MANAGER / RECEPTIONIST / ACCOUNTANT
 * only. Teachers are `Membership` rows too (CLAUDE.md rule 4), but they are
 * managed on the Teachers page — so the staff screen's reads pin the role set
 * here, in the data layer, rather than hiding teachers in the UI. Pure (type
 * imports only) so `npm run check:card-layout` runs the *exact* filters the
 * screen runs.
 */
import type { Prisma } from "@prisma/client";

import { CENTER_STAFF_ROLES } from "../auth/permissions.ts";

/** Memberships the staff screen may list. */
export function staffMembershipFilter(
  where?: Prisma.MembershipWhereInput,
): Prisma.MembershipWhereInput {
  return { ...where, role: { in: [...CENTER_STAFF_ROLES] } };
}

/** Invitations the staff screen may list. A pending TEACHER invitation is not staff. */
export function staffInvitationFilter(
  where?: Prisma.InvitationWhereInput,
): Prisma.InvitationWhereInput {
  return { ...where, role: { in: [...CENTER_STAFF_ROLES] } };
}
