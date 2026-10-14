import { PrismaClient } from "@prisma/client";

// Prisma singleton — Next.js dev hot-reload would otherwise open a new pool
// on every module reload and exhaust Supabase connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
    // SEC-75 (SEC-2c): in production an error message carries no call-site
    // context — the default format quotes the failed call's arguments (a
    // student's name, a phone) into the message, and from there into the
    // server log. The error code, model and constraint still come through.
    ...(process.env.NODE_ENV === "production" ? { errorFormat: "minimal" as const } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
