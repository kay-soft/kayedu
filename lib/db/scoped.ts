import type {
  EnrollmentStatus,
  Prisma,
  PrismaClient,
  ReservationStatus,
  Role,
  SessionStatus,
} from "@prisma/client";
// Relative imports and an injected client (SYS): `npm run check:visibility`
// calls the real helpers by direct call, outside Next (docs/02 §5). The app
// passes the shared singleton through `scoped(ctx)`.
import { prisma as sharedClient } from "./client.ts";
import * as catalog from "./catalog.ts";
import { CATALOG_OVERRIDE_SELECT, catalogLabel } from "../catalog.ts";
import {
  TEACHER_LIST_SELECT,
  studentListSelect,
} from "./students.ts";
import {
  classDetailInclude,
  classListSelect,
} from "./classes.ts";
import {
  sessionDetailInclude,
  sessionListSelect,
} from "./sessions.ts";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "./tenant-scope.ts";
import { staffInvitationFilter, staffMembershipFilter } from "./staff-filter.ts";
import { centreReadFloor } from "./visibility.ts";
import { consecutiveAbsenceCount } from "./attendance.ts";
import {
  PAYMENT_METHOD_ORDER,
  listActivePaymentMethods,
} from "./payment-methods.ts";
import { listSessionAttendanceChanges } from "./session-lifecycle.ts";
import { loadRoomLinks } from "./room-sets.ts";
import { OPEN_CLASS_SESSION } from "./slot-conflicts.ts";
import { listCenterTerms } from "./terms.ts";

/**
 * What a scoped data layer needs of the request's tenant context — a real
 * `TenantContext` (`lib/auth/tenant.ts`) satisfies it; a gate builds one by
 * hand.
 */
export type ScopeContext = {
  center: { id: string };
  user: { locale: string | null };
  role: string;
  isPlatformAdmin: boolean;
  settings: { dataVisibilityDays: number; timezone: string } | null;
};

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
export function scoped(ctx: ScopeContext) {
  return scopedWith(sharedClient, ctx);
}

/**
 * `scoped(ctx)` over an explicit client — the dependency-injection seam
 * (docs/02 §5): the app uses `scoped(ctx)`; a gate passes its own client.
 */
export function scopedWith(client: PrismaClient, ctx: ScopeContext, options: { now?: Date } = {}) {
  // `now` is the gates' injectable clock; the app passes nothing.
  return buildScoped(client, ctx, centreReadFloor(ctx, options.now));
}

/**
 * Why a caller reads past the data-visibility window. The window is a read
 * restriction for centre-side roles (CLAUDE.md rule 9), and only these may
 * opt out of it — say which at the call site:
 * - `"integrity"` — a writer's own guard that must see the whole history
 *   (a delete blocker, an "in use" count): refusing a delete because of a
 *   record the person cannot see is right; allowing it because the record is
 *   old would corrupt history.
 * - `"settlement"` / `"audit"` — the two carve-outs (docs/01 §7): payout
 *   records and the audit trail stay readable whatever their age.
 */
export type VisibilityWindowOptOut = "integrity" | "settlement" | "audit";

/**
 * `scoped(ctx)` without the data-visibility window (SEC-62) — the one named
 * opt-out. Every other read goes through `scoped(ctx)`, which injects the
 * window floor beside `centerId`.
 */
export function scopedIgnoringVisibilityWindow(
  ctx: ScopeContext,
  // Documents the call site; the behaviour is the same for every reason.
  _reason: VisibilityWindowOptOut,
  client: PrismaClient = sharedClient,
) {
  return buildScoped(client, ctx, null);
}

