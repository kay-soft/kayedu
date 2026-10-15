import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ROUTES } from "@/lib/routes";

const OTP_TYPES: readonly EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/**
 * Where Supabase's confirmation link lands (SEC-66, SEC-2a). Handles both
 * shapes a link can take — a PKCE `code` (the @supabase/ssr default) and a
 * `token_hash` + `type` (a custom email template) — and then sends the person
 * to the app root, which routes them on: their home, the claim-pending page,
 * or the sign-in form. Nothing here links an account; that is
 * `syncUserFromAuth`'s job on the next request (lib/auth/identity-link.ts).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ locale: string }> },
) {
  // The segment only shapes the redirect; next-intl's own middleware decides
  // what an unknown one means on the next request.
  const { locale: rawLocale } = await params;
  const locale = /^[a-z]{2}$/.test(rawLocale) ? rawLocale : "";
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  const supabase = await createSupabaseServerClient();
  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type && OTP_TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  }

  const prefix = locale ? `/${locale}` : "";
  const target = ok ? prefix || "/" : `${prefix}${ROUTES.login}`;
  return NextResponse.redirect(new URL(target, url.origin));
}
