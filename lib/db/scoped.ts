import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  STUDENT_LIST_SELECT,
  TEACHER_LIST_SELECT,
} from "@/lib/db/students";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "@/lib/db/tenant-scope";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER: Role = "TEACHER";

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

    /**
     * Teachers are Memberships with role TEACHER (CLAUDE.md rule 4) — the
     * person is a global User, their relationship to this center is the row
     * below. Every helper pins the role as well as the center, so a staff
     * membership can never be edited through a teacher screen.
     */
    teachers: {
      list: (where?: Prisma.MembershipWhereInput) =>
        prisma.membership.findMany({
          where: scopedWhere(centerId, { ...where, role: TEACHER }),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          include: { user: true },
        }),

      /** The list screen: a lean select (never the whole User row), paged. */
      search: (args: {
        where?: Prisma.MembershipWhereInput;
        take: number;
        skip?: number;
      }) =>
        prisma.membership.findMany({
          where: scopedWhere(centerId, { ...args.where, role: TEACHER }),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          select: TEACHER_LIST_SELECT,
          take: args.take,
          skip: args.skip,
        }),

      count: (where?: Prisma.MembershipWhereInput) =>
        prisma.membership.count({
          where: scopedWhere(centerId, { ...where, role: TEACHER }),
        }),

      findById: (id: string) =>
        prisma.membership.findFirst({
          where: scopedWhere(centerId, { id, role: TEACHER }),
          include: { user: true },
        }),

      findByUserId: (userId: string) =>
        prisma.membership.findFirst({
          where: scopedWhere(centerId, { userId, role: TEACHER }),
          include: { user: true },
        }),

      create: (data: Omit<Prisma.MembershipUncheckedCreateInput, "centerId">) =>
        prisma.membership.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.MembershipUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.membership.updateMany({
          where: scopedWhere(centerId, { id, role: TEACHER }),
          data,
        }),

      remove: (id: string) =>
        prisma.membership.deleteMany({
          where: scopedWhere(centerId, { id, role: TEACHER }),
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

      /**
       * The list screen: filtered, ordered and paged in the database, with a
       * lean `select` — never the whole `User`/`Grade` row for a list of
       * potentially thousands (docs/02-architecture.md §14).
       */
      search: (args: {
        where?: Prisma.StudentProfileWhereInput;
        take: number;
        skip?: number;
      }) =>
        prisma.studentProfile.findMany({
          where: scopedWhere(centerId, args.where),
          orderBy: [{ active: "desc" }, { studentCode: "asc" }],
          select: STUDENT_LIST_SELECT,
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) =>
        scopedFindById(prisma.studentProfile, centerId, id),

      findDetailById: (id: string) =>
        prisma.studentProfile.findFirst({
          where: scopedWhere(centerId, { id }),
          include: { user: true, grade: true },
        }),

      findByUserId: (userId: string) =>
        prisma.studentProfile.findFirst({
          where: scopedWhere(centerId, { userId }),
        }),

      requireById: (id: string) =>
        requireScopedById(prisma.studentProfile, centerId, id, "StudentProfile"),

      create: (
        data: Omit<Prisma.StudentProfileUncheckedCreateInput, "centerId">,
      ) => prisma.studentProfile.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.StudentProfileUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.studentProfile.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.studentProfile.deleteMany({
          where: scopedWhere(centerId, { id }),
        }),

      /**
       * End-of-term grade promotion. A scoped updateMany, so a grade id from
       * another center matches zero students rather than the wrong ones.
       */
      promoteGrade: (fromGradeId: string, toGradeId: string) =>
        prisma.studentProfile.updateMany({
          where: scopedWhere(centerId, { gradeId: fromGradeId, active: true }),
          data: { gradeId: toGradeId },
        }),
    },

    /**
     * Teacher/class block-list (spec §5 "Blocking"). `refId` is the teacher's
     * User id for scope TEACHER; `blockedUserId` is the student's User id.
     * Enforcement on enrol/add lands with M4/M5 — `isBlocked()` is the seam.
     */
    studentBlocks: {
      list: (where?: Prisma.StudentBlockWhereInput) =>
        prisma.studentBlock.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
        }),

      count: (where?: Prisma.StudentBlockWhereInput) =>
        prisma.studentBlock.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) =>
        scopedFindById(prisma.studentBlock, centerId, id),

      isBlocked: async (
        scope: "TEACHER" | "CLASS",
        refId: string,
        blockedUserId: string,
      ) =>
        (await prisma.studentBlock.count({
          where: scopedWhere(centerId, { scope, refId, blockedUserId }),
        })) > 0,

      /**
       * How many blocks each of these refs (teacher User ids) carries — one
       * grouped query instead of fetching every block row in the center just
       * to count them in memory (docs/02-architecture.md §14).
       */
      countByRef: async (
        scope: "TEACHER" | "CLASS",
        refIds: string[],
      ): Promise<Map<string, number>> => {
        if (refIds.length === 0) return new Map();
        const rows = await prisma.studentBlock.groupBy({
          by: ["refId"],
          where: scopedWhere(centerId, { scope, refId: { in: refIds } }),
          _count: { refId: true },
        });
        return new Map(rows.map((row) => [row.refId, row._count.refId]));
      },

      create: (data: Omit<Prisma.StudentBlockUncheckedCreateInput, "centerId">) =>
        prisma.studentBlock.create({ data: scopedData(centerId, data) }),

      remove: (id: string) =>
        prisma.studentBlock.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    /** M4 owns enrolment; M3 reads it for the student's enrolment view. */
    enrollments: {
      count: (where?: Prisma.EnrollmentWhereInput) =>
        prisma.enrollment.count({ where: scopedWhere(centerId, where) }),

      listForStudent: (studentProfileId: string) =>
        prisma.enrollment.findMany({
          where: scopedWhere(centerId, { studentProfileId }),
          orderBy: { enrolledAt: "desc" },
          include: {
            classGroup: {
              include: { subject: true, grade: true, teacher: true },
            },
          },
        }),
    },

    attendees: {
      count: (where?: Prisma.SessionAttendeeWhereInput) =>
        prisma.sessionAttendee.count({ where: scopedWhere(centerId, where) }),
    },

    payments: {
      count: (where?: Prisma.PaymentWhereInput) =>
        prisma.payment.count({ where: scopedWhere(centerId, where) }),
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

    // M4 owns class CRUD. M3 reads them for the teacher detail page, and
    // settings counts references before allowing a delete.
    classGroups: {
      count: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.count({ where: scopedWhere(centerId, where) }),

      list: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          include: { subject: true, grade: true, room: true },
        }),
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
