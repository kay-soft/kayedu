/**
 * Supabase env accessors. Kept in one place so a missing key fails loudly in
 * app code, but silently (no crash) in the proxy, where auth refresh is a
 * best-effort concern.
 */
export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function requireSupabaseEnv() {
  const env = supabaseEnv();
  if (!env) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
    );
  }
  return env;
}

/**
 * The Supabase auth cookies' attributes (SEC-33). The refresh token lives in
 * these cookies for up to 400 days, and nothing in the browser reads them —
 * auth runs on the server only (there is no browser Supabase client) — so
 * they are httpOnly, Secure outside local development, and SameSite=Lax.
 */
export function supabaseCookieOptions() {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  };
}
