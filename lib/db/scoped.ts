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
 * Only the models the built milestones need are exposed. Later milestones add
 * models here rather than reaching around this module.
 *
 * Every helper below funnels through scopedWhere/scopedData, so a second (or
 * hundredth) center needs no code change — only its own rows.
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

    // ── Academic / config master data (docs/01-data-model.md §2) ───────────
    // Same shape for every entity: scoped list, scoped lookup, scoped write.
    // `update`/`remove` go through updateMany/deleteMany with a scoped where so
    // an id from another center matches zero rows instead of the wrong one.

    branches: {
      list: (where?: Prisma.BranchWhereInput) =>
        prisma.branch.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
        }),

      count: (where?: Prisma.BranchWhereInput) =>
        prisma.branch.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.branch, centerId, id),

      create: (data: Omit<Prisma.BranchUncheckedCreateInput, "centerId">) =>
        prisma.branch.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Omit<Prisma.BranchUncheckedUpdateManyInput, "centerId">) =>
        prisma.branch.updateMany({ where: scopedWhere(centerId, { id }), data }),

      remove: (id: string) =>
        prisma.branch.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    rooms: {
      list: (where?: Prisma.RoomWhereInput) =>
        prisma.room.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
          include: { branch: true },
        }),

      count: (where?: Prisma.RoomWhereInput) =>
        prisma.room.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.room, centerId, id),

      create: (data: Omit<Prisma.RoomUncheckedCreateInput, "centerId">) =>
        prisma.room.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Omit<Prisma.RoomUncheckedUpdateManyInput, "centerId">) =>
        prisma.room.updateMany({ where: scopedWhere(centerId, { id }), data }),

      remove: (id: string) =>
        prisma.room.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    educationSystems: {
      list: (where?: Prisma.EducationSystemWhereInput) =>
        prisma.educationSystem.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
        }),

      count: (where?: Prisma.EducationSystemWhereInput) =>
        prisma.educationSystem.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) =>
        scopedFindById(prisma.educationSystem, centerId, id),

      create: (
        data: Omit<Prisma.EducationSystemUncheckedCreateInput, "centerId">,
      ) => prisma.educationSystem.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.EducationSystemUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.educationSystem.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.educationSystem.deleteMany({
          where: scopedWhere(centerId, { id }),
        }),
    },

    grades: {
      list: (where?: Prisma.GradeWhereInput) =>
        prisma.grade.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
          include: { educationSystem: true },
        }),

      count: (where?: Prisma.GradeWhereInput) =>
        prisma.grade.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.grade, centerId, id),

      create: (data: Omit<Prisma.GradeUncheckedCreateInput, "centerId">) =>
        prisma.grade.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Omit<Prisma.GradeUncheckedUpdateManyInput, "centerId">) =>
        prisma.grade.updateMany({ where: scopedWhere(centerId, { id }), data }),

      remove: (id: string) =>
        prisma.grade.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    subjects: {
      list: (where?: Prisma.SubjectWhereInput) =>
        prisma.subject.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
          include: { grade: true },
        }),

      count: (where?: Prisma.SubjectWhereInput) =>
        prisma.subject.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.subject, centerId, id),

      create: (data: Omit<Prisma.SubjectUncheckedCreateInput, "centerId">) =>
        prisma.subject.create({ data: scopedData(centerId, data) }),

      update: (id: string, data: Omit<Prisma.SubjectUncheckedUpdateManyInput, "centerId">) =>
        prisma.subject.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.subject.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    // Counts only for now — M4 owns classes and sessions. They exist here so
    // settings can refuse to delete master data that is still referenced.
    classGroups: {
      count: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.count({ where: scopedWhere(centerId, where) }),
    },

    sessions: {
      count: (where?: Prisma.SessionWhereInput) =>
        prisma.session.count({ where: scopedWhere(centerId, where) }),
    },

    settings: {
      get: () => prisma.centerSettings.findUnique({ where: { centerId } }),

      /**
       * Upsert, not update: a center provisioned without a settings row (or
       * one created before a column existed) must still be configurable from
       * the UI. `centerId` is unique, so this is already center-scoped.
       */
      save: (data: Prisma.CenterSettingsUncheckedUpdateInput) =>
        prisma.centerSettings.upsert({
          where: { centerId },
          update: data,
          create: {
            ...(data as Prisma.CenterSettingsUncheckedCreateInput),
            centerId,
          },
        }),
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
