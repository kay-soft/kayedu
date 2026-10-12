"use server";

import { z } from "zod";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { resolveRoomSet } from "@/lib/db/room-sets";
import {
  describeConflicts,
  loadClassSlotPlan,
  loadSessionOccupancy,
  weeklySlotConflicts,
} from "@/lib/db/slot-conflicts";
import { scopedWhere } from "@/lib/db/tenant-scope";
import { effectiveRoomIds } from "@/lib/rooms";
import {
  dateKey,
  findSessionConflicts,
  isValidTime,
  isValidTimeRange,
  type ScheduleConflict,
  type SlotConflictInfo,
} from "@/lib/scheduling";

/**
 * `checkSlotConflictsAction` (R3, docs/02 §11) — the **read-only, advisory**
 * live preview the class and session forms call (debounced) while someone
 * edits a slot or a room set. It runs the exact same occupancy loaders and
 * `lib/scheduling.ts` comparison the writes run, gated by the same
 * permission as the write it previews, and never writes anything. It is not
 * the authority: every slot-writing action re-checks on submit and refuses a
 * conflict that was not confirmed, whatever this returned.
 */

const MAX_SHOWN_CONFLICTS = 30;

const id = z.string().trim().min(1).max(64);
const time = z.string().refine(isValidTime);
const roomIds = z.array(id).max(20);

const inputSchema = z.discriminatedUnion("kind", [
  // A new or edited weekly slot of an existing class.
  z.object({
    kind: z.literal("schedule"),
    locale: z.string().max(5),
    classGroupId: id,
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: time,
    endTime: time,
  }),
  // An existing class's teacher and/or room set being changed.
  z.object({
    kind: z.literal("class"),
    locale: z.string().max(5),
    classGroupId: id,
    teacherId: id,
    roomId: id.nullable(),
    extraRoomIds: roomIds,
  }),
  // One session's reschedule target and/or room set.
  z.object({
    kind: z.literal("session"),
    locale: z.string().max(5),
    sessionId: id,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    roomId: id.nullable(),
    extraRoomIds: roomIds,
  }),
]);

export type SlotConflictCheckInput = z.input<typeof inputSchema>;

export type SlotConflictCheckResult = {
  conflicts: SlotConflictInfo[];
  policy: "WARN" | "DENY";
};

const NONE: SlotConflictCheckResult = { conflicts: [], policy: "WARN" };

export async function checkSlotConflictsAction(
  input: SlotConflictCheckInput,
): Promise<SlotConflictCheckResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return NONE;
  const value = parsed.data;

  const ctx = await getTenantContext("center");
  const permission = value.kind === "session" ? "session.manage" : "class.manage";
  if (!ctxCan(ctx, permission)) return NONE;

  const centerId = ctx.center.id;
  const locale = value.locale;
  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  let conflicts: ScheduleConflict[] = [];

  if (value.kind === "schedule") {
    if (!isValidTimeRange(value.startTime, value.endTime)) return { ...NONE, policy };
    const plan = await loadClassSlotPlan(prisma, centerId, value.classGroupId);
    if (!plan) return { ...NONE, policy };
    conflicts = await weeklySlotConflicts(prisma, centerId, locale, value.classGroupId, {
      ...plan,
      slots: [{ dayOfWeek: value.dayOfWeek, startTime: value.startTime, endTime: value.endTime }],
    });
  } else if (value.kind === "class") {
    const plan = await loadClassSlotPlan(prisma, centerId, value.classGroupId);
    // An invalid combination is the form's own field error, not a conflict.
    const rooms = await resolveRoomSet(prisma, centerId, value.roomId, value.extraRoomIds);
    if (!plan || !rooms.ok) return { ...NONE, policy };
    conflicts = await weeklySlotConflicts(prisma, centerId, locale, value.classGroupId, {
      ...plan,
      teacherId: value.teacherId,
      roomId: value.roomId,
      roomIds: rooms.set.roomIds,
    });
  } else {
    const session = await prisma.session.findFirst({
      where: scopedWhere(centerId, { id: value.sessionId }),
      select: { classGroupId: true, teacherId: true, date: true, startTime: true, endTime: true },
    });
    if (!session) return { ...NONE, policy };
    const date = value.date ? new Date(`${value.date}T00:00:00.000Z`) : session.date;
    const startTime = value.startTime ?? session.startTime;
    const endTime = value.endTime ?? session.endTime;
    if (!isValidTimeRange(startTime, endTime)) return { ...NONE, policy };
    const existing = await loadSessionOccupancy(prisma, centerId, locale, date, date);
    conflicts = findSessionConflicts(
      {
        classGroupId: session.classGroupId,
        teacherId: session.teacherId,
        roomId: value.roomId,
        roomIds: effectiveRoomIds(value.roomId, value.extraRoomIds),
        date,
        startTime,
        endTime,
      },
      existing,
    ).map((conflict) => ({ ...conflict, date: dateKey(date) }));
  }

  return {
    conflicts: await describeConflicts(prisma, centerId, conflicts.slice(0, MAX_SHOWN_CONFLICTS)),
    policy,
  };
}
