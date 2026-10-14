/**
 * Shared throwaway fixtures for the A10 (concurrency & integrity) repros.
 * Not a repro itself. Every row it creates is under a Center with slug prefix
 * `secrepro-a10-` (and its own Organization) or a User with email prefix
 * `secrepro-a10-`; `cleanupA10` deletes exactly those (AuditLog rows written
 * against those centres first, since AuditLog.centerId is ON DELETE SET NULL).
 */
import { PrismaClient } from "@prisma/client";
import { DEFAULT_TIMEZONE, todayInTimezone } from "../../lib/scheduling.ts";

export const SLUG_PREFIX = "secrepro-a10-";
export const EMAIL_PREFIX = "secrepro-a10-";

export async function cleanupA10(prisma: PrismaClient): Promise<void> {
  const centers = await prisma.center.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, organizationId: true },
  });
  const centerIds = centers.map((c) => c.id);
  const orgIds = [...new Set(centers.map((c) => c.organizationId))];
  if (centerIds.length) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: centerIds } } });
    // Settlement.teacherId / Session.teacherId are RESTRICT on User, so the
    // centres (which cascade their sessions/settlements/payments) go first.
    await prisma.center.deleteMany({ where: { id: { in: centerIds } } });
  }
  if (orgIds.length) {
    await prisma.organization.deleteMany({
      where: { id: { in: orgIds }, centers: { none: {} } },
    });
  }
  await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: EMAIL_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

export async function makeCenter(prisma: PrismaClient, tag: string) {
  const center = await prisma.center.create({
    data: {
      slug: `${SLUG_PREFIX}${tag}`,
      name: `SecRepro A10 ${tag}`,
      organization: { create: { name: `SecRepro A10 ${tag}` } },
    },
  });
  const method = await prisma.centerPaymentMethod.create({
    data: { centerId: center.id, name: "Cash" },
  });
  const teacher = await prisma.user.create({
    data: {
      firstName: "T",
      lastName: tag,
      email: `${EMAIL_PREFIX}${tag}-teacher@kayedu.test`,
      locale: "en",
    },
  });
  await prisma.membership.create({
    data: {
      centerId: center.id,
      userId: teacher.id,
      role: "TEACHER",
      firstName: "T",
      lastName: tag,
      joinedAt: new Date(),
    },
  });
  return { center, method, teacher };
}

export async function makeStudent(prisma: PrismaClient, centerId: string, tag: string, i: number) {
  const user = await prisma.user.create({
    data: {
      firstName: "S",
      lastName: `${tag}-${i}`,
      email: `${EMAIL_PREFIX}${tag}-s${i}@kayedu.test`,
      locale: "en",
    },
  });
  const profile = await prisma.studentProfile.create({
    data: { centerId, userId: user.id, studentCode: `A10${i}`, firstName: "S", lastName: `${tag}-${i}` },
  });
  return { user, profile };
}

/**
 * A one-time (R5) session dated TODAY in the centre's (default) timezone and
 * spanning the whole day, so the R2 closure guard treats it as open — the
 * real, non-backfill write path runs. Its own cut is 20 % to the centre.
 */
export async function makeOpenSessionToday(
  prisma: PrismaClient,
  centerId: string,
  teacherId: string,
  price = 10_000,
) {
  return prisma.session.create({
    data: {
      centerId,
      teacherId,
      isManual: true,
      title: "A10 repro",
      date: todayInTimezone(DEFAULT_TIMEZONE, new Date()),
      startTime: "00:00",
      endTime: "23:59",
      priceSnapshot: price,
      centerShareType: "PERCENTAGE",
      centerShareValue: 20,
    },
  });
}
