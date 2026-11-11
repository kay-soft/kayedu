import { cache } from "react";

import { getUserCenterRelations } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { pendingInvitationCenterIds, studentWorkspaceProfiles } from "@/lib/db/workspace-students";
import {
  countUnread,
  hiddenAssessmentNoticeIds,
  syncAssessmentSoonNotices,
  type NotificationReach,
} from "@/lib/db/notifications";

/**
 * What a person reaches right now, for the access re-check every notification
 * read makes (W1, decision 3) — the branches of their relations, resolved by
 * the same per-request `cache()` the shells and the hub already use, so the
 * bell adds no relation query to a page that has one. A person who is not a
 * student anywhere adds no assessment query either (D-W32).
 *
 * W8b (D-W39 item 10): the workspaces the reader studies at through a linked
 * profile — the opt-in student resolver's own input (`studentWorkspaceProfiles`,
 * without building a context per workspace on every bell), reaching the
 * session kinds — and the workspaces with a PENDING invitation to the reader.
 *
 * W9 (D-W42 item 6): those same linked workspaces join the reader's student
 * centres for the **assessment** kinds, so the assessment re-check
 * (`hiddenAssessmentNoticeIds`: published, class active, ACTIVE enrolment)
 * runs there as at a branch. A deactivated profile, or a workspace that is no
 * longer live, drops out of `studentWorkspaceProfiles` and its notices hide.
 */
export async function notificationReach(
  userId: string,
  options: { unreadOnly?: boolean } = {},
): Promise<NotificationReach> {
  const [relations, workspaceProfiles, invitationCenterIds] = await Promise.all([
    getUserCenterRelations(userId),
    studentWorkspaceProfiles(prisma, userId),
    pendingInvitationCenterIds(prisma, userId),
  ]);
  const workspaceCenterIds = workspaceProfiles.map((profile) => profile.centerId);
  const studentCenterIds = [
    ...relations.filter((relation) => relation.studentProfile).map((relation) => relation.center.id),
    ...workspaceCenterIds,
  ];
  return {
    relationCenterIds: relations.map((relation) => relation.center.id),
    studentCenterIds,
    hiddenNoticeIds: await hiddenAssessmentNoticeIds(prisma, userId, studentCenterIds, new Date(), options),
    workspaceCenterIds,
    invitationCenterIds,
  };
}

/**
 * The computed "soon" notices (W3b, D-W32), once per request: called before a
 * read of the bell or the inbox, only for a person with a student profile. Never
 * a job, a timer or a poll (rule 12). W9 (D-W42 item 6): a linked workspace
 * profile counts, through the opt-in resolver's input.
 */
export const ensureSoonNotices = cache(async (userId: string): Promise<void> => {
  const [relations, workspaceProfiles] = await Promise.all([getUserCenterRelations(userId), studentWorkspaceProfiles(prisma, userId)]);
  const studentCenterIds = [
    ...relations.filter((relation) => relation.studentProfile).map((relation) => relation.center.id),
    ...workspaceProfiles.map((profile) => profile.centerId),
  ];
  if (studentCenterIds.length > 0) await syncAssessmentSoonNotices(prisma, userId, studentCenterIds, new Date());
});

/**
 * The bell's unread count — read on every navigation, server-rendered, never
 * polled (D-W12). Cached per request: a shell and a page share one count.
 */
export const unreadNotificationCount = cache(async (userId: string): Promise<number> => {
  await ensureSoonNotices(userId);
  return countUnread(prisma, userId, await notificationReach(userId, { unreadOnly: true }));
});
