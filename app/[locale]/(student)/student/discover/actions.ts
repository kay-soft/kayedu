"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/lib/auth/request-ip";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { reserveOrEnroll } from "@/lib/db/reservations";
import { formatDate } from "@/lib/format";
import { checkRateLimits } from "@/lib/rate-limit";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  reserveClassSchema,
  type StudentActionState,
} from "@/lib/validation/student";

const FORBIDDEN: StudentActionState = { error: "forbidden" };

/**
 * The Discover action (spec §5 "Reservations / enrollment", docs/04 §10).
 * Never trusts the client-sent `centerId` on its own — `reserveOrEnroll`
 * re-derives the class from the database via `scopedWhere(centerId, { id })`,
 * so a mismatched pair simply resolves to "not found" rather than acting on
 * the wrong center's row (the same discipline `lib/db/tenant-scope.ts`
 * enforces everywhere else, applied to a write that has no single "active
 * center" to fall back on).
 */
export async function reserveClassAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = reserveClassSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: Object.values(fieldErrorsFrom(parsed.error))[0] ?? "notFound" };
  }
  const { locale, centerId, classGroupId } = parsed.data;

  // D-18 (SEC-26): per account and per client IP, in the shared store; the
  // per-account caps on what is held live in `reserveOrEnroll` itself.
  const allowed = await checkRateLimits([
    { name: "selfServicePerUser", key: user.id },
    { name: "selfServicePerIp", key: await clientIp() },
  ]);
  if (!allowed) return { error: "rateLimited" };

  const result = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId, studentUserId: user.id }),
  );

  if (!result.ok) {
    // A rejected student cannot re-request the same class for 7 days (M15) —
    // the UI must say so explicitly, not just refuse silently.
    if (result.error === "coolingOff") {
      return { error: result.error, errorDate: formatDate(result.cooldownUntil, locale) };
    }
    return { error: result.error };
  }

  revalidatePath(`/${locale}${ROUTES.studentDiscover}`);
  revalidatePath(`/${locale}${ROUTES.studentReservations}`);
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);

  return { status: result.kind === "enrolled" ? "enrolled" : "pending" };
}
