import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { IdCardPreview } from "@/components/center/id-card-preview";
import { PrintToolbar } from "@/components/center/print-toolbar";
import { DetailRow } from "@/components/shared/field";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { studentCardSvg } from "@/lib/db/id-cards";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

/**
 * "Print as paper" (spec §4.1 item 4) — the student's record on A4, for the
 * paper file a center still keeps: registration details, parent contacts, and
 * the same card artwork so the sheet and the card cannot disagree.
 */
export default async function StudentPaperPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "student.manage");

  const { id } = await params;
  const db = scoped(ctx);
  const student = await db.students.findDetailById(id);
  if (!student) notFound();

  const locale = await getLocale();
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");

  const enrollments = await db.enrollments.listForStudent(student.id);
  const svg = await studentCardSvg(ctx, student, {
    dir: locale === "ar" ? "rtl" : "ltr",
    codeLabel: t("card.codeLabel"),
  });

  return (
    <>
      <style>{`@page { size: A4; margin: 14mm; }`}</style>

      <PrintToolbar
        backHref={ROUTES.centerStudent(student.id)}
        title={fullName(student.user)}
      />

      <div className="mx-auto w-full max-w-3xl p-4 sm:p-8 print:max-w-none print:p-0">
        <header className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{ctx.center.name}</p>
            <h2 className="text-xl font-bold text-text-primary">
              {fullName(student.user)}
            </h2>
            <p className="mt-1 text-sm text-text-secondary" dir="ltr">
              {student.studentCode}
            </p>
          </div>
          <p className="text-xs text-text-muted">
            {t("print.printedOn", { date: formatDate(new Date(), locale) })}
          </p>
        </header>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <section>
            <h3 className="text-sm font-semibold text-text-primary">
              {t("profileTitle")}
            </h3>
            <div className="mt-2">
              <DetailRow
                label={t("fields.grade")}
                value={student.grade?.name ?? tCommon("none")}
              />
              <DetailRow
                label={t("fields.phone")}
                value={student.user.phone}
                ltr
              />
              <DetailRow
                label={t("fields.email")}
                value={student.user.email}
                ltr
              />
              <DetailRow
                label={tCommon("status")}
                value={student.active ? tCommon("active") : tCommon("inactive")}
              />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-text-primary">
              {t("parentTitle")}
            </h3>
            <div className="mt-2">
              <DetailRow
                label={t("fields.parentName")}
                value={[student.parentFirstName, student.parentLastName]
                  .filter(Boolean)
                  .join(" ")}
              />
              <DetailRow
                label={t("fields.parentPhone")}
                value={student.parentPhone}
                ltr
              />
              <DetailRow
                label={t("fields.parentAltPhone")}
                value={student.parentAltPhone}
                ltr
              />
            </div>
          </section>
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-text-primary">
            {t("enrollments.title")}
          </h3>
          {enrollments.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              {t("enrollments.emptyPrint")}
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {enrollments.map((enrollment) => (
                <li
                  key={enrollment.id}
                  className="flex flex-wrap gap-x-3 border-b border-border-subtle py-2 text-sm last:border-0"
                >
                  <span className="font-medium text-text-primary">
                    {enrollment.classGroup.subject?.name ?? tCommon("none")}
                  </span>
                  <span className="text-text-secondary">
                    {fullName(enrollment.classGroup.teacher)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 break-inside-avoid">
          <h3 className="text-sm font-semibold text-text-primary">
            {t("card.title")}
          </h3>
          <div className="mt-2">
            <IdCardPreview svg={svg} />
          </div>
        </section>
      </div>
    </>
  );
}
