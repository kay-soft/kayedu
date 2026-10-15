/**
 * Server start-up hook (Next.js instrumentation). One job today: the SEC-2a
 * production auth guard — a production deployment refuses to start when
 * Supabase auto-confirms sign-ups or REQUIRE_EMAIL_CONFIRMATION is not "true"
 * (lib/auth/production-guard.ts). A no-op everywhere else.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { enforceProductionAuthSettings } = await import("./lib/auth/production-guard");
  await enforceProductionAuthSettings();
}