function buildScoped(prisma: PrismaClient, ctx: ScopeContext, visibilityFloor: Date | null) {
  const centerId = ctx.center.id;
  // SEC-62 — the M19 data-visibility window (docs/01 §7), injected here
  // beside `centerId` into every session, attendee, attendance-change,
  // payment and expense read (and `refunds.list`): a direct URL or API call
  // cannot reach past it. `null` for a platform admin, for a TEACHER/
  // STUDENT/PARENT context (never windowed) and for the opt-out above.
  // Sessions/Analytics/Expenses still clamp their own date filter too, so a
  // range that starts before the floor reads as starting at it.
  const sessionInWindow = (where?: Prisma.SessionWhereInput): Prisma.SessionWhereInput | undefined =>
    visibilityFloor ? { AND: [where ?? {}, { date: { gte: visibilityFloor } }] } : where;
  const throughSession = visibilityFloor ? { session: { date: { gte: visibilityFloor } } } : null;
  const attendeeInWindow = (where?: Prisma.SessionAttendeeWhereInput): Prisma.SessionAttendeeWhereInput | undefined =>
    throughSession ? { AND: [where ?? {}, throughSession] } : where;
  const changeInWindow = (
    where?: Prisma.SessionAttendanceChangeWhereInput,
  ): Prisma.SessionAttendanceChangeWhereInput | undefined =>
    throughSession ? { AND: [where ?? {}, throughSession] } : where;
  const paymentInWindow = (where?: Prisma.PaymentWhereInput): Prisma.PaymentWhereInput | undefined =>
    throughSession ? { AND: [where ?? {}, throughSession] } : where;
  const expenseInWindow = (where?: Prisma.ExpenseWhereInput): Prisma.ExpenseWhereInput | undefined =>
    visibilityFloor ? { AND: [where ?? {}, { date: { gte: visibilityFloor } }] } : where;
  // The account's own remembered locale — the best signal available inside a
  // scoped-only helper for resolving a catalog entry's bilingual name into
  // the flat `.name` shape every existing list/select-option consumer
  // already expects (M13, docs/01-data-model.md "Academic catalog layer").
  const locale = ctx.user.locale ?? "ar";

  return {
    centerId,

    /** The window floor this object applies (SEC-62) — `null` when unbounded. */
    visibilityFloor,

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

      /**
       * F4 — the students whose own account grade is set and differs from the
       * grade this branch has on file (the "Grade differs from account" chip).
       * A raw join because Prisma cannot compare a column to another table's;
       * `centerId` is bound in the statement itself, so it can only ever name
       * this branch's profiles.
       */
      idsGradeDiffersFromAccount: async (): Promise<string[]> => {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT sp."id" FROM "StudentProfile" sp
          JOIN "User" u ON u."id" = sp."userId"
          WHERE sp."centerId" = ${centerId}
            AND u."gradeId" IS NOT NULL
            AND (sp."gradeId" IS NULL OR sp."gradeId" <> u."gradeId")`;
        return rows.map((row) => row.id);
      },

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
    },

    /**
     * F4 — this branch's bulk grade promotions (reads). The writes are
     * `lib/db/promotion.ts`'s `confirmGradePromotion` / `undoGradePromotion`,
     * which take this same `centerId` and run in one transaction; the old
     * one-click `promoteGrade` that lived here is gone.
     */
    gradePromotions: {
      recent: (take = 10) =>
        prisma.gradePromotionBatch.findMany({
          where: scopedWhere(centerId),
          orderBy: { createdAt: "desc" },
          take,
          include: {
            _count: { select: { items: true } },
            fromGrade: { include: { selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 } } },
            toGrade: { include: { selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 } } },
          },
        }),

      /** The one batch an Undo may touch: the latest not yet undone. */
      latestOpen: () =>
        prisma.gradePromotionBatch.findFirst({
          where: scopedWhere(centerId, { undoneAt: null }),
          orderBy: { createdAt: "desc" },
          include: {
            _count: { select: { items: true } },
            fromGrade: { include: { selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 } } },
            toGrade: { include: { selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 } } },
          },
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
        prisma.sessionAttendee.count({ where: scopedWhere(centerId, attendeeInWindow(where)) }),

      findById: (id: string) =>
        prisma.sessionAttendee.findFirst({ where: scopedWhere(centerId, attendeeInWindow({ id })) }),

      /** The full row a session-detail action needs to check/audit against. */
      findDetailById: (id: string) =>
        prisma.sessionAttendee.findFirst({
          where: scopedWhere(centerId, attendeeInWindow({ id })),
          include: {
            studentProfile: { include: { user: true } },
            payments: { orderBy: { recordedAt: "desc" } },
          },
        }),

      /** Existing roster row for (session, student) — null if never marked. */
      findExisting: (sessionId: string, studentProfileId: string) =>
        prisma.sessionAttendee.findFirst({
          where: scopedWhere(centerId, attendeeInWindow({ sessionId, studentProfileId })),
        }),

      /**
       * "Absent N times in a row" for one class (M5/M10) — counted back only
       * as far as the window floor (SEC-62), so an absence older than what
       * this role may read is never revealed as a count either.
       */
      absenceStreak: (classGroupId: string, studentProfileId: string, uptoDate: Date) =>
        consecutiveAbsenceCount(prisma, centerId, classGroupId, studentProfileId, uptoDate, visibilityFloor),
    },

    /**
     * Live-session attendance status changes (R2) — read-only here; the only
     * writer is `lib/db/attendance.ts`'s `changeAttendanceStatus`, inside the
     * same transaction as the change (and any void) it records.
     */
    attendanceChanges: {
      count: (where?: Prisma.SessionAttendanceChangeWhereInput) =>
        prisma.sessionAttendanceChange.count({ where: scopedWhere(centerId, changeInWindow(where)) }),

      findById: (id: string) =>
        prisma.sessionAttendanceChange.findFirst({ where: scopedWhere(centerId, changeInWindow({ id })) }),

      /** The receipt's "Changes during session" rows, oldest first, names resolved. */
      listForSession: async (sessionId: string) => {
        // SEC-62: a session before the window has no readable change log.
        if (visibilityFloor) {
          const visible = await prisma.session.count({ where: scopedWhere(centerId, sessionInWindow({ id: sessionId })) });
          if (visible === 0) return [];
        }
        return listSessionAttendanceChanges(prisma, centerId, sessionId);
      },
    },

    payments: {
      count: (where?: Prisma.PaymentWhereInput) =>
        prisma.payment.count({ where: scopedWhere(centerId, paymentInWindow(where)) }),

      findById: (id: string) =>
        prisma.payment.findFirst({ where: scopedWhere(centerId, paymentInWindow({ id })) }),

      /** The one active (not voided, not refunded) payment on a roster row, if any. */
      findActiveForAttendee: (sessionAttendeeId: string) =>
        prisma.payment.findFirst({
          where: scopedWhere(centerId, paymentInWindow({ sessionAttendeeId, voided: false, refunded: false })),
          select: { id: true },
        }),
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

      /** A single session's settlement, if one was drafted (carved out of the window). */
      findForSession: (sessionId: string) =>
        prisma.settlement.findFirst({ where: scopedWhere(centerId, { sessionId }) }),
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
      /** How many classes use this room as an extra room (a delete blocker). */
      countForRoom: (roomId: string) =>
        prisma.classGroupRoom.count({ where: scopedWhere(centerId, { roomId }) }),

      listForClass: (classGroupId: string) =>
        prisma.classGroupRoom.findMany({
          where: scopedWhere(centerId, { classGroupId }),
          include: { room: true },
          orderBy: { createdAt: "asc" },
        }),
    },

    /** The extra rooms of each session (R3) — reads only, see `roomLinks`. */
    sessionRooms: {
      /** How many sessions use this room as an extra room (a delete blocker — the whole history). */
      countForRoom: (roomId: string) =>
        prisma.sessionRoom.count({ where: scopedWhere(centerId, { roomId }) }),

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
        prisma.session.count({ where: scopedWhere(centerId, sessionInWindow(where)) }),

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
          where: scopedWhere(centerId, sessionInWindow(args.where)),
          orderBy: [{ date: "asc" }, { startTime: "asc" }],
          select: sessionListSelect(centerId),
          take: 1000,
        }),

      findById: (id: string) =>
        prisma.session.findFirst({ where: scopedWhere(centerId, sessionInWindow({ id })) }),

      findDetailById: (id: string) =>
        prisma.session.findFirst({
          where: scopedWhere(centerId, sessionInWindow({ id })),
          include: sessionDetailInclude(centerId),
        }),

      /** The plain fields an edit's audit row records as "before" (reschedule, rooms, cut override). */
      findForEdit: (id: string) =>
        prisma.session.findFirst({
          where: scopedWhere(centerId, sessionInWindow({ id })),
          select: {
            classGroupId: true,
            teacherId: true,
            date: true,
            startTime: true,
            endTime: true,
            roomId: true,
            centerShareType: true,
            centerShareValue: true,
            extraRooms: { select: { roomId: true } },
          },
        }),

      /**
       * Today's non-cancelled sessions — the Reception Desk's live rail and
       * the dashboard's today list. R4: a deactivated class's sessions are
       * not on it unless they are closed records (`OPEN_CLASS_SESSION`).
       */
      listForDay: (date: Date) =>
        prisma.session.findMany({
          where: scopedWhere(
            centerId,
            sessionInWindow({
              date,
              status: { not: CANCELLED_STATUS },
              ...OPEN_CLASS_SESSION,
            }),
          ),
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
     * place and — since SEC-2b (D-24) — **never deleted**: a mistaken entry is
     * voided with a reason (`voidExpenseAction`, audited) and re-added, the
     * same "financial changes are audited" spirit as Payment/void
     * (CLAUDE.md rule 7). There is deliberately no `remove` here.
     */
    expenses: {
      count: (where?: Prisma.ExpenseWhereInput) =>
        prisma.expense.count({ where: scopedWhere(centerId, expenseInWindow(where)) }),

      /** The list screen: lean, filtered, ordered and paged. */
      search: (args: {
        where?: Prisma.ExpenseWhereInput;
        take: number;
        skip?: number;
      }) =>
        prisma.expense.findMany({
          where: scopedWhere(centerId, expenseInWindow(args.where)),
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          include: { category: true },
          take: args.take,
          skip: args.skip,
        }),

      findById: (id: string) =>
        prisma.expense.findFirst({ where: scopedWhere(centerId, expenseInWindow({ id })) }),

      create: (data: Omit<Prisma.ExpenseUncheckedCreateInput, "centerId">) =>
        prisma.expense.create({ data: scopedData(centerId, data) }),
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
      /** `take` bounds a queue a flood could grow (SEC-25): the Approvals screen reads one page. */
      list: (where?: Prisma.ChangeRequestWhereInput, options?: { take?: number }) =>
        prisma.changeRequest.findMany({
          where: scopedWhere(centerId, where),
          orderBy: { createdAt: "desc" },
          ...(options?.take ? { take: options.take } : {}),
        }),

      count: (where?: Prisma.ChangeRequestWhereInput) =>
        prisma.changeRequest.count({ where: scopedWhere(centerId, where) }),

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
      /** The Approvals queue's own section: this center's PENDING requests — one page (SEC-25). */
      listPending: (options?: { take?: number }) =>
        prisma.reservation.findMany({
          // R4: a deactivated class's requests wait, unseen, until it is
          // reactivated — `confirmReservation` refuses them meanwhile.
          where: scopedWhere(centerId, { status: PENDING_RESERVATION, classGroup: { active: true } }),
          orderBy: { requestedAt: "asc" },
          ...(options?.take ? { take: options.take } : {}),
          include: {
            // SEC-72: the requester's name only — never a whole `User` row
            // (authId, isPlatformAdmin, contacts) in a server component.
            student: { select: { id: true, firstName: true, lastName: true } },
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
            // SEC-72: the requester's name only — never a whole `User` row
            // (authId, isPlatformAdmin, contacts) in a server component.
            student: { select: { id: true, firstName: true, lastName: true } },
            classGroup: {
              include: {
                subject: { include: { selections: { where: { centerId } } } },
                grade: { include: { selections: { where: { centerId } } } },
              },
            },
          },
        }),

      countPending: () =>
        prisma.reservation.count({
          where: scopedWhere(centerId, { status: PENDING_RESERVATION, classGroup: { active: true } }),
        }),

      findById: (id: string) => scopedFindById(prisma.reservation, centerId, id),
    },
  };
}

export type ScopedDb = ReturnType<typeof buildScoped>;
