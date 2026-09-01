import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { routing } from "@/lib/i18n/routing";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";

const handleI18n = createMiddleware(routing);

/**
 * Runs on every page request: resolve the locale first, then refresh the
 * Supabase session onto that same response so its rewrite/redirect survives.
 */
export async function proxy(request: NextRequest) {
  const response = handleI18n(request);
  return refreshSupabaseSession(request, response);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
