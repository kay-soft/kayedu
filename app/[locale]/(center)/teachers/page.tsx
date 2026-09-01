import { getTranslations } from "next-intl/server";

import { TeacherForm } from "@/app/[locale]/(center)/teachers/teacher-form";
import {
  TeacherRow,
  type TeacherRowData,
} from "@/app/[locale]/(center)/teachers/teacher-row";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { fullName } from "@/lib/identity";

/**
 * Teachers (spec §4.1 item 2). A teacher here is a Membership with role
 * TEACHER — the person is a global User who may teach at several centers, and
 * only this center's relationship is managed on this screen.
 */
export default async function TeachersPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "teacher.manage");

  const db = scoped(ctx);
  const t = await getTranslations("Teachers");
  const tCommon = await getTranslations("Settings.common");

  const [teachers, blocks] = await Promise.all([
    db.teachers.list(),
    db.studentBlocks.list({ scope: "TEACHER" }),
  ]);

  const blocksByTeacher = new Map<string, number>();
  for (const block of blocks) {
    blocksByTeacher.set(block.refId, (blocksByTeacher.get(block.refId) ?? 0) + 1);
  }

  const rows: TeacherRowData[] = teachers.map((teacher) => ({
    membershipId: teacher.id,
    name: fullName(teacher.user),
    email: teacher.user.email,
    phone: teacher.user.phone,
    active: teacher.active,
    canSeeEarnings: teacher.canSeeEarnings,
    blockCount: blocksByTeacher.get(teacher.userId) ?? 0,
  }));

  const canManage = ctxCan(ctx, "teacher.manage");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <TeacherForm teacherCount={teachers.length} />

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="min-w-0 flex-1">{t("columns.name")}</span>
                <span className="min-w-0 flex-1">{t("columns.contact")}</span>
                <span className="min-w-0 flex-1">{t("columns.blocked")}</span>
                <span className="w-24 shrink-0">{tCommon("status")}</span>
                <span className="w-44 shrink-0 text-end">
                  {tCommon("actions")}
                </span>
              </li>

              {rows.map((teacher) => (
                <TeacherRow
                  key={teacher.membershipId}
                  teacher={teacher}
                  canManage={canManage}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
