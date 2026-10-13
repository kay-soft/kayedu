import type {
  EnrollmentStatus,
  Prisma,
  ReservationStatus,
  Role,
  SessionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db/client";
import * as catalog from "@/lib/db/catalog";
import { CATALOG_OVERRIDE_SELECT, catalogLabel } from "@/lib/catalog";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  TEACHER_LIST_SELECT,
  studentListSelect,
} from "@/lib/db/students";
import {
  classDetailInclude,
  classListSelect,
} from "@/lib/db/classes";
import {
  sessionDetailInclude,
  sessionListSelect,
} from "@/lib/db/sessions";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "@/lib/db/tenant-scope";
import { staffInvitationFilter, staffMembershipFilter } from "@/lib/db/staff-filter";
import { visibilityWindowFloor } from "@/lib/db/visibility";
import {
  PAYMENT_METHOD_ORDER,
  listActivePaymentMethods,
} from "@/lib/db/payment-methods";
import { listSessionAttendanceChanges } from "@/lib/db/session-lifecycle";
import { loadRoomLinks } from "@/lib/db/room-sets";
import { OPEN_CLASS_SESSION } from "@/lib/db/slot-conflicts";
import { listCenterTerms } from "@/lib/db/terms";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER: Role = "TEACHER";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";
const EXISTING_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];
const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const PENDING_RESERVATION: ReservationStatus = "PENDING";

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
  // M19 data-visibility window (docs/01 §7) — `null` for a platform admin.
  // Every other date-filterable centre-side read (Sessions, Analytics,
  // Expenses) clamps its own caller-supplied range with this same helper at
  // the page level, since those already take an explicit `from`/`to`; this is
  // only for `refunds.list` below, which has no caller-supplied date param at
  // all to clamp.
  const visibilityFloor = visibilityWindowFloor(ctx);
  // The account's own remembered locale — the best signal available inside a
  // scoped-only helper for resolving a catalog entry's bilingual name into
  // the flat `.name` shape every existing list/select-option consumer
  // already expects (M13, docs/01-data-model.md "Academic catalog layer").
  const locale = ctx.user.locale ?? "ar";

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

      /**
       * Users & Roles' list (R9): centre staff only — OWNER, MANAGER,
       * RECEPTIONIST, ACCOUNTANT. Teachers are managed on the Teachers page
       * (`teachers.list` below), never here.
       */
      listStaffWithUser: (where?: Prisma.MembershipWhereInput) =>
        prisma.membership.findMany({
          where: scopedWhere(centerId, staffMembershipFilter(where)),
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

      /** Users & Roles' pending list (R9): staff roles only, see `staff-filter.ts`. */
      listStaff: (where?: Prisma.InvitationWhereInput) =>
        prisma.invitation.findMany({
          where: scopedWhere(centerId, staffInvitationFilter(where)),
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
          select: studentListSelect(centerId),
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) =>
        scopedFindById(prisma.studentProfile, centerId, id),

      findDetailById: (id: string) =>
        prisma.studentProfile.findFirst({
          where: scopedWhere(centerId, { id }),
          include: {
            user: true,
            grade: { include: { selections: { where: { centerId } } } },
          },
        }),

      findByUserId: (userId: string) =>
        prisma.studentProfile.findFirst({
          where: scopedWhere(centerId, { userId }),
        }),

      /** The exact-match lookup a scanned ID-card QR resolves through (M5). */
      findByCode: (studentCode: string) =>
        prisma.studentProfile.findFirst({
          where: scopedWhere(centerId, { studentCode }),
          include: { user: true },
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
              include: {
                subject: { include: { selections: { where: { centerId } } } },
                grade: { include: { selections: { where: { centerId } } } },
                teacher: true,
              },
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

      /**
       * Any row for this pair, any status — including REMOVED. The table has
       * a hard @@unique([studentProfileId, classGroupId]), so a student who
       * was removed from a class still owns that row forever; re-enrolling
       * must reactivate it rather than insert a second one.
       */
      findAny: (classGroupId: string, studentProfileId: string) =>
        prisma.enrollment.findFirst({
          where: scopedWhere(centerId, { classGroupId, studentProfileId }),
        }),

      findById: (id: string) => scopedFindById(prisma.enrollment, centerId, id),

      create: (data: Omit<Prisma.EnrollmentUncheckedCreateInput, "centerId">) =>
        prisma.enrollment.create({ data: scopedData(centerId, data) }),

      reactivate: (id: string) =>
        prisma.enrollment.updateMany({
          where: scopedWhere(centerId, { id }),
          data: { status: ACTIVE_ENROLLMENT, enrolledAt: new Date() },
        }),

      setStatus: (id: string, status: Prisma.EnrollmentUncheckedUpdateManyInput["status"]) =>
        prisma.enrollment.updateMany({
          where: scopedWhere(centerId, { id }),
          data: { status },
        }),
    },

    attendees: {
      count: (where?: Prisma.SessionAttendeeWhereInput) =>
        prisma.sessionAttendee.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) =>
        scopedFindById(prisma.sessionAttendee, centerId, id),

      /** The full row a session-detail action needs to check/audit against. */
      findDetailById: (id: string) =>
        prisma.sessionAttendee.findFirst({
          where: scopedWhere(centerId, { id }),
          include: {
            studentProfile: { include: { user: true } },
            payments: { orderBy: { recordedAt: "desc" } },
          },
        }),

      /** Existing roster row for (session, student) — null if never marked. */
      findExisting: (sessionId: string, studentProfileId: string) =>
        prisma.sessionAttendee.findFirst({
          where: scopedWhere(centerId, { sessionId, studentProfileId }),
        }),
    },

    /**
     * Live-session attendance status changes (R2) — read-only here; the only
     * writer is `lib/db/attendance.ts`'s `changeAttendanceStatus`, inside the
     * same transaction as the change (and any void) it records.
     */
    attendanceChanges: {
      count: (where?: Prisma.SessionAttendanceChangeWhereInput) =>
        prisma.sessionAttendanceChange.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.sessionAttendanceChange, centerId, id),

      /** The receipt's "Changes during session" rows, oldest first, names resolved. */
      listForSession: (sessionId: string) =>
        listSessionAttendanceChanges(prisma, centerId, sessionId),
    },

    payments: {
      count: (where?: Prisma.PaymentWhereInput) =>
        prisma.payment.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) => scopedFindById(prisma.payment, centerId, id),
    },

    /**
     * The refunds ledger (M14, spec §4.1 item 12) — read-only here; the
     * write path (`lib/db/refunds.ts`'s `refundPayment`) takes `centerId`
     * directly, the same shape `recordPayment`/`voidPayment` already use,
     * since it runs inside the same transaction as the Server Action's
     * audit write.
     */
    refunds: {
      list: (take = 100) =>
        prisma.refund.findMany({
          where: scopedWhere(
            centerId,
            visibilityFloor ? { refundedAt: { gte: visibilityFloor } } : undefined,
          ),
          orderBy: { refundedAt: "desc" },
          take,
          include: {
            payment: {
              include: {
                studentProfile: { include: { user: true } },
                session: {
                  include: {
                    classGroup: {
                      include: {
                        subject: { include: { selections: { where: { centerId } } } },
                        grade: { include: { selections: { where: { centerId } } } },
                      },
                    },
                    // R5 — a one-time session's own subject/grade (no class).
                    subject: { include: { selections: { where: { centerId } } } },
                    grade: { include: { selections: { where: { centerId } } } },
                  },
                },
              },
            },
          },
        }),
    },

    /**
     * Teacher settlements (M14, spec §4.1 item 11 / §4.2 item 9) — read-only
     * here; creation and every DRAFT→APPROVED/APPROVED→PAID transition go
     * through `lib/db/settlements.ts` directly with `centerId`, the same
     * "money write takes centerId, not ScopedDb" shape as payments/refunds.
     */
    settlements: {
      list: (where?: Prisma.SettlementWhereInput) =>
        prisma.settlement.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
          include: {
            session: {
              include: {
                classGroup: {
                  include: {
                    subject: { include: { selections: { where: { centerId } } } },
                    grade: { include: { selections: { where: { centerId } } } },
                  },
                },
                // R5 — a one-time session's own subject/grade (no class).
                subject: { include: { selections: { where: { centerId } } } },
                grade: { include: { selections: { where: { centerId } } } },
              },
            },
          },
        }),

      findById: (id: string) => scopedFindById(prisma.settlement, centerId, id),
    },

    // ── Academic / config master data (docs/01-data-model.md §2) ───────────
    // Same shape for every entity: scoped list, scoped lookup, scoped write.
    // `update`/`remove` go through updateMany/deleteMany with a scoped where so
    // an id from another center matches zero rows instead of the wrong one.

    rooms: {
      list: (where?: Prisma.RoomWhereInput) =>
        prisma.room.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
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

    /**
     * Joinable rooms (R3, docs/01 "Config layer"). Reads only — every link
     * write (and its "in use" refusal) goes through `lib/db/room-sets.ts`,
     * which owns normalization, the same-centre rule and the self-link
     * refusal; a generic `create`/`remove` here would be a way around them.
     */
    roomLinks: {
      list: () => loadRoomLinks(prisma, centerId),
    },

    /** The extra rooms of each class (R3) — reads only, see `roomLinks`. */
    classGroupRooms: {
      listForClass: (classGroupId: string) =>
        prisma.classGroupRoom.findMany({
          where: scopedWhere(centerId, { classGroupId }),
          include: { room: true },
          orderBy: { createdAt: "asc" },
        }),
    },

    /** The extra rooms of each session (R3) — reads only, see `roomLinks`. */
    sessionRooms: {
      listForSession: (sessionId: string) =>
        prisma.sessionRoom.findMany({
          where: scopedWhere(centerId, { sessionId }),
          include: { room: true },
          orderBy: { createdAt: "asc" },
        }),
    },

    /**
     * Payment methods (R1) — reads only. Every state change (create, rename,
     * activate/deactivate, delete) goes through `lib/db/payment-methods.ts`,
     * which owns the "at least one active method" and "referenced → deactivate,
     * never delete" rules; a generic `update`/`remove` here would be a way
     * around both.
     */
    paymentMethods: {
      /** Settings list: active first, then picker order. */
      list: () =>
        prisma.centerPaymentMethod.findMany({
          where: scopedWhere(centerId),
          orderBy: [{ active: "desc" }, ...PAYMENT_METHOD_ORDER],
        }),

      /** What a payment picker offers — active only, oldest first. */
      listActive: () => listActivePaymentMethods(prisma, centerId),

      findById: (id: string) =>
        scopedFindById(prisma.centerPaymentMethod, centerId, id),
    },

    /**
     * The academic catalog (M13, docs/01-data-model.md "Academic catalog
     * layer"). These three no longer author rows — `list`/`findById` read
     * this centre's own `CenterCatalogSelection` picks joined with the
     * global catalog entry, resolved into the same flat `{ id, active,
     * name, ... }` shape every existing consumer already expects (`name` is
     * resolved by `lib/catalog.ts`'s `catalogLabel`: the centre's override in
     * the account's language if it set one, else the catalog entry's own name
     * in that language). `findById` returning non-null **is** the tenant
     * boundary: a catalog id this centre never selected resolves to
     * nothing, exactly like an id from another centre used to. Selecting,
     * renaming and deselecting go through `lib/db/catalog.ts` directly
     * (`app/[locale]/(center)/settings/actions.ts`), since they are a
     * materially different write shape than "author a new row."
     *
     * **`list({ active: true })` is the picker list (R8):** a pick the centre
     * switched off *and* an entry the platform deactivated are both left out.
     * `list()` / `findById` still return them — that is what lets a class, a
     * session or a student that already uses a deactivated entry keep
     * resolving its name; each row carries `catalogActive` for callers that
     * need to tell the two apart.
     */
    educationSystems: {
      list: async (opts?: { active?: boolean }) => {
        const rows = await catalog.centerEducationSystems(prisma, centerId);
        return rows
          .filter((row) => (opts?.active ? row.active && row.catalogActive : true))
          .map((row) => ({ ...row, name: catalogLabel(locale, row, row) }));
      },

      findById: async (id: string) => {
        const row = await catalog.centerEducationSystemById(prisma, centerId, id);
        return row ? { ...row, name: catalogLabel(locale, row, row) } : null;
      },
    },

    grades: {
      list: async (opts?: { active?: boolean }) => {
        const rows = await catalog.centerGrades(prisma, centerId);
        return rows
          .filter((row) => (opts?.active ? row.active && row.catalogActive : true))
          .map((row) => ({ ...row, name: catalogLabel(locale, row, row) }));
      },

      findById: async (id: string) => {
        const row = await catalog.centerGradeById(prisma, centerId, id);
        return row ? { ...row, name: catalogLabel(locale, row, row) } : null;
      },
    },

    subjects: {
      list: async (opts?: { active?: boolean }) => {
        const rows = await catalog.centerSubjects(prisma, centerId);
        return rows
          .filter((row) => (opts?.active ? row.active && row.catalogActive : true))
          .map((row) => ({ ...row, name: catalogLabel(locale, row, row) }));
      },

      findById: async (id: string) => {
        const row = await catalog.centerSubjectById(prisma, centerId, id);
        return row ? { ...row, name: catalogLabel(locale, row, row) } : null;
      },
    },

    /**
     * Classes (M4) — reads only since R4. Every class write (create, edit,
     * slots, deactivate, reactivate, delete) goes through
     * `lib/db/class-sessions.ts`, which owns the class's sessions; a generic
     * `create`/`update`/`remove` here would be a way around that engine.
     */
    classGroups: {
      count: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.count({ where: scopedWhere(centerId, where) }),

      list: (where?: Prisma.ClassGroupWhereInput) =>
        prisma.classGroup.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { createdAt: "desc" }],
          include: {
            subject: { include: { selections: { where: { centerId } } } },
            grade: { include: { selections: { where: { centerId } } } },
            room: true,
          },
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
          select: classListSelect(centerId),
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) => scopedFindById(prisma.classGroup, centerId, id),

      findDetailById: (id: string) =>
        prisma.classGroup.findFirst({
          where: scopedWhere(centerId, { id }),
          include: classDetailInclude(centerId),
        }),

      /**
       * R5 — what the "New session" dialog's "For a class" mode defaults
       * from: every **active** class (a deactivated one takes no new
       * session) with its teacher, room set and weekly slots.
       */
      listForNewSession: () =>
        prisma.classGroup.findMany({
          where: scopedWhere(centerId, { active: true }),
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            teacherId: true,
            roomId: true,
            extraRooms: { select: { roomId: true }, orderBy: { createdAt: "asc" } },
            schedules: {
              select: { dayOfWeek: true, startTime: true, endTime: true },
              orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
            },
            subject: {
              select: {
                nameAr: true,
                nameEn: true,
                selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
              },
            },
            grade: {
              select: {
                nameAr: true,
                nameEn: true,
                selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
              },
            },
          },
        }),
    },

    /**
     * Recurring weekly slots for a class — the Schedule Builder (docs/04 §9).
     * Reads only since R4: adding, moving or removing a slot resyncs the
     * class's sessions, so it goes through `lib/db/class-sessions.ts`'s
     * `writeClassSlot`.
     */
    classSchedules: {
      list: (classGroupId: string) =>
        prisma.classSchedule.findMany({
          where: scopedWhere(centerId, { classGroupId }),
          orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
        }),

      findById: (id: string) => scopedFindById(prisma.classSchedule, centerId, id),
    },

    /**
     * Sessions (M5): the Today's Sessions dashboard, session detail, and
     * Reception Desk all read through here. Money/attendance *writes* go
     * through `lib/db/attendance.ts`/`lib/db/payments.ts` instead, inside a
     * transaction — this object is read-only plus the plain-column session
     * lookups those actions need first.
     */
    sessions: {
      count: (where?: Prisma.SessionWhereInput) =>
        prisma.session.count({ where: scopedWhere(centerId, where) }),

      /**
       * The dashboard: a lean select, filtered and ordered by time of day.
       * The status filter (SCHEDULED/LIVE/COMPLETED) is derived from the
       * clock, not a column (`deriveSessionDisplayStatus`), so it is applied
       * in the page after this query rather than in `where` — `take` here is
       * a defensive cap, not the real page size; the date-range filter
       * already bounds this to "one center's day/week/month", never the
       * whole table (docs/02-architecture.md §14).
       */
      search: (args: { where?: Prisma.SessionWhereInput }) =>
        prisma.session.findMany({
          where: scopedWhere(centerId, args.where),
          orderBy: [{ date: "asc" }, { startTime: "asc" }],
          select: sessionListSelect(centerId),
          take: 1000,
        }),

      findById: (id: string) => scopedFindById(prisma.session, centerId, id),

      findDetailById: (id: string) =>
        prisma.session.findFirst({
          where: scopedWhere(centerId, { id }),
          include: sessionDetailInclude(centerId),
        }),

      /**
       * Today's non-cancelled sessions — the Reception Desk's live rail and
       * the dashboard's today list. R4: a deactivated class's sessions are
       * not on it unless they are closed records (`OPEN_CLASS_SESSION`).
       */
      listForDay: (date: Date) =>
        prisma.session.findMany({
          where: scopedWhere(centerId, {
            date,
            status: { not: CANCELLED_STATUS },
            ...OPEN_CLASS_SESSION,
          }),
          orderBy: [{ startTime: "asc" }],
          select: sessionListSelect(centerId),
        }),

      /**
       * The one session field a teacher may edit from their own portal (M7,
       * spec §4.2 item 2). Pinned to `teacherId` as well as `centerId`, so a
       * teacher can never touch another teacher's session even within a
       * center they both belong to — no teacher edit-deadline setting exists
       * yet (docs/00 §5 "Attendance" M5 note), so this is unconditional.
       */
      updateDescription: (id: string, teacherId: string, description: string | null) =>
        prisma.session.updateMany({
          where: scopedWhere(centerId, { id, teacherId }),
          data: { description },
        }),
    },

    /**
     * The center's holiday calendar (docs/02 §11) — dates the class-sessions
     * engine skips. Adding one also removes that day's pristine sessions, so
     * the insert lives in the holiday action's own transaction.
     */
    holidays: {
      list: () =>
        prisma.holiday.findMany({
          where: scopedWhere(centerId),
          orderBy: { date: "asc" },
        }),

      findById: (id: string) => scopedFindById(prisma.holiday, centerId, id),

      remove: (id: string) =>
        prisma.holiday.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    /**
     * The centre's term presets (R4) — reads only. Every write (and its
     * case-insensitive name rule) is `lib/db/terms.ts`'s.
     */
    terms: {
      list: () => listCenterTerms(prisma, centerId),

      /** What the class form's "Choose a term" offers. */
      listActive: () => listCenterTerms(prisma, centerId, { activeOnly: true }),

      findById: (id: string) => scopedFindById(prisma.centerTerm, centerId, id),
    },

    /** Expense categories (M6) — same shape as the other master-data entities. */
    expenseCategories: {
      list: (where?: Prisma.ExpenseCategoryWhereInput) =>
        prisma.expenseCategory.findMany({
          where: scopedWhere(centerId, where),
          orderBy: [{ active: "desc" }, { name: "asc" }],
        }),

      count: (where?: Prisma.ExpenseCategoryWhereInput) =>
        prisma.expenseCategory.count({ where: scopedWhere(centerId, where) }),

      findById: (id: string) =>
        scopedFindById(prisma.expenseCategory, centerId, id),

      create: (
        data: Omit<Prisma.ExpenseCategoryUncheckedCreateInput, "centerId">,
      ) => prisma.expenseCategory.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.ExpenseCategoryUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.expenseCategory.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),

      remove: (id: string) =>
        prisma.expenseCategory.deleteMany({ where: scopedWhere(centerId, { id }) }),
    },

    /**
     * Expenses (M6, spec §4.1 item 6). Create-and-audit, never edited in
     * place — a mistaken entry is deleted (also audited) and re-added, the
     * same "financial changes are audited" spirit as Payment/void
     * (CLAUDE.md rule 7), without the append-only ledger machinery Payment
     * needs (an Expense carries no downstream snapshot that must survive it).
     */
    expenses: {
      count: (where?: Prisma.ExpenseWhereInput) =>
        prisma.expense.count({ where: scopedWhere(centerId, where) }),

      /** The list screen: lean, filtered, ordered and paged. */
      search: (args: {
        where?: Prisma.ExpenseWhereInput;
        take: number;
        skip?: number;
      }) =>
        prisma.expense.findMany({
          where: scopedWhere(centerId, args.where),
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          include: { category: true },
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) => scopedFindById(prisma.expense, centerId, id),

      create: (data: Omit<Prisma.ExpenseUncheckedCreateInput, "centerId">) =>
        prisma.expense.create({ data: scopedData(centerId, data) }),

      remove: (id: string) =>
        prisma.expense.deleteMany({ where: scopedWhere(centerId, { id }) }),
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

    /**
     * A teacher's request to add a class/session at this center (M7, docs/01
     * §2 "Workflow layer"). Feeds the Approvals screen — not yet built
     * (docs/03-build-order.md M6 note); this is the write path + a read a
     * teacher's own "my requests" list uses today.
     */
    changeRequests: {
      list: (where?: Prisma.ChangeRequestWhereInput) =>
        prisma.changeRequest.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
        }),

      findById: (id: string) => scopedFindById(prisma.changeRequest, centerId, id),

      create: (data: Omit<Prisma.ChangeRequestUncheckedCreateInput, "centerId">) =>
        prisma.changeRequest.create({ data: scopedData(centerId, data) }),

      update: (
        id: string,
        data: Omit<Prisma.ChangeRequestUncheckedUpdateManyInput, "centerId">,
      ) =>
        prisma.changeRequest.updateMany({
          where: scopedWhere(centerId, { id }),
          data,
        }),
    },

    /**
     * A student's request to join a class (M8, `lib/db/reservations.ts`).
     * Read-only here — the Approvals screen's queue (M8.5) — because the
     * actual confirm/reject *writes* re-check blocking/capacity and touch
     * `Enrollment`/`StudentProfile` too, so they stay in
     * `lib/db/reservations.ts`'s `confirmReservation`/`rejectReservation`
     * (called with `centerId` directly, exactly like `recordPayment`/
     * `voidPayment`, not through this object).
     */
    reservations: {
      /** The Approvals queue's own section: this center's PENDING requests. */
      listPending: () =>
        prisma.reservation.findMany({
          // R4: a deactivated class's requests wait, unseen, until it is
          // reactivated — `confirmReservation` refuses them meanwhile.
          where: scopedWhere(centerId, { status: PENDING_RESERVATION, classGroup: { active: true } }),
          orderBy: { requestedAt: "asc" },
          include: {
            student: true,
            classGroup: {
              include: {
                subject: { include: { selections: { where: { centerId } } } },
                grade: { include: { selections: { where: { centerId } } } },
              },
            },
          },
        }),

      /**
       * A teacher's own approvals queue (M15, spec §4.2 item 6): PENDING
       * requests for classes *this* teacher teaches — a separate, narrower
       * view of the same `Reservation` data the centre's own queue reads,
       * never a parallel workflow.
       */
      listPendingForTeacher: (teacherId: string) =>
        prisma.reservation.findMany({
          where: scopedWhere(centerId, {
            status: PENDING_RESERVATION,
            classGroup: { teacherId, active: true },
          }),
          orderBy: { requestedAt: "asc" },
          include: {
            student: true,
            classGroup: {
              include: {
                subject: { include: { selections: { where: { centerId } } } },
                grade: { include: { selections: { where: { centerId } } } },
              },
            },
          },
        }),

      findById: (id: string) => scopedFindById(prisma.reservation, centerId, id),
    },
  };
}

export type ScopedDb = ReturnType<typeof scoped>;
