import type { CatalogGrade, StudentProfile, User } from "@prisma/client";

import type { TenantContext } from "@/lib/auth/tenant";
import { objectAsDataUri, remoteImageAsDataUri } from "@/lib/db/storage";
import { fullName, localName } from "@/lib/identity";
import {
  renderIdCardSvg,
  resolveCardLayout,
  studentQrPayload,
} from "@/lib/id-card";
import { AVATARS_BUCKET } from "@/lib/storage-paths";
import { catalogLabelWithSelection } from "@/lib/catalog";

export type CardStudent = StudentProfile & {
  user: User;
  grade: (CatalogGrade & { selections?: { displayName: string | null }[] }) | null;
};

/**
 * Builds one student's ID card (docs/04 §5, docs/02 §10).
 *
 * The preview, the print view and the file stored in Supabase Storage all call
 * this, so a center prints exactly what it previewed. Images are inlined here —
 * a stored card must not depend on a signed URL that expires.
 */
export async function studentCardSvg(
  ctx: TenantContext,
  student: CardStudent,
  options: { dir: "rtl" | "ltr"; codeLabel: string },
): Promise<string> {
  const centerId = ctx.center.id;

  // A card must still render when Storage is unreachable or unconfigured: the
  // logo falls back to the center's initial and the photo to the student's.
  // assertPathInCenter inside objectAsDataUri refuses a path that somehow
  // points at another center, rather than rendering it onto a card.
  const [logoDataUri, photoDataUri] = await Promise.all([
    ctx.center.logoUrl
      ? remoteImageAsDataUri(ctx.center.logoUrl).catch(() => null)
      : null,
    student.photoUrl
      ? objectAsDataUri(centerId, AVATARS_BUCKET, student.photoUrl).catch(
          () => null,
        )
      : null,
  ]);

  return renderIdCardSvg({
    centerName: ctx.center.name,
    brandColor: ctx.center.themeColor,
    logoDataUri,
    photoDataUri,
    studentName: fullName(localName(student, student.user)),
    gradeName: catalogLabelWithSelection(options.dir === "rtl" ? "ar" : "en", student.grade),
    studentCode: student.studentCode,
    qrPayload: studentQrPayload(centerId, student.studentCode),
    labels: { code: options.codeLabel },
    dir: options.dir,
    layout: resolveCardLayout(ctx.settings?.cardLayout ?? null),
  });
}
