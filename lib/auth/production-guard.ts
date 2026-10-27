// Relative imports: `npm run check:security` runs this outside Next.
import {
  AuthMisconfiguredError,
  allowAutoConfirmDemo,
  allowUnverifiedEmailChange,
  isProductionDeployment,
  productionAuthProblems,
  requireEmailConfirmation,
  unverifiedEmailChangeRequested,
} from "./auth-config.ts";

type Env = Record<string, string | undefined>;

/** GoTrue's public settings (the anon key is enough; read-only). */
export async function fetchSupabaseAuthSettings(
  env: Env = process.env,
): Promise<{ mailer_autoconfirm?: unknown } | null> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as { mailer_autoconfirm?: unknown };
  } catch {
    return null;
  }
}

/**
 * The production startup check (SEC-2a, D-01): in production, refuse to
 * serve unless `REQUIRE_EMAIL_CONFIRMATION=true` **and** the Supabase project
 * does not auto-confirm sign-ups. Called from `instrumentation.ts` at server
 * start — a throw there fails the deployment loudly instead of letting it run
 * with an email check that proves nothing. Outside production it does nothing
 * (Confirm email stays off on dev until a domain exists).
 */
export async function enforceProductionAuthSettings(env: Env = process.env): Promise<void> {
  // F2: loud wherever it is on (not only production) — an email change on
  // this deployment proves nothing about the new address.
  if (allowUnverifiedEmailChange(env)) {
    console.warn(
      "\n!!! KayEdu: ALLOW_UNVERIFIED_EMAIL_CHANGE=yes — Account settings change emails WITHOUT a confirmation " +
        "link (admin API, marked confirmed). DEMO ONLY until SMTP exists: remove it before a real centre (M20). !!!\n",
    );
  }
  if (!isProductionDeployment(env)) return;
  if (unverifiedEmailChangeRequested(env) && requireEmailConfirmation(env)) {
    throw new AuthMisconfiguredError(productionAuthProblems(env, null)[0]);
  }
  if (allowAutoConfirmDemo(env)) {
    console.warn(
      "\n!!! KayEdu: ALLOW_AUTO_CONFIRM_DEMO=yes — the production email-confirmation guard is OFF. " +
        "Sign-ups are not email-verified. DEMO ONLY: never serve a real centre like this (remove the override, " +
        "turn on Supabase Confirm email and set REQUIRE_EMAIL_CONFIRMATION=true). !!!\n",
    );
    return;
  }
  const problems = productionAuthProblems(env, await fetchSupabaseAuthSettings(env));
  if (problems.length > 0) throw new AuthMisconfiguredError(problems.join("; "));
}
