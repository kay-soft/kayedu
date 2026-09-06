import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { IdCardPreview } from "@/components/center/id-card-preview";
import { PrintToolbar } from "@/components/center/print-toolbar";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { studentCardSvg } from "@/lib/db/id-cards";
import { scoped } from "@/lib/db/scoped";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

/**
 * "Print as ID card" (spec §4.1 item 4).
 *
 * The card is the exact SVG `renderIdCardSvg()` produces, at true credit-card
 * size (85.6 × 54 mm) — the same bytes the preview shows and the same ones
 * stored in `id-cards/{centerId}/…`.
 */
export default async function StudentCardPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "student.manage");

  const { id } = await params;
  const student = await scoped(ctx).students.findDetailById(id);
  if (!student) notFound();

  const locale = await getLocale();
  const t = await getTranslations("Students");

  const svg = await studentCardSvg(ctx, student, {
    dir: locale === "ar" ? "rtl" : "ltr",
    codeLabel: t("card.codeLabel"),
  });

  return (
    <>
      {/* A card prints on card stock, edge to edge — no page margins. */}
      <style>{`@page { size: 85.6mm 54mm; margin: 0; }`}</style>

      <PrintToolbar
        backHref={ROUTES.centerStudent(student.id)}
        title={fullName(localName(student, student.user))}
      />

      <div className="flex justify-center p-4 sm:p-8 print:p-0">
        <IdCardPreview svg={svg} className="print:w-[85.6mm] print:max-w-none" />
      </div>
    </>
  );
}
