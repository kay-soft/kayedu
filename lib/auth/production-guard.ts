// Relative imports: `npm run check:security` runs this outside Next.
import {
  AuthMisconfiguredError,
  isProductionDeployment,
  productionAuthProblems,
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
  if (!isProductionDeployment(env)) return;
  const problems = productionAuthProblems(env, await fetchSupabaseAuthSettings(env));
  if (problems.length > 0) throw new AuthMisconfiguredError(problems.join("; "));
}
