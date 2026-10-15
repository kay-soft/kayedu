import { headers } from "next/headers";

/**
 * The client's address, for rate-limit keys only (SEC-27) — never for an
 * authorization decision. On Vercel the first `x-forwarded-for` hop is the
 * client; anything else (local dev) shares one "unknown" bucket.
 */
export async function clientIp(): Promise<string> {
  const list = await headers();
  const forwarded = list.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || list.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}
