import type { EnrollmentStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  STUDENT_LIST_SELECT,
  TEACHER_LIST_SELECT,
} from "@/lib/db/students";
import {
  CLASS_DETAIL_INCLUDE,
  CLASS_LIST_SELECT,
} from "@/lib/db/classes";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "@/lib/db/tenant-scope";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER: Role = "TEACHER";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";
const EXISTING_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];

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

    /**
     * A student's link to a class (M4). Capacity and duplicate-enrollment
     * checks live in the Server Action, right beside the `StudentBlock`
     * (scope CLASS) check — both are re-verified against this center, never
     * trusted from the form.
     */
    enrollments: {
      count: (where?: Prisma.EnrollmentWhereInput) =>
        prisma.enrollment.count({ where: scopedWhere(centerId, where) }),

      countActive: (classGroupId: string) =>
        prisma.enrollment.count({
          where: scopedWhere(centerId, {
            classGroupId,
            status: ACTIVE_ENROLLMENT,
          }),
        }),

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

      /** The roster a class detail page renders — lean, this page's own students. */
      listForClass: (classGroupId: string) =>
        prisma.enrollment.findMany({
          where: scopedWhere(centerId, { classGroupId }),
          orderBy: { enrolledAt: "asc" },
          include: {
            studentProfile: { include: { user: true } },
          },
        }),

      /** Active or blocked — what "already on this roster" actually means. */
      findExisting: (classGroupId: string, studentProfileId: string) =>
        prisma.enrollment.findFirst({
          where: scopedWhere(centerId, {
            classGroupId,
            studentProfileId,
            status: { in: EXISTING_ENROLLMENT_STATUSES },
          }),
        }),

      findById: (id: string) => scopedFindById(prisma.enrollment, centerId, id),

      create: (data: Omit<Prisma.EnrollmentUncheckedCreateInput, "centerId">) =>
        prisma.enrollment.create({ data: scopedData(centerId, data) }),

      setStatus: (id: string, status: Prisma.EnrollmentUncheckedUpdateManyInput["status"]) =>
        prisma.enrollment.updateMany({
          where: scopedWhere(centerId, { id }),
          data: { status },
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

    /**
     * Classes (M4). The teacher detail page and settings' reference counts
     * already used `count`/`list` before this milestone — extended here with
     * the full CRUD the classes screens need.
     */
    classGroups: {
      count: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.count({ where: scopedWhere(centerId, where) }),

      list: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          include: { subject: true, grade: true, room: true },
        }),

      /** The list screen: a lean select, filtered, ordered and paged. */
      search: (args: {
        where?: Prisma.ClassGroupWhereInput;
        take: number;
        skip?: number;
      }) =>
        prisma.classGroup.findMany({
          where: scopedWhere(centerId, args.where),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          select: CLASS_LIST_SELECT,
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) => scopedFindById(prisma.classGroup, centerId, id),

      findDetailById: (id: string) =>
        prisma.classGroup.findFirst({
          where: scopedWhere(centerId, { id }),
          include: CLASS_DETAIL_INCLUDE,
        }),

      create: (data: Omit<Prisma.ClassGroupUncheckedCreateInput, "centerId">) =>
        prisma.classGroup.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.ClassGroupUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.classGroup.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.classGroup.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    /**
     * Recurring weekly slots for a class — the Schedule Builder (docs/04 §9).
     * `listForConflictCheck` is every *other* class's slots in the center, the
     * candidate universe `lib/scheduling.ts`'s `findScheduleConflicts` checks
     * against; it excludes the class being edited so a class never "conflicts"
     * with its own other slots.
     */
    classSchedules: {
      list: (classGroupId: string) =>
        prisma.classSchedule.findMany({
          where: scopedWhere(centerId, { classGroupId }),
          orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
        }),

      listForConflictCheck: (excludeClassGroupId: string) =>
        prisma.classSchedule.findMany({
          where: scopedWhere(centerId, {
            classGroupId: { not: excludeClassGroupId },
          }),
          select: {
            classGroupId: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
            classGroup: {
              select: {
                teacherId: true,
                roomId: true,
                subject: { select: { name: true } },
                grade: { select: { name: true } },
              },
            },
          },
        }),

      findById: (id: string) => scopedFindById(prisma.classSchedule, centerId, id),

      create: (data: Omit<Prisma.ClassScheduleUncheckedCreateInput, "centerId">) =>
        prisma.classSchedule.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.ClassScheduleUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.classSchedule.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.classSchedule.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    sessions: {
      count: (where?: Prisma.SessionWhereInput) =>
        prisma.session.count({ where: scopedWhere(centerId, where) }),
    },

    /** The center's holiday calendar (docs/02 §11) — dates the generator skips. */
    holidays: {
      list: () =>
        prisma.holiday.findMany({
          where: scopedWhere(centerId),
          orderBy: { date: "asc" },
        }),

      findById: (id: string) => scopedFindById(prisma.holiday, centerId, id),

      create: (data: Omit<Prisma.HolidayUncheckedCreateInput, "centerId">) =>
        prisma.holiday.create({ data: scopedData(centerId, data) }),

      remove: (id: string) =>
        prisma.holiday.deleteMany({ where: scopedWhere(centerId, { id }) }),
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
