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

/**
 * Search engines are kept off every page (F5) while the demo override is
 * *set* — `ALLOW_AUTO_CONFIRM_DEMO=yes` means the site is showing seeded demo
 * data, which must not be indexed as if it were real branches and teachers.
 * Keyed on the variable being set, not on `allowAutoConfirmDemo()`, so a
 * demo with email confirmation also on is still kept out of search.
 * Removing it (and so the `noindex`) is on the M20 checklist.
 */
export function noIndexDemo(env: Env = process.env): boolean {
  return env.ALLOW_AUTO_CONFIRM_DEMO === "yes";
}

/** The value the email-change override must be set to, exactly. */
export function unverifiedEmailChangeRequested(env: Env = process.env): boolean {
  return env.ALLOW_UNVERIFIED_EMAIL_CHANGE === "yes";
}

/**
 * The email-change override (F2): `ALLOW_UNVERIFIED_EMAIL_CHANGE=yes` lets a
 * signed-in person change their own email on Account settings **without** a
 * confirmation link — the Supabase admin API sets it, already confirmed —
 * until SMTP exists (M20). Same shape as `allowAutoConfirmDemo`: off by
 * default, and it **never applies when `REQUIRE_EMAIL_CONFIRMATION=true`**
 * (then Supabase's own email-change flow runs, and production refuses to
 * start with both set — `productionAuthProblems`). Removing it is on the M20
 * checklist (docs/03-build-order.md).
 */
export function allowUnverifiedEmailChange(env: Env = process.env): boolean {
  return unverifiedEmailChangeRequested(env) && !requireEmailConfirmation(env);
}

/**
 * How Account settings may change an email (F2):
 * - `confirm` — REQUIRE_EMAIL_CONFIRMATION=true: Supabase mails a link to the
 *   new address; `User.email` changes only once `syncUserFromAuth` sees it
 *   confirmed;
 * - `direct` — ALLOW_UNVERIFIED_EMAIL_CHANGE=yes: set at once, unproven;
 * - `off` — neither: the field is read-only.
 */
export type EmailChangeMode = "confirm" | "direct" | "off";

export function emailChangeMode(env: Env = process.env): EmailChangeMode {
  if (requireEmailConfirmation(env)) return "confirm";
  if (allowUnverifiedEmailChange(env)) return "direct";
  return "off";
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
  // F2: an unproven email change contradicts a deployment that requires
  // proven emails — refuse the combination rather than silently ignore one.
  if (unverifiedEmailChangeRequested(env) && requireEmailConfirmation(env)) {
    return ['ALLOW_UNVERIFIED_EMAIL_CHANGE=yes is set while REQUIRE_EMAIL_CONFIRMATION="true" (unset the override)'];
  }
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
