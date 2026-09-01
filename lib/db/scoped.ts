import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "@/lib/db/tenant-scope";

/**
 * Tenant-scoped data access (docs/02-architecture.md §5).
 *
 * Components and Server Actions never touch `prisma.*` for a tenant table
 * directly — they go through `scoped(ctx)`, which injects `ctx.center.id` into
 * every `where` and every `data`. A missing centerId filter is a bug.
 *
 * Only the models M1 needs are exposed. Later milestones add models here rather
 * than reaching around this module.
 */
export function scoped(ctx: TenantContext) {
  const centerId = ctx.center.id;

  return {
    centerId,

    memberships: {
      list: (args?: {
        where?: Prisma.MembershipWhereInput;
        orderBy?: Prisma.MembershipOrderByWithRelationInput;
        include?: Prisma.MembershipInclude;
      }) =>
        prisma.membership.findMany({
          where: scopedWhere(centerId, args?.where),
          orderBy: args?.orderBy,
          include: args?.include,
        }),

      listWithUser: (where?: Prisma.MembershipWhereInput) =>
        prisma.membership.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          include: { user: true },
        }),

      count: (where?: Prisma.MembershipWhereInput) =>
        prisma.membership.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.membership, centerId, id),

      requireById: (id: string) =>
        requireScopedById(prisma.membership, centerId, id, "Membership"),

      create: (data: Omit<Prisma.MembershipUncheckedCreateInput, "centerId">) =>
        prisma.membership.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Prisma.MembershipUpdateManyMutationInput) =>
        prisma.membership.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),
    },

    invitations: {
      list: (where?: Prisma.InvitationWhereInput) =>
        prisma.invitation.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
        }),

      findById: (id: string) => scopedFindById(prisma.invitation, centerId, id),

      requireById: (id: string) =>
        requireScopedById(prisma.invitation, centerId, id, "Invitation"),

      create: (data: Omit<Prisma.InvitationUncheckedCreateInput, "centerId">) =>
        prisma.invitation.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Prisma.InvitationUpdateManyMutationInput) =>
        prisma.invitation.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      updateMany: (
        where: Prisma.InvitationWhereInput,
        data: Prisma.InvitationUpdateManyMutationInput,
      ) =>
        prisma.invitation.updateMany({
          where: scopedWhere(centerId, where),
          data,
        }),
    },

    students: {
      count: (where?: Prisma.StudentProfileWhereInput) =>
        prisma.studentProfile.count({ where: scopedWhere(centerId, where) }),

      list: (where?: Prisma.StudentProfileWhereInput) =>
        prisma.studentProfile.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
          include: { user: true },
        }),

      findById: (id: string) =>
        scopedFindById(prisma.studentProfile, centerId, id),

      requireById: (id: string) =>
        requireScopedById(prisma.studentProfile, centerId, id, "StudentProfile"),
    },

    branches: {
      list: (where?: Prisma.BranchWhereInput) =>
        prisma.branch.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { name: "asc" },
        }),

      count: (where?: Prisma.BranchWhereInput) =>
        prisma.branch.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.branch, centerId, id),
    },

    settings: {
      get: () => prisma.centerSettings.findUnique({ where: { centerId } }),

      update: (data: Prisma.CenterSettingsUpdateInput) =>
        prisma.centerSettings.update({ where: { centerId }, data }),
    },

    auditLogs: {
      list: (take = 50) =>
        prisma.auditLog.findMany({
          where: { centerId },
          orderBy: { createdAt: "desc" },
          take,
          include: { actor: true },
        }),
    },
  };
}

export type ScopedDb = ReturnType<typeof scoped>;
