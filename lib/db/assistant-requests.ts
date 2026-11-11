import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assistants` calls this module
// directly, outside the Next.js runtime.
import { dayMarker } from "../scheduling.ts";
import { assistantMayAt } from "./assistant-acting.ts";
import { writeAuditRow } from "./audit-row.ts";
import { branchPauseRefusal } from "./branch-pauses.ts";
import { withoutAssistantId } from "./request-view.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * Requests an assistant files for the teacher (W7b, D-W37 item 5): the same
 * two the teacher can file — `NEW_SESSION` on one of the teacher's own classes
 * and `NEW_CLASS` — stored **as the teacher's** (`requestedBy` = the teacher)
 * with `viaAssistantUserId` = the assistant. Approving and declining stay with
 * the centre (`/approvals`), unchanged.
 *
 * One transaction: `assistantMayAt(…, "requests.manage")` re-resolves the link,
 * the grant, the branch setting, the teacher's own `changeRequest.create` cell
 * and their trusted flag; a session request's class must be the teacher's own
 * at that branch and its date outside a branch pause (the teacher's rule); the
 * row and its audit row (`changeRequest.create`, actor = the assistant,
 * onBehalfOf = the teacher, ids only — D-20) commit together.
 *
 * The teacher's own request actions are unchanged and write no audit row; this
 * row exists because every assistant write carries both people (rule 14).
 */

export type SessionRequestPayload = { classGroupId: string; date: string; startTime: string; endTime: string; note?: string | null };
export type ClassRequestPayload = {
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
  note?: string | null;
};

export type OnBehalfRequest =
  | { type: "NEW_SESSION"; payload: SessionRequestPayload }
  | { type: "NEW_CLASS"; payload: ClassRequestPayload };

export type OnBehalfRequestResult = { ok: true; id: string } | { ok: false; error: "forbidden" | "notFound" | "branchPaused" };

export async function fileRequestOnBehalf(
  db: PrismaClient,
  input: { assistantUserId: string; teacherUserId: string; centerId: string; request: OnBehalfRequest; now?: Date },
): Promise<OnBehalfRequestResult> {
  const { assistantUserId, teacherUserId, centerId, request } = input;
  const now = input.now ?? new Date();
  return db.$transaction(async (tx): Promise<OnBehalfRequestResult> => {
    if (!(await assistantMayAt(tx, { assistantUserId, teacherUserId, centerId, permission: "requests.manage", now }))) {
      return { ok: false, error: "forbidden" };
    }
    let classGroupId: string | null = null;
    if (request.type === "NEW_SESSION") {
      const classGroup = await tx.classGroup.findFirst({
        where: scopedWhere(centerId, { id: request.payload.classGroupId, teacherId: teacherUserId }),
        select: { id: true },
      });
      if (!classGroup) return { ok: false, error: "notFound" };
      classGroupId = classGroup.id;
      if (await branchPauseRefusal(tx, centerId, { date: dayMarker(request.payload.date), now })) {
        return { ok: false, error: "branchPaused" };
      }
    }
    const created = await tx.changeRequest.create({
      data: scopedData(centerId, {
        type: request.type,
        requestedBy: teacherUserId,
        viaAssistantUserId: assistantUserId,
        payload: request.payload as unknown as Prisma.InputJsonValue,
      }),
      select: { id: true },
    });
    await writeAuditRow(tx, {
      centerId,
      actorUserId: assistantUserId,
      onBehalfOfUserId: teacherUserId,
      action: "changeRequest.create",
      entityType: "ChangeRequest",
      entityId: created.id,
      after: { type: request.type, status: "PENDING", classGroupId },
    });
    return { ok: true, id: created.id };
  }, WRITE_TRANSACTION_OPTIONS);
}

/**
 * The teacher's own requests at one branch, for the assistant's Requests page:
 * both types, newest first, created on or after `floor` (the assistant's
 * window, D-W19). The assistant's id is not returned — only whether it came
 * through an assistant (`viaAssistant`).
 */
export async function listTeacherRequestsAt(
  db: PrismaClient,
  input: { centerId: string; teacherUserId: string; floor: Date },
) {
  const rows = await db.changeRequest.findMany({
    where: scopedWhere(input.centerId, { requestedBy: input.teacherUserId, createdAt: { gte: input.floor } }),
    select: { id: true, type: true, status: true, payload: true, createdAt: true, viaAssistantUserId: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return rows.map(withoutAssistantId);
}
