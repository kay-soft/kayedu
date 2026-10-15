import type { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseCookieOptions, supabaseEnv } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase auth session and writes any rotated cookies onto the
 * response the i18n proxy already produced (so its rewrite/redirect survives).
 *
 * No-ops when Supabase env is absent so the app still boots locally.
 */
export async function refreshSupabaseSession(
  request: NextRequest,
  response: NextResponse,
): Promise<NextResponse> {
  const env = supabaseEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what triggers the token refresh.
  await supabase.auth.getUser();

  return response;
}
