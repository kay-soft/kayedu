import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { LinkedBadge } from "@/components/teacher/workspaces/linked-badge";
import {
  AddWorkspaceStudentButton,
  CancelInvitationButton,
  CopyWorkspaceStudentButton,
  InviteAgainButton,
} from "@/components/teacher/workspaces/workspace-student-controls";
import { RevokeShareCodeButton, ShareCodeButton } from "@/components/teacher/workspaces/workspace-share-code-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSection } from "@/components/shared/page-section";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { catalogLabel } from "@/lib/catalog";
import { listCatalogGrades } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { activeShareCodeExpiries } from "@/lib/db/workspace-share-codes";
import { copyableWorkspaceStudents, listWorkspaceStudents } from "@/lib/db/workspace-students";
import { formatDateTime } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { formatPhone } from "@/lib/phone";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("WorkspaceStudents");
  return { title: t("title") };
}

/**
 * A workspace's Students (W8b, D-W39; docs/04 §11.37). The workspace is
 * resolved for its owner only (`getWorkspaceContext`), and every read is
 * scoped by its `centerId`. Each student is the workspace's own record with
 * **Linked** or **Not linked** — never the account behind it, and never a
 * pending invitation. Add, copy and "Invite again" show only while the
 * workspace takes writes; "Cancel invitation" stays, since it only withdraws.
 * W10 (D-W43): "Share code" joins them on an unlinked profile (writes only),
 * and "Revoke code" shows while one of the teacher's own codes is active —
 * the code's expiry is the teacher's own fact; who redeemed it is never read.
 * Stacked cards at every width (no table to scroll).
 */
export default async function WorkspaceStudentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const [t, locale] = await Promise.all([getTranslations("WorkspaceStudents"), getLocale()]);
  const writable = workspaceOffersWrites(ctx);
  const [students, grades, copyable, activeCodes] = await Promise.all([
    listWorkspaceStudents(prisma, ctx.center.id),
    writable ? listCatalogGrades(prisma) : Promise.resolve([]),
    writable ? copyableWorkspaceStudents(prisma, ctx.user.id, ctx.center.id) : Promise.resolve([]),
    activeShareCodeExpiries(prisma, ctx.center.id),
  ]);
  const dateLocale = locale === "en" ? "en" : "ar";
  const gradeOptions = grades.map((grade) => ({ id: grade.id, label: catalogLabel(locale, grade) }));
  const copyGroups = copyable.map((group) => ({
    workspaceId: group.workspaceId,
    workspaceName: group.workspaceName,
    students: group.students.map((student) => ({
      id: student.id,
      label: `${fullName(student)} · ${formatPhone(student.phone)}`,
    })),
  }));

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        writable ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <AddWorkspaceStudentButton workspaceId={ctx.center.id} grades={gradeOptions} />
            <CopyWorkspaceStudentButton workspaceId={ctx.center.id} groups={copyGroups} />
          </div>
        ) : undefined
      }
    >
      {students.length === 0 ? (
        <EmptyState icon={<Users />} title={t("empty")} description={writable ? t("emptyHint") : undefined} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {students.map((student) => (
            <li key={student.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-text-primary">{fullName(student)}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <span className="tabular-nums">{t("code", { code: student.studentCode })}</span>
                    {student.phone ? (
                      <span dir="ltr" className="tabular-nums">
                        {formatPhone(student.phone)}
                      </span>
                    ) : null}
                    {student.grade ? <span>{catalogLabel(locale, student.grade)}</span> : null}
                    <span>{t("classes", { count: student.activeClasses })}</span>
                  </p>
                </div>
                <LinkedBadge linked={student.linked} />
              </div>
              {!student.linked ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {writable ? (
                    <ShareCodeButton
                      workspaceId={ctx.center.id}
                      studentProfileId={student.id}
                      studentName={fullName(student)}
                      hasActiveCode={activeCodes.has(student.id)}
                    />
                  ) : null}
                  {writable ? <InviteAgainButton workspaceId={ctx.center.id} studentProfileId={student.id} /> : null}
                  <CancelInvitationButton workspaceId={ctx.center.id} studentProfileId={student.id} />
                  {activeCodes.has(student.id) ? (
                    <RevokeShareCodeButton
                      workspaceId={ctx.center.id}
                      studentProfileId={student.id}
                      expiresLabel={formatDateTime(activeCodes.get(student.id)!, dateLocale, DEFAULT_TIMEZONE)}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PageSection>
  );
}
