/**
 * Auth posture switches (SEC-2a, D-01). Pure — no runtime imports — so the
 * identity layer, the production guard and `npm run check:security` all read
 * the same answer.
 *
 * Supabase *Confirm email* is deliberately OFF on the dev project until a
 * domain exists (docs/00 §2.1-A, §2.2 OD-1). The app never relies on it: an
 * email alone never links an account to a staff-created person (claims,
 * `lib/auth/identity-link.ts`). `REQUIRE_EMAIL_CONFIRMATION=true` adds the
 * second layer production needs — every email-based link must also carry
 * Supabase's `email_confirmed_at`, checked on the server.
 */

type Env = Record<string, string | undefined>;

/** `REQUIRE_EMAIL_CONFIRMATION=true` — default false (dev); must be true in production. */
export function requireEmailConfirmation(env: Env = process.env): boolean {
  return env.REQUIRE_EMAIL_CONFIRMATION === "true";
}

/**
 * The production deployment — Vercel's production environment, or an explicit
 * `KAYEDU_ENV=production` for anything hosted elsewhere. Not `NODE_ENV`: a
 * local `next start` and every preview build also run with NODE_ENV=production.
 */
export function isProductionDeployment(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.KAYEDU_ENV === "production";
}

/**
 * The demo override (DEPLOY-1): `ALLOW_AUTO_CONFIRM_DEMO=yes` lets a production
 * deployment run while Supabase *Confirm email* is OFF — for a demo on seeded
 * data, never for a real centre. Off by default, and it **never applies when
 * `REQUIRE_EMAIL_CONFIRMATION=true`** (then the full guard stands). The account
 * claim flow still stops a sign-up taking over a staff-created person.
 * Removing it is on the M20 checklist (docs/03-build-order.md).
 */
export function allowAutoConfirmDemo(env: Env = process.env): boolean {
  return env.ALLOW_AUTO_CONFIRM_DEMO === "yes" && !requireEmailConfirmation(env);
}

export class AuthMisconfiguredError extends Error {
  constructor(message: string) {
    super(`KayEdu auth is misconfigured for production: ${message}`);
    this.name = "AuthMisconfiguredError";
  }
}

/**
 * The production refusal (D-01): production must require a confirmed email
 * (`REQUIRE_EMAIL_CONFIRMATION=true`) **and** Supabase must not auto-confirm
 * sign-ups. `settings` is GoTrue's public `/auth/v1/settings` body. Pure, so
 * the check script can run it against a simulated auto-confirm project.
 */
export function productionAuthProblems(
  env: Env,
  settings: { mailer_autoconfirm?: unknown } | null,
): string[] {
  if (!isProductionDeployment(env)) return [];
  if (allowAutoConfirmDemo(env)) return [];
  const problems: string[] = [];
  if (!requireEmailConfirmation(env)) {
    problems.push("REQUIRE_EMAIL_CONFIRMATION is not \"true\"");
  }
  if (settings === null) {
    problems.push("the Supabase auth settings could not be read");
  } else if (settings.mailer_autoconfirm !== false) {
    problems.push("Supabase auto-confirms sign-ups (turn on Authentication → Email → Confirm email)");
  }
  return problems;
}
